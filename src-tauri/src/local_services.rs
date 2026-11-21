use crate::store::Result;
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct LocalService {
    title: String,
    url: String,
}

#[cfg(windows)]
pub fn discover(on_service: impl FnMut(LocalService)) -> Result<Vec<LocalService>> {
    windows_listeners::discover(on_service)
}

#[cfg(not(windows))]
pub fn discover(_on_service: impl FnMut(LocalService)) -> Result<Vec<LocalService>> {
    Err("本地服务检测需要 Windows 桌面版".into())
}

#[cfg(windows)]
mod windows_listeners {
    use super::*;
    use reqwest::{blocking::Client, header::{ACCEPT, CONTENT_TYPE}, redirect::Policy};
    use std::{
        collections::HashMap,
        io::Read,
        mem::{offset_of, size_of},
        net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
        sync::{atomic::{AtomicUsize, Ordering}, mpsc, LazyLock, Mutex},
        thread,
        time::{Duration, Instant},
    };
    use windows::Win32::{
        Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
            MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        },
        Networking::WinSock::{AF_INET, AF_INET6, ADDRESS_FAMILY},
    };

    type Listener = (SocketAddr, u32);
    type Checked = (Instant, Option<LocalService>);
    static CHECKED: LazyLock<Mutex<HashMap<Listener, Checked>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub(super) fn discover(on_service: impl FnMut(LocalService)) -> Result<Vec<LocalService>> {
        scan(&listening_endpoints()?, on_service)
    }

    fn scan(endpoints: &[Listener], mut on_service: impl FnMut(LocalService)) -> Result<Vec<LocalService>> {
        let mut services = Vec::new();
        let mut pending = Vec::new();
        {
            let mut checked = CHECKED.lock().map_err(crate::store::error)?;
            checked.retain(|listener, _| endpoints.contains(listener));
            for &listener in endpoints {
                match checked.get(&listener) {
                    Some((at, result)) if at.elapsed() < Duration::from_secs(15) => {
                        if let Some(service) = result {
                            services.push((listener, service.clone()));
                        }
                    }
                    _ => pending.push(listener),
                }
            }
        }
        for (_, service) in &services {
            on_service(service.clone());
        }
        if !pending.is_empty() {
            let client = page_client()?;
            probe_pending(&client, &pending, |listener, result| {
                if let Ok(mut checked) = CHECKED.lock() {
                    checked.insert(listener, (Instant::now(), result.clone()));
                }
                if let Some(service) = result {
                    on_service(service.clone());
                    services.push((listener, service));
                }
            });
        }
        services.sort_unstable_by_key(|((address, _), _)| (address.port(), address.ip()));
        Ok(services.into_iter().map(|(_, service)| service).collect())
    }

    fn probe_pending(client: &Client, pending: &[Listener], mut on_checked: impl FnMut(Listener, Option<LocalService>)) {
        let next = AtomicUsize::new(0);
        let (send, receive) = mpsc::channel();
        thread::scope(|scope| {
            for _ in 0..pending.len().min(12) {
                let next = &next;
                let send = send.clone();
                scope.spawn(move || {
                    while let Some(&listener) = pending.get(next.fetch_add(1, Ordering::Relaxed)) {
                        let _ = send.send((listener, probe(client, listener.0)));
                    }
                });
            }
            drop(send);
            for (listener, result) in receive {
                on_checked(listener, result);
            }
        });
    }

    fn page_client() -> Result<Client> {
        Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(1500))
            .redirect(Policy::custom(|attempt| {
                let next = attempt.url();
                if attempt.previous().len() <= 3
                    && attempt.previous().first().is_some_and(|start| start.origin() == next.origin())
                    && next.username().is_empty() && next.password().is_none()
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(crate::store::error)
    }

    fn listening_endpoints() -> Result<Vec<Listener>> {
        let ipv4 = read_listeners::<MIB_TCPROW_OWNER_PID>(AF_INET, offset_of!(MIB_TCPTABLE_OWNER_PID, table));
        let ipv6 = read_listeners::<MIB_TCP6ROW_OWNER_PID>(AF_INET6, offset_of!(MIB_TCP6TABLE_OWNER_PID, table));
        if let (Err(error), Err(_)) = (&ipv4, &ipv6) {
            return Err(error.clone());
        }
        let mut endpoints: Vec<_> = ipv4.unwrap_or_default().into_iter()
            .filter_map(|row| connect_address(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(), row.dwLocalPort).map(|address| (address, row.dwOwningPid)))
            .chain(ipv6.unwrap_or_default().into_iter()
                .filter_map(|row| connect_address(Ipv6Addr::from(row.ucLocalAddr).into(), row.dwLocalPort).map(|address| (address, row.dwOwningPid))))
            .collect();
        endpoints.sort_unstable_by_key(|(address, pid)| (address.port(), address.ip(), *pid));
        endpoints.dedup_by_key(|(address, _)| *address);
        Ok(endpoints)
    }

    fn read_listeners<Row: Copy>(family: ADDRESS_FAMILY, offset: usize) -> Result<Vec<Row>> {
        let mut size = 0;
        let mut table = Vec::<u32>::new();
        for _ in 0..4 {
            let buffer = (!table.is_empty()).then(|| table.as_mut_ptr().cast());
            // IP Helper fills the aligned buffer and reports a new size if the table has grown.
            let status = unsafe {
                GetExtendedTcpTable(buffer, &mut size, false, family.0.into(), TCP_TABLE_OWNER_PID_LISTENER, 0)
            };
            if status == ERROR_INSUFFICIENT_BUFFER.0 {
                table.resize((size as usize).div_ceil(size_of::<u32>()), 0);
                continue;
            }
            if status != NO_ERROR.0 {
                return Err(format!("无法读取本机监听端口（Windows 错误 {status}）"));
            }
            let count = *table.first().ok_or("本机监听端口数据缺失")? as usize;
            let bytes = (size as usize).min(table.len() * size_of::<u32>());
            if count > bytes.saturating_sub(offset) / size_of::<Row>() {
                return Err("本机监听端口数据不完整".into());
            }
            let start = table.as_ptr().cast::<u8>();
            // The caller supplies the row type and array offset for this address family.
            return Ok((0..count).map(|index| unsafe {
                start.add(offset + index * size_of::<Row>()).cast::<Row>().read_unaligned()
            }).collect());
        }
        Err("本机监听端口正在变化，请稍后重试".into())
    }

    fn connect_address(ip: IpAddr, network_port: u32) -> Option<SocketAddr> {
        let host = match ip {
            IpAddr::V4(ip) if ip.is_unspecified() => Ipv4Addr::LOCALHOST.into(),
            IpAddr::V6(ip) if ip.is_unspecified() => Ipv6Addr::LOCALHOST.into(),
            ip if ip.is_loopback() => ip,
            _ => return None,
        };
        let port = u16::from_be(network_port as u16);
        (port != 0).then(|| SocketAddr::new(host, port))
    }

    fn probe(client: &Client, address: SocketAddr) -> Option<LocalService> {
        let url = url::Url::parse(&format!("http://{address}/")).ok()?;
        let response = client.get(url.clone()).header(ACCEPT, "text/html,*/*;q=0.8").send().ok()?;
        let content_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok())
            .unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !response.status().is_success() || content_type != "text/html" {
            return None;
        }
        let mut body = Vec::new();
        let mut chunk = [0; 8192];
        let mut prefix = response.take(256 * 1024);
        while let Ok(size @ 1..) = prefix.read(&mut chunk) {
            body.extend_from_slice(&chunk[..size]);
            if let Some(title) = page_title(&String::from_utf8_lossy(&body)) {
                return Some(LocalService {title, url: url.to_string()});
            }
        }
        if body.iter().all(u8::is_ascii_whitespace) {
            return None;
        }
        Some(LocalService {title: address.to_string(), url: url.to_string()})
    }

    fn page_title(html: &str) -> Option<String> {
        let lower = html.to_ascii_lowercase();
        let tag = lower.find("<title")? + "<title".len();
        if !lower.as_bytes().get(tag).is_some_and(|byte| *byte == b'>' || byte.is_ascii_whitespace()) {
            return None;
        }
        let start = tag + lower[tag..].find('>')? + 1;
        let end = start + lower[start..].find("</title>")?;
        let title = html[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
        (!title.is_empty()).then(|| title.chars().take(100).collect())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{io::{ErrorKind, Write}, net::TcpListener};

        fn fixture(responses: &[(&str, &str, &str)]) -> Option<LocalService> {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            assert!(listening_endpoints().unwrap().contains(&(address, std::process::id())));
            listener.set_nonblocking(true).unwrap();
            thread::scope(|scope| {
                scope.spawn(move || {
                    for &(status, headers, body) in responses {
                        let deadline = Instant::now() + Duration::from_secs(3);
                        let mut stream = loop {
                            match listener.accept() {
                                Ok((stream, _)) => break stream,
                                Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                                    thread::sleep(Duration::from_millis(10));
                                }
                                Err(error) => panic!("HTTP fixture was not reached: {error}"),
                            }
                        };
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        assert!(stream.read(&mut [0; 1024]).unwrap() > 0);
                        write!(stream, "HTTP/1.1 {status}\r\n{headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                });
                probe(&page_client().unwrap(), address)
            })
        }

        #[test]
        fn discovers_a_web_listener_on_a_dynamic_port_after_a_same_origin_redirect() {
            let service = fixture(&[
                ("302 Found", "Location: /dashboard", ""),
                ("200 OK", "Content-Type: Text/HTML; charset=UTF-8", "<TITLE>Local   dashboard</TITLE>"),
            ]).unwrap();
            assert_eq!(service.title, "Local dashboard");
            assert!(service.url.starts_with("http://127.0.0.1:"));
        }

        #[test]
        fn excludes_error_pages_api_responses_and_redirects_to_another_origin() {
            for response in [
                ("404 Not Found", "Content-Type: text/html", "<title>Error</title>"),
                ("503 Service Unavailable", "Content-Type: text/html", "<title>Unavailable</title>"),
                ("200 OK", "Content-Type: application/json", r#"{"status":"ok"}"#),
                ("200 OK", "Content-Type: text/plain", "ready"),
                ("204 No Content", "Content-Type: text/html", ""),
            ] {
                assert!(fixture(&[response]).is_none(), "{response:?}");
            }
            let other_origin = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            other_origin.set_nonblocking(true).unwrap();
            let redirect = format!("Location: http://{}/", other_origin.local_addr().unwrap());
            assert!(fixture(&[("302 Found", &redirect, "")]).is_none());
            assert_eq!(other_origin.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
        }

        #[test]
        fn publishes_a_ready_page_before_slow_ports_and_reuses_its_verification() {
            let slow = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let fast = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let pid = std::process::id();
            let listeners = [(slow.local_addr().unwrap(), pid), (fast.local_addr().unwrap(), pid)];
            let (published, confirmed) = mpsc::channel();
            thread::scope(|scope| {
                let fast_listener = &fast;
                scope.spawn(move || {
                    let (mut stream, _) = fast_listener.accept().unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    assert!(stream.read(&mut [0; 1024]).unwrap() > 0);
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100000\r\n\r\n<title>Fast page</title>").unwrap();
                    confirmed.recv_timeout(Duration::from_secs(2)).unwrap();
                });
                let started = Instant::now();
                let result = scan(&listeners, |service| {
                    assert_eq!(service.title, "Fast page");
                    assert!(started.elapsed() < Duration::from_secs(1));
                    published.send(()).unwrap();
                }).unwrap();
                assert_eq!(result.len(), 1);
                assert_eq!(scan(&listeners, |_| {}).unwrap()[0].title, "Fast page");
                assert!(scan(&listeners[..1], |_| {}).unwrap().is_empty());
            });
        }

        #[test]
        #[ignore = "read-only timing probe of whichever local HTTP services are running"]
        fn measures_local_discovery() {
            for label in ["cold", "warm"] {
                let started = Instant::now();
                let found = discover(|service| {
                    println!("{label}: {} at {} ms", service.title, started.elapsed().as_millis());
                }).unwrap();
                println!("{label}: {} pages, completed at {} ms", found.len(), started.elapsed().as_millis());
            }
        }
    }
}
