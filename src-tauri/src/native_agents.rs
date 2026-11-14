use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, Weak, atomic::{AtomicU64, Ordering}, mpsc}, time::Duration};

pub type Result<T> = std::result::Result<T, String>;
pub type Sink = Arc<dyn Fn(&AgentSession) + Send + Sync>;
fn now() -> u64 {chrono::Utc::now().timestamp_millis() as u64}
fn valid_id(id: &str) -> bool {!id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {pub id: String, pub role: String, pub text: String, pub at: u64}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {pub id: String, pub state: String, pub started_at: u64, pub finished_at: Option<u64>, pub source_turn_id: Option<String>, pub error: Option<String>}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {pub id: String, pub kind: String, pub title: String, pub payload: Value, pub source_id: Value}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String, pub workspace_id: String, pub node_id: Option<String>, pub backend: String, pub title: String,
    pub cwd: String, pub source_id: Option<String>, pub created_at: u64, pub revision: u64,
    pub messages: Vec<Message>, pub runs: Vec<Run>, pub requests: Vec<Request>, pub error: Option<String>,
}
#[derive(Serialize)]
pub struct Backend {pub id: String, pub available: bool, pub detail: String}
struct Rpc {
    writer: Mutex<ChildStdin>, child: Mutex<Child>, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, serial: AtomicU64,
}
impl Drop for Rpc {fn drop(&mut self) {if let Ok(child) = self.child.get_mut() {let _ = child.kill(); let _ = child.wait();}}}
impl Rpc {
    fn write(&self, value: Value) -> Result<()> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *writer, &value).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").and_then(|_| writer.flush()).map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(); self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        if let Err(error) = self.write(json!({"id":id,"method":method,"params":params})) {self.pending.lock().unwrap().remove(&id); return Err(error);}
        let reply = rx.recv_timeout(Duration::from_secs(45)); self.pending.lock().unwrap().remove(&id);
        let reply = reply.map_err(|_| format!("{method} 未收到执行器响应"))?;
        if let Some(error) = reply.get("error") {return Err(error.get("message").and_then(Value::as_str).unwrap_or("执行器请求失败").to_string());}
        Ok(reply["result"].clone())
    }
}
pub struct AgentHost {
    root: PathBuf, db: Mutex<Connection>, sessions: Mutex<HashMap<String, AgentSession>>, runtimes: Mutex<HashMap<String, Arc<Rpc>>>, sink: Sink,
}
impl AgentHost {
    pub fn open(root: PathBuf, sink: Sink) -> Result<Arc<Self>> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let db = Connection::open(root.join("agent-sessions.sqlite3")).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))); ").map_err(|e| e.to_string())?;
        let mut sessions = HashMap::new();
        {let mut query = db.prepare("SELECT data FROM agent_sessions").map_err(|e| e.to_string())?;
        for row in query.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
            let mut session: AgentSession = serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let mut interrupted = false;
            for run in &mut session.runs {if ["running", "needs_input"].contains(&run.state.as_str()) {run.state = "failed".into(); run.error = Some("上次执行随宿主退出而中断，可继续此会话。".into()); run.finished_at = Some(now()); interrupted = true;}}
            if interrupted {session.requests.clear(); session.revision += 1;}
            sessions.insert(session.id.clone(), session);
        }}
        let host = Arc::new(Self {root, db: Mutex::new(db), sessions: Mutex::new(sessions), runtimes: Mutex::new(HashMap::new()), sink});
        for session in host.list()? {host.persist(&session)?;}
        Ok(host)
    }
    fn persist(&self, session: &AgentSession) -> Result<()> {
        self.db.lock().map_err(|e| e.to_string())?.execute("INSERT INTO agent_sessions(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![session.id, serde_json::to_string(session).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?; Ok(())
    }
    pub fn list(&self) -> Result<Vec<AgentSession>> {let mut all: Vec<_> = self.sessions.lock().map_err(|e| e.to_string())?.values().cloned().collect(); all.sort_by_key(|s| s.created_at); Ok(all)}
    pub fn session(&self, id: &str) -> Result<AgentSession> {self.sessions.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or_else(|| "会话不存在".into())}
    fn update(&self, id: &str, change: impl FnOnce(&mut AgentSession)) -> Result<AgentSession> {
        let (snapshot, saved) = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get_mut(id).ok_or("会话不存在")?; change(session); session.revision += 1;
            let saved = self.persist(session);
            if let Err(error) = &saved {session.error = Some(format!("执行记录保存失败：{error}")); session.requests.clear(); if let Some(run) = session.runs.last_mut() {run.state = "failed".into(); run.finished_at = Some(now()); run.error = session.error.clone();}}
            (session.clone(), saved)
        };
        if saved.is_err() {self.runtimes.lock().unwrap().remove(id);}
        (self.sink)(&snapshot); saved?; Ok(snapshot)
    }
    pub fn create(&self, id: String, workspace_id: String, node_id: Option<String>, backend: String, title: String, cwd: Option<String>) -> Result<AgentSession> {
        if !valid_id(&id) || !valid_id(&workspace_id) || node_id.as_ref().is_some_and(|id| !valid_id(id)) {return Err("会话归属标识无效".into());}
        if backend != "codex" {return Err("此后端尚未接入真实执行".into());}
        if let Ok(existing) = self.session(&id) {if existing.workspace_id == workspace_id && existing.backend == backend {return Ok(existing);} return Err("会话标识已被占用".into());}
        if codex_executable().is_none() {return Err("未找到本机 Codex CLI，请先安装或在接入设置中指定位置。".into());}
        let directory = if let Some(cwd) = cwd.filter(|s| !s.trim().is_empty()) {PathBuf::from(cwd)} else {let directory = self.root.join("workspaces").join(&workspace_id); fs::create_dir_all(&directory).map_err(|e| e.to_string())?; directory};
        let directory = directory.canonicalize().map_err(|e| format!("工作目录不可用：{e}"))?;
        if !directory.is_dir() {return Err("请选择文件夹作为工作目录".into());}
        let cwd = directory.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&directory.to_string_lossy()).to_string();
        let session = AgentSession {id: id.clone(), workspace_id, node_id, backend, title: if title.trim().is_empty() {"新的会话".into()} else {title.chars().take(100).collect()}, cwd, source_id: None, created_at: now(), revision: 1, messages: Vec::new(), runs: Vec::new(), requests: Vec::new(), error: None};
        self.persist(&session)?; self.sessions.lock().map_err(|e| e.to_string())?.insert(id, session.clone()); (self.sink)(&session); Ok(session)
    }
    fn connect(self: &Arc<Self>, id: &str) -> Result<Arc<Rpc>> {
        if let Some(runtime) = self.runtimes.lock().map_err(|e| e.to_string())?.get(id).cloned() {return Ok(runtime);}
        let session = self.session(id)?;
        let executable = codex_executable().ok_or("未找到 Codex CLI")?;
        let mut command = Command::new(executable);
        command.args(["app-server", "--listen", "stdio://"]).current_dir(&session.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
        let mut child = command.spawn().map_err(|e| format!("无法启动 Codex：{e}"))?;
        let writer = child.stdin.take().ok_or("无法连接执行器输入")?;
        let stdout = child.stdout.take().ok_or("无法连接执行器输出")?;
        let stderr = child.stderr.take().ok_or("无法连接执行器错误流")?;
        // Drain diagnostics, without retaining provider configuration or credentials.
        std::thread::spawn(move || {for line in BufReader::new(stderr).lines() {if line.is_err() {break;}}});
        let pending = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<Value>>::new()));
        let rpc = Arc::new(Rpc {writer: Mutex::new(writer), child: Mutex::new(child), pending: pending.clone(), serial: AtomicU64::new(1)});
        let owner = Arc::downgrade(self); let session_id = id.to_string();
        std::thread::spawn(move || read_codex(stdout, pending, owner, session_id));
        rpc.request("initialize", json!({"clientInfo":{"name":"northstar_workbench","title":"北极星","version":env!("CARGO_PKG_VERSION")}}))?;
        rpc.write(json!({"method":"initialized"}))?;
        let method = if session.source_id.is_some() {"thread/resume"} else {"thread/start"};
        let mut params = json!({"cwd":session.cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"});
        if let Some(source) = session.source_id {params["threadId"] = json!(source);}
        let result = rpc.request(method, params)?;
        let source = result["thread"]["id"].as_str().ok_or("Codex 未返回来源会话标识")?.to_string();
        self.update(id, |session| {session.source_id = Some(source); session.error = None;})?;
        self.runtimes.lock().map_err(|e| e.to_string())?.insert(id.to_string(), rpc.clone()); Ok(rpc)
    }
    pub fn send(self: &Arc<Self>, id: &str, run_id: String, text: String) -> Result<AgentSession> {
        if text.trim().is_empty() || text.len() > 100_000 || !valid_id(&run_id) {return Err("消息内容或执行标识无效".into());}
        let session = self.session(id)?;
        if session.runs.iter().any(|r| ["running", "needs_input"].contains(&r.state.as_str())) {return Err("此会话仍有执行未结束".into());}
        if session.runs.iter().any(|r| r.id == run_id) {return Ok(session);}
        let mut rejected = false;
        let snapshot = self.update(id, |session| {
            if session.runs.iter().any(|r| ["running", "needs_input"].contains(&r.state.as_str()) || r.id == run_id) {rejected = true; return;}
            if session.messages.is_empty() && session.title.starts_with("新的会话") {session.title = text.lines().next().unwrap_or(&text).chars().take(32).collect();}
            session.error = None;
            session.messages.push(Message {id: format!("{run_id}-user"), role: "user".into(), text: text.clone(), at: now()});
            session.runs.push(Run {id: run_id.clone(), state: "running".into(), started_at: now(), finished_at: None, source_turn_id: None, error: None});
        })?;
        if rejected {return Err("此会话仍有执行未结束，或执行标识重复".into());}
        let host = self.clone(); let id = id.to_string();
        std::thread::spawn(move || {
            let result = (|| {
                let rpc = host.connect(&id)?; let session = host.session(&id)?;
                if session.runs.last().is_none_or(|r| r.state != "running") {return Ok(());}
                let result = rpc.request("turn/start", json!({"threadId":session.source_id,"input":[{"type":"text","text":text}]}))?;
                let source = result["turn"]["id"].as_str().ok_or("Codex 未返回执行标识")?.to_string();
                let after = host.update(&id, |s| {if let Some(run) = s.runs.iter_mut().find(|r| r.id == run_id) {run.source_turn_id = Some(source.clone());}})?;
                if after.runs.last().is_some_and(|r| r.state == "cancelled") {rpc.request("turn/interrupt", json!({"threadId":after.source_id,"turnId":source}))?;}
                Ok(())
            })();
            if let Err(error) = result {let _ = host.fail(&id, error); host.runtimes.lock().unwrap().remove(&id);}
        }); Ok(snapshot)
    }
    fn fail(&self, id: &str, error: String) -> Result<AgentSession> {self.update(id, |s| {s.error = Some(error.clone()); s.requests.clear(); if let Some(run) = s.runs.last_mut().filter(|r| ["running", "needs_input"].contains(&r.state.as_str())) {run.state = "failed".into(); run.finished_at = Some(now()); run.error = Some(error);}})}
    pub fn stop(&self, id: &str) -> Result<AgentSession> {
        let session = self.session(id)?;
        if let Some(run) = session.runs.last().filter(|r| ["running", "needs_input"].contains(&r.state.as_str())) {
            if let (Some(rpc), Some(turn)) = (self.runtimes.lock().unwrap().get(id).cloned(), run.source_turn_id.as_ref()) {rpc.request("turn/interrupt", json!({"threadId":session.source_id,"turnId":turn}))?;}
            self.update(id, |s| {s.requests.clear(); if let Some(run) = s.runs.last_mut() {run.state = "cancelled".into(); run.finished_at = Some(now());}})
        } else {Ok(session)}
    }
    pub fn respond(&self, id: &str, request_id: &str, answer: Value) -> Result<AgentSession> {
        let session = self.session(id)?;
        let request = session.requests.iter().find(|r| r.id == request_id).ok_or("请求已结束或不存在")?;
        let rpc = self.runtimes.lock().unwrap().get(id).cloned().ok_or("执行器已断开")?;
        let result = match request.kind.as_str() {
            "approval" => {let decision = answer["decision"].as_str().filter(|s| ["accept", "decline", "cancel"].contains(s)).ok_or("请选择允许或拒绝")?; json!({"decision":decision})},
            "input" => {if !answer["answers"].is_object() {return Err("回答内容无效".into());} answer},
            _ => return Err("请求类型暂不支持".into()),
        };
        rpc.write(json!({"id":request.source_id,"result":result}))?;
        self.update(id, |s| {s.requests.retain(|r| r.id != request_id); if s.requests.is_empty() {if let Some(run) = s.runs.last_mut().filter(|r| r.state == "needs_input") {run.state = "running".into();}}})
    }
    pub fn shutdown(&self) {if let Ok(mut runtimes) = self.runtimes.lock() {runtimes.clear();}}
    fn event(&self, id: &str, value: &Value) {
        let method = value["method"].as_str().unwrap_or(""); let p = &value["params"];
        if value.get("id").is_some() && value.get("method").is_some() {
            let kind = if method.ends_with("requestApproval") {"approval"} else if method == "item/tool/requestUserInput" {"input"} else {"unsupported"};
            let title = p["reason"].as_str().or(p["command"].as_str()).unwrap_or(method).chars().take(2000).collect();
            let _ = self.update(id, |s| {let request_id = value["id"].to_string(); if !s.requests.iter().any(|r| r.id == request_id) {s.requests.push(Request {id: request_id, kind: kind.into(), title, payload: p.clone(), source_id: value["id"].clone()});} if let Some(run) = s.runs.last_mut() {run.state = "needs_input".into();}}); return;
        }
        if ["item/agentMessage/delta", "item/completed", "turn/started", "turn/completed", "error"].contains(&method) {
            let _ = self.update(id, |s| apply_codex_event(s, method, p));
        }
    }
}
fn read_codex(stdout: std::process::ChildStdout, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, host: Weak<AgentHost>, id: String) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {break;}; let Ok(value) = serde_json::from_str::<Value>(&line) else {continue;};
        if value.get("method").is_none() {if let Some(key) = value["id"].as_u64() {if let Some(sender) = pending.lock().unwrap().remove(&key) {let _ = sender.send(value);}}}
        else if let Some(host) = host.upgrade() {host.event(&id, &value);} else {break;}
    }
    pending.lock().unwrap().clear();
    if let Some(host) = host.upgrade() {if host.session(&id).is_ok_and(|s| s.runs.last().is_some_and(|r| ["running", "needs_input"].contains(&r.state.as_str()))) {let _ = host.fail(&id, "执行器连接已关闭，可继续此会话。".into());} host.runtimes.lock().unwrap().remove(&id);}
}
fn apply_codex_event(s: &mut AgentSession, method: &str, p: &Value) {
    if p["threadId"].as_str().is_some_and(|id| s.source_id.as_deref().is_some_and(|own| own != id)) {return;}
    let incoming_turn = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
    if method != "turn/started" && incoming_turn.is_some_and(|incoming| s.runs.last().and_then(|r| r.source_turn_id.as_deref()).is_some_and(|current| current != incoming)) {return;}
    match method {
        "turn/started" => {if let Some(run) = s.runs.last_mut() {run.source_turn_id = p["turn"]["id"].as_str().map(String::from);}},
        "item/agentMessage/delta" => {
            let Some(run) = s.runs.last() else {return;}; if !["running", "needs_input"].contains(&run.state.as_str()) {return;}
            let id = p["itemId"].as_str().unwrap_or("assistant"); let key = format!("{}-{id}", run.id);
            if !s.messages.iter().any(|m| m.id == key) {s.messages.push(Message {id: key.clone(), role: "assistant".into(), text: String::new(), at: now()});}
            if let Some(message) = s.messages.iter_mut().find(|m| m.id == key) {message.text.push_str(p["delta"].as_str().unwrap_or(""));}
        },
        "item/completed" if p["item"]["type"] == "agentMessage" => {
            let Some(run) = s.runs.last() else {return;}; let item = &p["item"]; let key = format!("{}-{}", run.id, item["id"].as_str().unwrap_or("assistant"));
            let text = item["text"].as_str().unwrap_or("").to_string();
            if let Some(message) = s.messages.iter_mut().find(|m| m.id == key) {message.text = text;} else {s.messages.push(Message {id: key, role: "assistant".into(), text, at: now()});}
        },
        "turn/completed" => {
            if let Some(run) = s.runs.last_mut() {if run.state == "cancelled" {return;} run.state = match p["turn"]["status"].as_str() {Some("completed") => "succeeded", Some("interrupted") => "cancelled", _ => "failed"}.into(); run.finished_at = Some(now()); run.error = p["turn"]["error"]["message"].as_str().map(String::from);}
            s.requests.clear();
        },
        "error" if p["willRetry"] != true => {s.error = p["error"]["message"].as_str().map(String::from);},
        _ => {}
    }
}
pub fn codex_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NORTHSTAR_CODEX").map(PathBuf::from).filter(|p| p.is_file()) {return Some(path);}
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {let path = dir.join(if cfg!(windows) {"codex.exe"} else {"codex"}); if path.is_file() {return Some(path);}}
    #[cfg(windows)] if let Some(appdata) = std::env::var_os("APPDATA") {
        let base = Path::new(&appdata).join("npm/node_modules/@openai/codex/node_modules/@openai");
        for package in ["codex-win32-x64", "codex-win32-arm64"] {for arch in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {let file = base.join(package).join("vendor").join(arch).join("bin/codex.exe"); if file.is_file() {return Some(file);}}}
    }
    None
}
pub fn backends() -> Vec<Backend> {vec![Backend {id: "codex".into(), available: codex_executable().is_some(), detail: "本机 Codex app-server".into()}, Backend {id: "claude".into(), available: false, detail: "适配器接入中".into()}, Backend {id: "pi".into(), available: false, detail: "适配器接入中".into()}]}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> AgentSession {AgentSession {id: "s".into(), workspace_id: "w".into(), node_id: None, backend: "codex".into(), title: "test".into(), cwd: String::new(), source_id: Some("thread".into()), created_at: 0, revision: 1, messages: vec![], requests: vec![], error: None, runs: vec![Run {id: "run".into(), state: "running".into(), started_at: 0, finished_at: None, source_turn_id: Some("turn".into()), error: None}]}}
    #[test]
    fn streams_without_duplicate_final_messages_and_never_maps_failure_to_success() {
        let mut s = record();
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"thread","itemId":"a","delta":"Hel"}));
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"thread","itemId":"a","delta":"lo"}));
        apply_codex_event(&mut s, "item/completed", &json!({"item":{"type":"agentMessage","id":"a","text":"Hello"}}));
        assert_eq!(s.messages.len(), 1); assert_eq!(s.messages[0].text, "Hello");
        apply_codex_event(&mut s, "turn/completed", &json!({"turn":{"status":"failed","error":{"message":"network"}}}));
        assert_eq!(s.runs[0].state, "failed"); assert_eq!(s.runs[0].error.as_deref(), Some("network"));
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"itemId":"late","delta":"ignore"})); assert_eq!(s.messages.len(), 1);
    }
    #[test]
    fn ignores_other_threads_and_keeps_cancelled_run_cancelled() {
        let mut s = record(); apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"other","itemId":"a","delta":"wrong"})); assert!(s.messages.is_empty());
        s.runs[0].state = "cancelled".into(); apply_codex_event(&mut s, "turn/completed", &json!({"turn":{"status":"completed"}})); assert_eq!(s.runs[0].state, "cancelled");
    }
    #[test]
    fn restores_unfinished_execution_as_interrupted_and_retains_transcript() {
        let dir = std::env::temp_dir().join(format!("northstar-agent-test-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(dir.clone(), Arc::new(|_| {})).unwrap(); let mut s = record(); s.messages.push(Message {id: "m".into(), role: "user".into(), text: "keep".into(), at: 0}); host.persist(&s).unwrap(); drop(host);
        let restored = AgentHost::open(dir, Arc::new(|_| {})).unwrap().session("s").unwrap(); assert_eq!(restored.runs[0].state, "failed"); assert_eq!(restored.messages[0].text, "keep"); assert!(restored.source_id.is_some());
    }
    #[test]
    fn failed_persistence_is_reported_and_never_published_as_success() {
        let dir = std::env::temp_dir().join(format!("northstar-agent-test-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(dir, Arc::new(|_| {})).unwrap(); host.sessions.lock().unwrap().insert("s".into(), record());
        host.db.lock().unwrap().execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(host.update("s", |s| {s.runs[0].state = "succeeded".into();}).is_err());
        let state = host.session("s").unwrap(); assert_eq!(state.runs[0].state, "failed"); assert!(state.error.as_deref().unwrap().contains("保存失败"));
    }
}
