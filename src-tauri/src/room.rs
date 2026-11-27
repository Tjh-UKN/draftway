//! Read-only client for a switchboard room server (`pip install switchboard-room`): a mailbox that Claude Code sessions
//! on several machines share over the LAN. The room is for agents talking to each other, so Draftway only watches it:
//! it lists the sessions and shows the recent thread, never registers itself, sends or marks anything read. Claude Code
//! sessions that Draftway starts join through the room hooks when those are installed.
use crate::store::{error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::{Path, PathBuf}, time::Duration};
use url::Url;

const FILE: &str = "room-connection.json";
const MAX_RESPONSE: usize = 2_000_000;

/// Kept in its own file beside the database, so backups and exports never carry the room token.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Connection {pub url: String, pub token: String}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {pub id: String, pub name: String, pub title: String, pub host: String, pub repo: String, pub version: String, pub state: String, pub status: String,
    pub last_seen: u64, pub unread: u64, pub polling: Vec<String>, pub links: Vec<String>, pub draftway_session: Option<String>}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Message {pub id: u64, pub at: u64, pub sender: String, pub from: String, pub to: String, pub target: Option<String>, pub link: Option<String>, pub kind: String, pub body: String, pub reply_to: Option<u64>}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {pub configured: bool, pub url: String, pub sessions: Vec<Session>, pub messages: Vec<Message>}
/// A Claude Code session started by Draftway: (Claude session id, Draftway session id, title).
pub type Local = (String, String, String);

