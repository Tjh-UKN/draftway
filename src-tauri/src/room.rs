//! Client for a switchboard room server (`pip install switchboard-room`): a mailbox that Claude Code sessions on
//! several machines share over the LAN. Draftway joins with one stable id per machine (`draftway:<host>`, shown as
//! `draftway@<host>`), lists the sessions in the room, shows the recent thread and sends messages. Claude Code sessions
//! that Draftway starts join through the room hooks when those are installed; Draftway never writes their records.
use crate::store::{error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, io::Read, path::{Path, PathBuf}, time::Duration};
use url::Url;

const FILE: &str = "room-connection.json";
const MAX_RESPONSE: usize = 2_000_000;
const MAX_BODY: usize = 4000;

/// Kept in its own file beside the database, so backups and exports never carry the room token.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Connection {pub url: String, pub token: String, pub host: String}
impl Connection {
    pub fn me(&self) -> String {format!("draftway:{}", self.host)}
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {pub id: String, pub name: String, pub title: String, pub host: String, pub repo: String, pub state: String, pub status: String, pub unread: u64, pub listening: bool, pub draftway_session: Option<String>}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Message {pub id: u64, pub at: u64, pub from: String, pub to: String, pub link: Option<String>, pub kind: String, pub body: String, pub reply_to: Option<u64>, pub mine: bool, pub to_me: bool}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {pub configured: bool, pub url: String, pub host: String, pub me: String, pub sessions: Vec<Session>, pub messages: Vec<Message>, pub links: Vec<String>}
/// A Claude Code session started by Draftway: (Claude session id, Draftway session id, title).
pub type Local = (String, String, String);

pub fn server_url(value: &str) -> Result<String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入协作室服务地址，例如 http://192.168.1.20:8766")?;
    if !["http", "https"].contains(&url.scheme()) || url.host().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !["", "/"].contains(&url.path()) {
        return Err("协作室地址只能是 http(s)://主机:端口，不含路径、账号或参数".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
pub fn host_label(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 40 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || [b'-', b'_', b'.'].contains(&b)) {
        return Err("本机名称只能使用字母、数字和 - _ .，最多 40 个字符".into());
    }
    Ok(value.into())
}
pub fn checked(url: &str, token: &str, host: &str) -> Result<Connection> {
    let token = token.trim();
    if token.is_empty() || token.len() > 200 || token.chars().any(char::is_control) {return Err("请输入协作室令牌".into());}
    Ok(Connection {url: server_url(url)?, token: token.into(), host: host_label(host)?})
}
pub fn load(root: &Path) -> Option<Connection> {
    let saved: Connection = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    checked(&saved.url, &saved.token, &saved.host).ok()
}
pub fn save(root: &Path, connection: &Connection) -> Result<()> {
    let path = root.join(FILE); let temporary = root.join(format!("{FILE}.tmp"));
    std::fs::write(&temporary, serde_json::to_vec_pretty(connection).map_err(error)?).map_err(error)?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(error)?;}
    std::fs::rename(&temporary, path).map_err(error)
}
pub fn forget(root: &Path) -> Result<()> {
    match std::fs::remove_file(root.join(FILE)) {Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(error(e)), _ => Ok(())}
}
/// The settings `room join` writes on macOS and Linux (`~/.config/switchboard/room.json`).
pub fn cli_config_path() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|home| PathBuf::from(home).join(".config/switchboard/room.json"))
}
pub fn import_cli_config(path: &Path) -> Result<Connection> {
    let bytes = std::fs::read(path).map_err(|_| format!("未找到 room 客户端配置：{}", path.display()))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "room 客户端配置不是有效 JSON")?;
    let field = |key: &str| value[key].as_str().unwrap_or_default().to_string();
    let host = Some(field("host")).filter(|host| !host.is_empty()).unwrap_or_else(machine_name);
    checked(&field("url"), &field("token"), &host)
}
pub fn machine_name() -> String {
    let name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().or_else(|| {
        std::process::Command::new("hostname").output().ok().and_then(|out| String::from_utf8(out.stdout).ok())
    }).unwrap_or_default();
    let label: String = name.trim().split('.').next().unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || ['-', '_'].contains(c)).take(40).collect();
    if label.is_empty() {"Draftway".into()} else {label}
}