pub fn server_url(value: &str) -> Result<String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入协作室服务地址，例如 http://192.168.1.20:8766")?;
    if !["http", "https"].contains(&url.scheme()) || url.host().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !["", "/"].contains(&url.path()) {
        return Err("协作室地址只能是 http(s)://主机:端口，不含路径、账号或参数".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
pub fn checked(url: &str, token: &str) -> Result<Connection> {
    let token = token.trim();
    if token.is_empty() || token.len() > 200 || token.chars().any(char::is_control) {return Err("请输入协作室令牌".into());}
    Ok(Connection {url: server_url(url)?, token: token.into()})
}
pub fn load(root: &Path) -> Option<Connection> {
    let saved: Connection = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    checked(&saved.url, &saved.token).ok()
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
    checked(value["url"].as_str().unwrap_or_default(), value["token"].as_str().unwrap_or_default())
}

pub struct Client {http: reqwest::blocking::Client, connection: Connection}
impl Client {
    pub fn new(connection: Connection) -> Result<Self> {
        let http = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(6)).redirect(reqwest::redirect::Policy::none()).build().map_err(error)?;
        Ok(Self {http, connection})
    }
    fn get(&self, path: &str) -> Result<Value> {
        let response = self.http.get(format!("{}{}", self.connection.url, path)).bearer_auth(&self.connection.token).send().map_err(|e| format!("无法连接协作室：{}", e.without_url()))?;
        let status = response.status();
        let mut bytes = Vec::new(); response.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut bytes).map_err(error)?;
        if bytes.len() > MAX_RESPONSE {return Err("协作室响应超过 2 MB".into());}
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "协作室未返回有效 JSON，请确认地址指向 room 服务")?;
        if status.as_u16() == 401 {return Err("协作室令牌无效".into());}
        if !status.is_success() {return Err(value["error"].as_str().map(|e| format!("协作室拒绝了请求：{e}")).unwrap_or_else(|| format!("协作室请求失败（{status}）")));}
        Ok(value)
    }
    /// One `GET /state`: it needs no session id and changes nothing on the server.
    pub fn view(&self, local: &[Local]) -> Result<View> {
        let state = self.get("/state")?;
        let rows = state["sessions"].as_array().ok_or("协作室会话列表格式不兼容")?;
        let mut view = View {configured: true, url: self.connection.url.clone(), ..Default::default()};
        let day_ago = now_ms().saturating_sub(86_400_000);
        for row in rows {
            let id = text(row, "id");
            // `human:` ids are people at a terminal, which `room who` hides too.
            if id.is_empty() || id.starts_with("human:") {continue;}
            let mine = local.iter().find(|(source, ..)| source == &id);
            let last_seen = (row["last_seen"].as_f64().unwrap_or(0.0) * 1000.0) as u64;
            // Like `room who`: sessions that exited more than a day ago drop off, except Draftway's own.
            if text(row, "state") == "exited" && last_seen < day_ago && mine.is_none() {continue;}
            let list = |key: &str| row[key].as_array().map(|items| items.iter().filter_map(|i| i.as_str().map(String::from)).collect()).unwrap_or_default();
            // The room hooks register `claude -p` sessions without a name; label them with the Draftway title, locally only.
            view.sessions.push(Session {name: text(row, "name"), title: mine.map(|(.., title)| title.clone()).unwrap_or_default(), host: text(row, "host"), repo: text(row, "repo"),
                version: text(row, "version"), state: text(row, "state"), status: text(row, "status"), last_seen, unread: state["unread"][&id].as_u64().unwrap_or(0),
                polling: list("polling"), links: list("links"), draftway_session: mine.map(|(_, draftway, _)| draftway.clone()), id});
        }
        view.sessions.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        let rows = state["messages"].as_array().ok_or("协作室消息格式不兼容")?;
        let ids: Vec<(String, String, String)> = rows_of(&state["sessions"]);
        let senders: std::collections::HashMap<u64, String> = rows.iter().filter_map(|m| Some((m["id"].as_u64()?, text(m, "sender")))).collect();
        for row in rows.iter().take(200).rev() {
            let sender = text(row, "sender");
            let from = match (text(row, "sender_name"), text(row, "sender_host")) {(name, host) if !name.is_empty() => format!("{name}@{host}"), _ => sender.chars().take(8).collect()};
            let to = text(row, "to_spec"); let reply_to = row["reply_to"].as_u64();
            let target = resolve(&ids, &to).or_else(|| reply_to.and_then(|id| senders.get(&id).cloned()))
                .or_else(|| ["repo:", "link:", "host:"].iter().any(|p| to.starts_with(p)).then(|| to.clone()).or_else(|| (to == "all").then(|| to.clone())));
            view.messages.push(Message {id: row["id"].as_u64().unwrap_or(0), at: (row["ts"].as_f64().unwrap_or(0.0) * 1000.0) as u64, sender, from, to, target,
                link: row["link"].as_str().map(String::from), kind: text(row, "kind"), body: text(row, "body"), reply_to});
        }
        Ok(view)
    }
}
fn now_ms() -> u64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}
/// (id, name, host) of every session the server lists, most recently seen first, as the server returns them.
fn rows_of(sessions: &Value) -> Vec<(String, String, String)> {
    sessions.as_array().map(|rows| rows.iter().map(|r| (text(r, "id"), text(r, "name"), text(r, "host"))).collect()).unwrap_or_default()
}
/// The session a direct address names, the way the server resolves it: id, name@host, name, or an id prefix of 6+.
fn resolve(ids: &[(String, String, String)], who: &str) -> Option<String> {
    if who.is_empty() {return None;}
    if let Some((id, ..)) = ids.iter().find(|(id, ..)| id == who) {return Some(id.clone());}
    if let Some((name, host)) = who.rsplit_once('@').filter(|(name, _)| !name.is_empty()) {
        if let Some((id, ..)) = ids.iter().find(|(_, n, h)| n == name && h.eq_ignore_ascii_case(host)) {return Some(id.clone());}
    }
    if let Some((id, ..)) = ids.iter().find(|(_, n, _)| n == who) {return Some(id.clone());}
    let prefixed: Vec<_> = ids.iter().filter(|(id, ..)| who.len() >= 6 && id.starts_with(who)).collect();
    (prefixed.len() == 1).then(|| prefixed[0].0.clone())
}
fn text(value: &Value, key: &str) -> String {value[key].as_str().unwrap_or_default().to_string()}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{io::{BufRead, BufReader, Write}, net::TcpListener, sync::{Arc, Mutex}};
    #[test]
    #[ignore = "requires a switchboard room server: ROOM_TEST_URL and ROOM_TEST_TOKEN; registers live-claude-session there"]
    fn live_room_server_round_trip() {
        let connection = checked(&std::env::var("ROOM_TEST_URL").unwrap(), &std::env::var("ROOM_TEST_TOKEN").unwrap()).unwrap();
        let post = |path: &str, body: Value| reqwest::blocking::Client::new().post(format!("{}{path}", connection.url)).bearer_auth(&connection.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string()).send().unwrap().error_for_status().unwrap();
        // What the room hooks of a `claude -p` session started by Draftway send: an id and folder, no name.
        post("/seen", json!({"session":"live-claude-session","host":"DraftwayTest","cwd":"/tmp/project","repo":"project"}));
        post("/seen", json!({"session":"live-peer","host":"DraftwayTest","name":"peer","repo":"project"}));
        post("/send", json!({"session":"live-peer","to":"live-claude-session","body":"进度如何？","kind":"ask"}));
        let client = Client::new(connection.clone()).unwrap();
        let local = [("live-claude-session".to_string(), "draftway-id".to_string(), "整理 发布说明".to_string())];
        let view = client.view(&local).unwrap();
        let session = view.sessions.iter().find(|s| s.id == "live-claude-session").unwrap();
        assert_eq!(session.title, "整理 发布说明"); assert_eq!(session.draftway_session.as_deref(), Some("draftway-id"));
        assert!(session.unread >= 1, "watching does not mark the session's messages read");
        assert!(view.messages.iter().any(|m| m.from == "peer@DraftwayTest" && m.kind == "ask" && m.body == "进度如何？"));
        assert!(!view.sessions.iter().any(|s| s.id.starts_with("draftway")), "Draftway never registers itself");
    }
    #[test]
    fn addresses_and_tokens_are_validated_before_saving() {
        assert_eq!(server_url("http://192.168.1.20:8766/").unwrap(), "http://192.168.1.20:8766");
        assert_eq!(server_url(" https://room.example.ts.net ").unwrap(), "https://room.example.ts.net");
        for url in ["ftp://host/", "http://user:pw@host:8766", "http://host:8766/api", "http://host:8766/?token=x", "file:///etc/passwd", "room"] {assert!(server_url(url).is_err(), "{url}");}
        assert!(checked("http://h:1", " ").is_err());
    }
    #[test]
    fn connection_lives_outside_the_database_and_imports_the_room_cli_config() {
        let root = std::env::temp_dir().join(format!("draftway-room-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&root).unwrap();
        assert!(load(&root).is_none());
        let cli = root.join("room.json"); std::fs::write(&cli, r#"{"url":"http://10.0.0.5:8766","token":"secret","host":"Studio"}"#).unwrap();
        let connection = import_cli_config(&cli).unwrap(); assert_eq!(connection.url, "http://10.0.0.5:8766");
        save(&root, &connection).unwrap(); assert_eq!(load(&root), Some(connection));
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(root.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);}
        forget(&root).unwrap(); forget(&root).unwrap(); assert!(load(&root).is_none());
        assert!(import_cli_config(&root.join("missing.json")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    /// A stand-in room server: answers each request from `reply` and records method, path and auth.
    fn server(reply: impl Fn(&str) -> (u16, Value) + Send + 'static) -> (String, Arc<Mutex<Vec<(String, String, String)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new())); let log = seen.clone();
        std::thread::spawn(move || for stream in listener.incoming() {
            let Ok(mut stream) = stream else {return;}; let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new(); reader.read_line(&mut line).unwrap(); let parts: Vec<_> = line.split_whitespace().map(String::from).collect();
            let mut auth = String::new();
            loop {let mut header = String::new(); reader.read_line(&mut header).unwrap(); let header = header.trim_end(); if header.is_empty() {break;}
                let (key, value) = header.split_once(": ").unwrap(); if key.eq_ignore_ascii_case("authorization") {auth = value.into();}}
            log.lock().unwrap().push((parts[0].clone(), parts[1].clone(), auth));
            let (code, value) = reply(&parts[1]); let bytes = value.to_string();
            write!(stream, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}", bytes.len()).unwrap();
        });
        (url, seen)
    }
    #[test]
    fn view_only_reads_the_room_state_and_names_draftway_sessions() {
        let now = now_ms() as f64 / 1000.0;
        let (url, log) = server(move |path| (200, if path == "/state" {json!({
            "sessions":[
                {"id":"aaaa1111","name":"api-fa","host":"RTX","repo":"api","version":"0.1.7","state":"live","status":"now: tests","polling":["listen"],"links":["release"],"last_seen":now - 5.0},
                {"id":"claude-local","name":"","host":"Mac","repo":"draftway","state":"live","status":"","polling":[],"links":[],"last_seen":now - 60.0},
                {"id":"bbbb2222","name":"web-3c","host":"Mac","repo":"web","state":"exited","status":"","polling":[],"links":[],"last_seen":now - 3600.0},
                {"id":"human:me@Mac","name":"","host":"Mac","repo":"","state":"live","status":"","polling":[],"links":[],"last_seen":now},
                {"id":"gone","name":"old","host":"RTX","repo":"api","state":"exited","status":"","polling":[],"links":[],"last_seen":now - 200000.0}],
            "unread":{"aaaa1111":2},"links":[{"name":"release"}],
            "messages":[
                {"id":4,"ts":40.0,"sender":"claude-local","sender_name":"","sender_host":"Mac","to_spec":"api-fa@rtx","kind":"notify","body":"fyi","reply_to":null,"link":null},
                {"id":3,"ts":30.0,"sender":"bbbb2222","sender_name":"web-3c","sender_host":"Mac","to_spec":"someone-gone","kind":"reply","body":"ok","reply_to":2,"link":null},
                {"id":2,"ts":20.0,"sender":"aaaa1111","sender_name":"api-fa","sender_host":"RTX","to_spec":"bbbb22","kind":"reply","body":"done","reply_to":1,"link":null},
                {"id":1,"ts":10.0,"sender":"bbbb2222","sender_name":"","sender_host":"Mac","to_spec":"link:release","kind":"ask","body":"shipped?","reply_to":null,"link":"release"}]})} else {json!({})}));
        let client = Client::new(checked(&url, "secret").unwrap()).unwrap();
        let view = client.view(&[("claude-local".into(), "draftway-session".into(), "修复 登录".into())]).unwrap();
        // Most recently seen first; people (`human:`) and sessions that exited over a day ago are left out, as in `room who`.
        assert_eq!(view.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["aaaa1111", "claude-local", "bbbb2222"]);
        assert_eq!(view.sessions[1].name, ""); assert_eq!(view.sessions[1].title, "修复 登录"); assert_eq!(view.sessions[1].draftway_session.as_deref(), Some("draftway-session"));
        let api = &view.sessions[0]; assert_eq!((api.polling.clone(), api.links.clone(), api.version.as_str(), api.unread), (vec!["listen".to_string()], vec!["release".to_string()], "0.1.7", 2));
        assert_eq!(view.messages.iter().map(|m| m.id).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!(view.messages[0].from, "bbbb2222"); assert_eq!(view.messages[1].from, "api-fa@RTX"); assert_eq!(view.messages[1].reply_to, Some(1)); assert_eq!(view.messages[1].at, 20000);
        // Who each message went to, for the conversation map: a link, an id prefix, a reply's original sender, name@host in any case.
        let targets: Vec<_> = view.messages.iter().map(|m| m.target.as_deref()).collect();
        assert_eq!(targets, vec![Some("link:release"), Some("bbbb2222"), Some("aaaa1111"), Some("aaaa1111")]);
        let log = log.lock().unwrap();
        assert_eq!(log.iter().map(|(method, path, auth)| (method.as_str(), path.as_str(), auth.as_str())).collect::<Vec<_>>(), vec![("GET", "/state", "Bearer secret")]);
    }
    #[test]
    fn a_wrong_token_is_reported_plainly() {
        let (url, _) = server(|_| (401, json!({"error":"bad token"})));
        assert_eq!(Client::new(checked(&url, "wrong").unwrap()).unwrap().view(&[]).err().as_deref(), Some("协作室令牌无效"));
    }
}