pub struct Client {http: reqwest::blocking::Client, connection: Connection}
impl Client {
    pub fn new(connection: Connection) -> Result<Self> {
        let http = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(6)).redirect(reqwest::redirect::Policy::none()).build().map_err(error)?;
        Ok(Self {http, connection})
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}{}", self.connection.url, path);
        let request = if method == "POST" {
            self.http.post(url).header(reqwest::header::CONTENT_TYPE, "application/json").body(body.unwrap_or_else(|| json!({})).to_string())
        } else {self.http.get(url)};
        let response = request.bearer_auth(&self.connection.token).send().map_err(|e| format!("无法连接协作室：{}", e.without_url()))?;
        let status = response.status();
        let mut bytes = Vec::new(); response.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut bytes).map_err(error)?;
        if bytes.len() > MAX_RESPONSE {return Err("协作室响应超过 2 MB".into());}
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "协作室未返回有效 JSON，请确认地址指向 room 服务")?;
        if status.as_u16() == 401 {return Err("协作室令牌无效".into());}
        if !status.is_success() {return Err(value["error"].as_str().map(|e| format!("协作室拒绝了请求：{e}")).unwrap_or_else(|| format!("协作室请求失败（{status}）")));}
        Ok(value)
    }
    /// Registers Draftway in the room while its window is open; `leave` marks it ended when the window closes.
    fn announce(&self, ended: bool) -> Result<()> {
        self.call("POST", "/seen", Some(json!({"session":self.connection.me(),"host":self.connection.host,"name":"draftway","ended":ended,"version":concat!("draftway-", env!("CARGO_PKG_VERSION"))}))).map(|_| ())
    }
    pub fn leave(&self) -> Result<()> {self.announce(true)}
    pub fn view(&self, local: &[Local]) -> Result<View> {
        self.announce(false)?;
        let state = self.call("GET", "/state", None)?;
        let me = self.connection.me();
        // Reading the room window counts as reading Draftway's messages, so `room who` stops showing them as unread.
        let _ = self.call("GET", &format!("/inbox?session={}", encode(&me)), None);
        let rows = state["sessions"].as_array().ok_or("协作室会话列表格式不兼容")?;
        let mut view = View {configured: true, url: self.connection.url.clone(), host: self.connection.host.clone(), me: me.clone(), ..Default::default()};
        for row in rows {
            let id = text(row, "id");
            if id.is_empty() || id == me {continue;}
            let mut session = Session {name: text(row, "name"), title: String::new(), host: text(row, "host"), repo: text(row, "repo"), state: text(row, "state"), status: text(row, "status"),
                unread: state["unread"][&id].as_u64().unwrap_or(0), listening: row["polling"].as_array().is_some_and(|p| !p.is_empty()),
                draftway_session: local.iter().find(|(source, ..)| source == &id).map(|(_, draftway, _)| draftway.clone()), id, };
            if session.state == "exited" && session.draftway_session.is_none() {continue;}
            // The room hooks register `claude -p` sessions without a name. Label them with the Draftway title here only:
            // the hooks own those records, and a second writer would make them flap.
            if let Some((.., title)) = local.iter().find(|(source, ..)| source == &session.id) {session.title = title.clone();}
            view.sessions.push(session);
        }
        view.sessions.sort_by(|a, b| (a.state != "live", a.host.to_lowercase(), a.repo.clone(), a.name.clone()).cmp(&(b.state != "live", b.host.to_lowercase(), b.repo.clone(), b.name.clone())));
        let rows = state["messages"].as_array().ok_or("协作室消息格式不兼容")?;
        let mine: HashSet<u64> = rows.iter().filter(|m| m["sender"] == me.as_str()).filter_map(|m| m["id"].as_u64()).collect();
        let addresses = [me.clone(), format!("draftway@{}", self.connection.host), "draftway".into()];
        for row in rows.iter().take(80).rev() {
            let sender = text(row, "sender");
            let from = match (text(row, "sender_name"), text(row, "sender_host")) {(name, host) if !name.is_empty() => format!("{name}@{host}"), _ => sender.chars().take(8).collect()};
            let reply_to = row["reply_to"].as_u64();
            let to = text(row, "to_spec");
            view.messages.push(Message {id: row["id"].as_u64().unwrap_or(0), at: (row["ts"].as_f64().unwrap_or(0.0) * 1000.0) as u64, from, link: row["link"].as_str().map(String::from),
                kind: text(row, "kind"), body: text(row, "body"), mine: sender == me, to_me: sender != me && (addresses.contains(&to) || reply_to.is_some_and(|id| mine.contains(&id))), reply_to, to});
        }
        view.links = state["links"].as_array().map(|links| links.iter().map(|l| text(l, "name")).filter(|n| !n.is_empty()).collect()).unwrap_or_default();
        Ok(view)
    }
    pub fn send(&self, to: &str, body: &str, ask: bool, reply_to: Option<u64>) -> Result<Value> {
        let to = to.trim(); let body = body.trim();
        if to.is_empty() || to.len() > 200 || to.chars().any(char::is_control) {return Err("请选择收件人".into());}
        if body.is_empty() {return Err("消息不能为空".into());}
        if body.chars().count() > MAX_BODY {return Err(format!("消息最多 {MAX_BODY} 个字符"));}
        self.announce(false)?;
        let kind = if reply_to.is_some() {"reply"} else if ask {"ask"} else {"notify"};
        self.call("POST", "/send", Some(json!({"session":self.connection.me(),"to":to,"body":body,"kind":kind,"reply_to":reply_to})))
    }
}
fn text(value: &Value, key: &str) -> String {value[key].as_str().unwrap_or_default().to_string()}
fn encode(value: &str) -> String {url::form_urlencoded::byte_serialize(value.as_bytes()).collect()}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader, Write}, net::TcpListener, sync::{Arc, Mutex}};
    #[test]
    #[ignore = "requires a switchboard room server: ROOM_TEST_URL and ROOM_TEST_TOKEN; registers draftway:DraftwayTest there"]
    fn live_room_server_round_trip() {
        let connection = checked(&std::env::var("ROOM_TEST_URL").unwrap(), &std::env::var("ROOM_TEST_TOKEN").unwrap(), "DraftwayTest").unwrap();
        let client = Client::new(connection).unwrap();
        // What the room hooks of a `claude -p` session started by Draftway send: an id and folder, no name.
        client.call("POST", "/seen", Some(json!({"session":"live-claude-session","host":"DraftwayTest","cwd":"/tmp/project","repo":"project"}))).unwrap();
        let local = [("live-claude-session".to_string(), "draftway-id".to_string(), "整理 发布说明".to_string())];
        let view = client.view(&local).unwrap();
        let session = view.sessions.iter().find(|s| s.id == "live-claude-session").unwrap();
        assert_eq!(session.title, "整理 发布说明"); assert_eq!(session.draftway_session.as_deref(), Some("draftway-id"));
        let sent = client.send("live-claude-session", "进度如何？", true, None).unwrap();
        assert_eq!(sent["recipients"], json!(["live-claude-session"]));
        let id = sent["id"].as_u64().unwrap();
        // The session answers the way `room send --re` does; Draftway sees the reply as addressed to it.
        client.call("POST", "/send", Some(json!({"session":"live-claude-session","to":"draftway@DraftwayTest","body":"完成一半","kind":"reply","reply_to":id}))).unwrap();
        let view = client.view(&local).unwrap();
        let reply = view.messages.iter().find(|m| m.reply_to == Some(id)).unwrap();
        assert!(reply.to_me && !reply.mine); assert_eq!(reply.from, "live-cla");
        assert!(view.messages.iter().any(|m| m.id == id && m.mine && m.kind == "ask"));
        // Visible in `room who` (not a hidden human: id) while the window is open, and ended once it closes.
        let me = |client: &Client| client.call("GET", "/sessions", None).unwrap().as_array().unwrap().iter().find(|s| s["id"] == "draftway:DraftwayTest").cloned().unwrap();
        assert_eq!(me(&client)["state"], "live"); client.leave().unwrap(); assert_eq!(me(&client)["state"], "exited");
    }
    #[test]
    fn addresses_hosts_and_tokens_are_validated_before_saving() {
        assert_eq!(server_url("http://192.168.1.20:8766/").unwrap(), "http://192.168.1.20:8766");
        assert_eq!(server_url(" https://room.example.ts.net ").unwrap(), "https://room.example.ts.net");
        for url in ["ftp://host/", "http://user:pw@host:8766", "http://host:8766/api", "http://host:8766/?token=x", "file:///etc/passwd", "room"] {assert!(server_url(url).is_err(), "{url}");}
        for host in ["", "two words", "a@b", &"x".repeat(41)] {assert!(host_label(host).is_err());}
        assert!(checked("http://h:1", " ", "Mac").is_err());
    }
    #[test]
    fn connection_lives_outside_the_database_and_imports_the_room_cli_config() {
        let root = std::env::temp_dir().join(format!("draftway-room-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&root).unwrap();
        assert!(load(&root).is_none());
        let cli = root.join("room.json"); std::fs::write(&cli, r#"{"url":"http://10.0.0.5:8766","token":"secret","host":"Studio"}"#).unwrap();
        let connection = import_cli_config(&cli).unwrap(); assert_eq!(connection.me(), "draftway:Studio");
        save(&root, &connection).unwrap(); assert_eq!(load(&root), Some(connection));
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(root.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);}
        forget(&root).unwrap(); forget(&root).unwrap(); assert!(load(&root).is_none());
        assert!(import_cli_config(&root.join("missing.json")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    /// A stand-in room server: answers each request from `reply` and records method, path, auth and body.
    fn server(reply: impl Fn(&str, &str) -> (u16, Value) + Send + 'static) -> (String, Arc<Mutex<Vec<(String, String, String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new())); let log = seen.clone();
        std::thread::spawn(move || for stream in listener.incoming() {
            let Ok(mut stream) = stream else {return;}; let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new(); reader.read_line(&mut line).unwrap(); let parts: Vec<_> = line.split_whitespace().map(String::from).collect();
            let (mut length, mut auth) = (0, String::new());
            loop {let mut header = String::new(); reader.read_line(&mut header).unwrap(); let header = header.trim_end(); if header.is_empty() {break;}
                let (key, value) = header.split_once(": ").unwrap(); if key.eq_ignore_ascii_case("content-length") {length = value.parse().unwrap();} if key.eq_ignore_ascii_case("authorization") {auth = value.into();}}
            let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
            log.lock().unwrap().push((parts[0].clone(), parts[1].clone(), auth, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            let (code, value) = reply(&parts[0], &parts[1]); let bytes = value.to_string();
            write!(stream, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}", bytes.len()).unwrap();
        });
        (url, seen)
    }
    #[test]
    fn view_lists_room_sessions_names_draftway_sessions_and_flags_replies() {
        let (url, log) = server(|_, path| (200, if path == "/state" {json!({
            "sessions":[
                {"id":"draftway:Mac","name":"draftway","host":"Mac","repo":"","state":"live","status":"","polling":[]},
                {"id":"aaaa1111","name":"api-fa","host":"RTX","repo":"api","state":"live","status":"now: tests","polling":["listen"]},
                {"id":"claude-local","name":"","host":"Mac","repo":"draftway","state":"live","status":"","polling":[]},
                {"id":"gone","name":"old","host":"RTX","repo":"api","state":"exited","status":"","polling":[]}],
            "unread":{"aaaa1111":2},"links":[{"name":"release"}],
            "messages":[
                {"id":3,"ts":30.0,"sender":"aaaa1111","sender_name":"api-fa","sender_host":"RTX","to_spec":"aaaa1111","kind":"reply","body":"done","reply_to":2,"link":null},
                {"id":2,"ts":20.0,"sender":"draftway:Mac","sender_name":"draftway","sender_host":"Mac","to_spec":"api-fa@RTX","kind":"ask","body":"status?","reply_to":null,"link":null},
                {"id":1,"ts":10.0,"sender":"aaaa1111","sender_name":"api-fa","sender_host":"RTX","to_spec":"link:release","kind":"notify","body":"shipped","reply_to":null,"link":"release"}]})} else {json!({})}));
        let client = Client::new(checked(&url, "secret", "Mac").unwrap()).unwrap();
        let view = client.view(&[("claude-local".into(), "draftway-session".into(), "修复 登录".into())]).unwrap();
        assert_eq!(view.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["claude-local", "aaaa1111"]);
        assert_eq!(view.sessions[0].name, ""); assert_eq!(view.sessions[0].title, "修复 登录"); assert_eq!(view.sessions[0].draftway_session.as_deref(), Some("draftway-session"));
        assert!(view.sessions[1].listening); assert_eq!(view.sessions[1].unread, 2); assert_eq!(view.links, vec!["release"]);
        assert_eq!(view.messages.iter().map(|m| m.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(view.messages[1].mine && !view.messages[1].to_me); assert!(view.messages[2].to_me); assert!(!view.messages[0].to_me); assert_eq!(view.messages[2].at, 30000);
        {
            let log = log.lock().unwrap();
            assert!(log.iter().all(|(_, _, auth, _)| auth == "Bearer secret"));
            assert_eq!(log[0].1, "/seen"); assert_eq!(log[0].3["session"], "draftway:Mac"); assert_eq!(log[0].3["ended"], false);
            assert!(log.iter().any(|(_, path, ..)| path == "/inbox?session=draftway%3AMac"));
            assert!(!log.iter().any(|(_, path, _, body)| path == "/seen" && body["session"] == "claude-local"), "the hooks own Draftway's Claude sessions");
        }
        client.leave().unwrap(); assert_eq!(log.lock().unwrap().last().unwrap().3["ended"], true);
    }
    #[test]
    fn send_uses_room_message_kinds_and_reports_server_errors() {
        let (url, log) = server(|_, path| if path == "/send" {(400, json!({"error":"no single session matches 'x' (room who)"}))} else {(200, json!({}))});
        let client = Client::new(checked(&url, "secret", "Mac").unwrap()).unwrap();
        assert!(client.send("x", "hi", true, None).unwrap_err().contains("no single session matches"));
        let _ = client.send("api-fa@RTX", "ok", true, Some(7));
        assert!(client.send("api-fa@RTX", " ", false, None).is_err()); assert!(client.send("api-fa@RTX", &"x".repeat(MAX_BODY + 1), false, None).is_err());
        let log = log.lock().unwrap(); let sends: Vec<_> = log.iter().filter(|(_, path, ..)| path == "/send").map(|(.., body)| body.clone()).collect();
        assert_eq!(sends[0]["kind"], "ask"); assert_eq!(sends[1]["kind"], "reply"); assert_eq!(sends[1]["reply_to"], 7); assert_eq!(sends.len(), 2);
        let (url, _) = server(|_, _| (401, json!({"error":"bad token"})));
        assert_eq!(Client::new(checked(&url, "wrong", "Mac").unwrap()).unwrap().view(&[]).err().as_deref(), Some("协作室令牌无效"));
    }
}
