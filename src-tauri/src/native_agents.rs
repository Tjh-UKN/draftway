use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin}, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc}, time::Duration};
#[path = "agent_providers.rs"]
mod providers;
#[path = "agent_process.rs"]
mod process;

pub type Result<T> = std::result::Result<T, String>;
pub type Sink = Arc<dyn Fn(&AgentSession) + Send + Sync>;
pub type TranscriptSink = Arc<dyn Fn(&TranscriptFrame) + Send + Sync>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFrame {pub id:String,pub base_revision:u64,pub revision:u64,pub messages:Vec<Message>}
#[derive(Default)]
struct Checkpoint {saved_at:u64,base_revision:u64,dirty:bool,unsaved:bool}
fn now() -> u64 {chrono::Utc::now().timestamp_millis() as u64}
fn valid_id(id: &str) -> bool {!id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {pub id: String, pub role: String, pub text: String, pub at: u64}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {pub id: String, pub state: String, pub started_at: u64, pub finished_at: Option<u64>, pub source_turn_id: Option<String>, pub error: Option<String>, #[serde(default)] pub cancel_requested: bool, #[serde(default)] pub context: Option<String>}
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
#[derive(Clone)]
pub struct WorkspaceTools {pub executable: PathBuf, pub root: PathBuf, pub definitions: Value}
pub struct ToolConfig {pub command: String, pub args: Vec<String>, pub definitions: Value}
struct Rpc {
    writer: Mutex<ChildStdin>, child: Mutex<Child>, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, serial: AtomicU64,
    backend: String,
    ownership: process::Ownership,
}
impl Drop for Rpc {fn drop(&mut self) {self.ownership.group.stop(); if let Ok(child) = self.child.get_mut() {let _ = child.kill(); let _ = child.wait();}}}
impl Rpc {
    fn write(&self, value: Value) -> Result<()> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *writer, &value).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").and_then(|_| writer.flush()).map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(); self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        if let Err(error) = self.write(providers::wire_request(&self.backend, id, method, params)) {self.pending.lock().unwrap().remove(&id); return Err(error);}
        let reply = rx.recv_timeout(Duration::from_secs(if ["turn/interrupt", "interrupt", "abort"].contains(&method) {5} else {45})); self.pending.lock().unwrap().remove(&id);
        let reply = reply.map_err(|_| format!("{method} 未收到执行器响应"))?;
        if let Some(error) = reply.get("error") {return Err(error.get("message").and_then(Value::as_str).unwrap_or("执行器请求失败").to_string());}
        Ok(reply["result"].clone())
    }
}
pub struct AgentHost {
    root: PathBuf, db: Mutex<Connection>, sessions: Mutex<HashMap<String, AgentSession>>, runtimes: Mutex<HashMap<String, Arc<Rpc>>>, sink: Sink,
    checkpoints: Mutex<HashMap<String, Checkpoint>>,
    transcript_sink:Mutex<Option<TranscriptSink>>,
    tools: Mutex<Option<WorkspaceTools>>,
    maintenance: AtomicBool,
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
            for run in &mut session.runs {if ["running", "needs_input"].contains(&run.state.as_str()) {run.state = if run.cancel_requested {"cancelled"} else {"failed"}.into(); run.error = (!run.cancel_requested).then(|| "上次执行随宿主退出而中断，可继续此会话。".into()); run.finished_at = Some(now()); interrupted = true;}}
            if interrupted {session.requests.clear(); session.revision += 1;}
            sessions.insert(session.id.clone(), session);
        }}
        let host = Arc::new(Self {root, db: Mutex::new(db), sessions: Mutex::new(sessions), runtimes: Mutex::new(HashMap::new()), sink, checkpoints: Mutex::new(HashMap::new()), transcript_sink:Mutex::new(None),tools: Mutex::new(None),maintenance:AtomicBool::new(false)});
        for session in host.list()? {host.persist(&session)?;}
        let owner=Arc::downgrade(&host);
        std::thread::spawn(move || loop {std::thread::sleep(Duration::from_millis(33));let Some(host)=owner.upgrade() else {break;};host.flush_streams();});
        Ok(host)
    }
    fn persist(&self, session: &AgentSession) -> Result<()> {
        self.db.lock().map_err(|e| e.to_string())?.execute("INSERT INTO agent_sessions(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![session.id, serde_json::to_string(session).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?; Ok(())
    }
    pub fn list(&self) -> Result<Vec<AgentSession>> {let mut all: Vec<_> = self.sessions.lock().map_err(|e| e.to_string())?.values().cloned().collect(); all.sort_by_key(|s| s.created_at); Ok(all)}
    pub fn session(&self, id: &str) -> Result<AgentSession> {self.sessions.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or_else(|| "会话不存在".into())}
    pub fn reconcile_nodes(&self,snapshot:&Value)->Result<()> {
        let changes={let sessions=self.sessions.lock().map_err(|e|e.to_string())?;sessions.values().filter_map(|session|{
            let front=snapshot["sessions"].as_array()?.iter().find(|s|s["id"]==session.id&&s["workspaceId"]==session.workspace_id)?;
            let space=snapshot["spaces"].as_array()?.iter().find(|w|w["id"]==session.workspace_id)?;
            let desired=front["nodeId"].as_str().filter(|id|space["nodes"].as_array().is_some_and(|nodes|nodes.iter().any(|n|n["id"]==*id))).map(String::from);
            (desired!=session.node_id).then(||(session.id.clone(),session.node_id.clone(),desired))
        }).collect::<Vec<_>>()};
        for (id,expected,desired) in changes {self.update(&id,|session|{if session.node_id==expected {session.node_id=desired;}})?;}
        Ok(())
    }
    pub fn configure_tools(&self, tools: WorkspaceTools) {if let Ok(mut config)=self.tools.lock(){*config=Some(tools);}}
    pub fn configure_transcript_sink(&self,sink:TranscriptSink){*self.transcript_sink.lock().unwrap()=Some(sink);}
    fn update(&self, id: &str, change: impl FnOnce(&mut AgentSession)) -> Result<AgentSession> {
        self.update_stream(id, false, change)?.ok_or_else(||"执行记录快照未发布".into())
    }
    fn update_stream(&self, id: &str, stream: bool, change: impl FnOnce(&mut AgentSession)) -> Result<Option<AgentSession>> {
        let (snapshot, saved) = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复会话，请稍后重试".into());}
            let session = sessions.get_mut(id).ok_or("会话不存在")?; change(session); session.revision += 1;
            let mut clocks=self.checkpoints.lock().map_err(|e|e.to_string())?;let clock=clocks.entry(id.into()).or_default();
            if stream {clock.dirty=true;clock.unsaved=true;return Ok(None);}
            *clock=Checkpoint{saved_at:now(),base_revision:session.revision,..Default::default()};
            let saved = self.persist(session);
            if let Err(error) = &saved {session.error = Some(format!("执行记录保存失败：{error}")); session.requests.clear(); if let Some(run) = session.runs.last_mut() {run.state = "failed".into(); run.finished_at = Some(now()); run.error = session.error.clone();}}
            (Some(session.clone()), saved)
        };
        if saved.is_err() {self.runtimes.lock().unwrap().remove(id);}
        if let Some(snapshot)=&snapshot{(self.sink)(snapshot);} saved?; Ok(snapshot)
    }
    fn flush_streams(&self){
        let sink=self.transcript_sink.lock().unwrap().clone();let mut frames=Vec::new();let mut snapshots=Vec::new();let mut failed=Vec::new();
        {
            let mut sessions=self.sessions.lock().unwrap();if self.maintenance.load(Ordering::SeqCst){return;}
            let mut clocks=self.checkpoints.lock().unwrap();let at=now();
            for (id,clock) in clocks.iter_mut(){
                let Some(session)=sessions.get_mut(id) else {continue;};
                if clock.unsaved&&at.saturating_sub(clock.saved_at)>=1000 {
                    clock.saved_at=at;clock.unsaved=false;
                    if let Err(error)=self.persist(session){
                        session.error=Some(format!("执行记录保存失败：{error}"));session.requests.clear();session.revision+=1;
                        if let Some(run)=session.runs.last_mut(){run.state="failed".into();run.finished_at=Some(at);run.error=session.error.clone();}
                        clock.dirty=false;clock.base_revision=session.revision;failed.push(id.clone());snapshots.push(session.clone());continue;
                    }
                }
                if !clock.dirty {continue;}clock.dirty=false;
                if sink.is_some(){
                    // Only this turn crosses IPC; historical messages remain in the transcript store.
                    let start=session.messages.iter().rposition(|m|m.role=="user").map_or(0,|i|i+1);
                    frames.push(TranscriptFrame{id:id.clone(),base_revision:clock.base_revision,revision:session.revision,messages:session.messages[start..].to_vec()});
                }else{snapshots.push(session.clone());}
            }
        }
        for id in failed{self.runtimes.lock().unwrap().remove(&id);}
        for snapshot in snapshots{(self.sink)(&snapshot);}
        if let Some(sink)=sink{for frame in frames{sink(&frame);}}
    }
    pub fn create(&self, id: String, workspace_id: String, node_id: Option<String>, backend: String, title: String, cwd: Option<String>) -> Result<AgentSession> {
        if !valid_id(&id) || !valid_id(&workspace_id) || node_id.as_ref().is_some_and(|id| !valid_id(id)) {return Err("会话归属标识无效".into());}
        if !["codex", "claude", "pi"].contains(&backend.as_str()) {return Err("不支持的执行器".into());}
        if let Ok(existing) = self.session(&id) {if existing.workspace_id == workspace_id && existing.backend == backend {return Ok(existing);} return Err("会话标识已被占用".into());}
        if providers::discover(&backend).is_none() {return Err("未找到所选执行器，请先安装或确认 WSL 中的命令可用。".into());}
        let directory = if let Some(cwd) = cwd.filter(|s| !s.trim().is_empty()) {PathBuf::from(cwd)} else {let directory = self.root.join("workspaces").join(&workspace_id); fs::create_dir_all(&directory).map_err(|e| e.to_string())?; directory};
        let directory = directory.canonicalize().map_err(|e| format!("工作目录不可用：{e}"))?;
        if !directory.is_dir() {return Err("请选择文件夹作为工作目录".into());}
        let value = directory.to_string_lossy(); let cwd = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {format!(r"\\{unc}")} else {value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()};
        let session = AgentSession {id: id.clone(), workspace_id, node_id, backend, title: if title.trim().is_empty() {"新的会话".into()} else {title.chars().take(100).collect()}, cwd, source_id: None, created_at: now(), revision: 1, messages: Vec::new(), runs: Vec::new(), requests: Vec::new(), error: None};
        {let mut sessions=self.sessions.lock().map_err(|e|e.to_string())?;if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复会话，请稍后重试".into());}self.persist(&session)?;sessions.insert(id,session.clone());}(self.sink)(&session); Ok(session)
    }
    fn connect(self: &Arc<Self>, id: &str) -> Result<Arc<Rpc>> {
        if let Some(runtime) = self.runtimes.lock().map_err(|e| e.to_string())?.get(id).cloned() {return Ok(runtime);}
        let session = self.session(id)?;
        let provider = providers::discover(&session.backend).ok_or("未找到执行器")?;
        let tools=self.tools.lock().map_err(|e|e.to_string())?.clone().map(|tools|ToolConfig{command:tools.executable.to_string_lossy().into(),args:vec!["--northstar-mcp".into(),tools.root.to_string_lossy().into(),id.into()],definitions:tools.definitions});
        let (mut command, planned, token) = provider.command(&session.cwd, session.source_id.as_deref(), &self.root.join("provider-sessions"), tools.as_ref())?;
        let mut child = command.spawn().map_err(|e| format!("无法启动执行器：{e}"))?;
        let ownership = match process::Ownership::attach(&child, token) {Ok(owner) => owner, Err(error) => {let _ = child.kill(); let _ = child.wait(); return Err(error);}};
        let writer = child.stdin.take().ok_or("无法连接执行器输入")?;
        let stdout = child.stdout.take().ok_or("无法连接执行器输出")?;
        let stderr = child.stderr.take().ok_or("无法连接执行器错误流")?;
        // Drain diagnostics, without retaining provider configuration or credentials.
        let group = ownership.group.clone();
        std::thread::spawn(move || {for line in BufReader::new(stderr).lines() {match line {Ok(line) => group.observe(&line), Err(_) => break,}}});
        let pending = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<Value>>::new()));
        let rpc = Arc::new(Rpc {writer: Mutex::new(writer), child: Mutex::new(child), pending: pending.clone(), serial: AtomicU64::new(1), backend: session.backend.clone(), ownership});
        let owner = Arc::downgrade(self); let session_id = id.to_string();
        let backend = session.backend.clone();
        std::thread::spawn(move || read_protocol(stdout, pending, owner, session_id, backend));
        let source = match session.backend.as_str() {
            "codex" => {
                rpc.request("initialize", json!({"clientInfo":{"name":"northstar_workbench","title":"北极星","version":env!("CARGO_PKG_VERSION")}}))?;
                rpc.write(json!({"method":"initialized"}))?;
                let method = if session.source_id.is_some() {"thread/resume"} else {"thread/start"};
                let mut params = json!({"cwd":session.cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"});
                if let Some(tools)=&tools {params["config"]=json!({"mcp_servers":{"northstar":{"command":tools.command,"args":tools.args,"enabled":true,"startup_timeout_sec":15,"required":true}}});}
                if let Some(source) = session.source_id {params["threadId"] = json!(source);}
                rpc.request(method, params)?["thread"]["id"].as_str().ok_or("Codex 未返回来源会话标识")?.to_string()
            },
            "claude" => {rpc.request("initialize", json!({"hooks":{}}))?; planned.ok_or("缺少 Claude 会话标识")?},
            "pi" => {let result = rpc.request("get_state", json!({}))?; result["sessionFile"].as_str().map(String::from).or(planned).ok_or("缺少 Pi 会话文件")?},
            _ => return Err("执行器类型无效".into()),
        };
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
            if session.messages.is_empty() && session.title.starts_with("新的会话") {session.title = text.trim().lines().next().unwrap_or(text.trim()).chars().take(32).collect();}
            session.error = None;
            session.messages.push(Message {id: format!("{run_id}-user"), role: "user".into(), text: text.clone(), at: now()});
            session.runs.push(Run {id: run_id.clone(), state: "running".into(), started_at: now(), finished_at: None, source_turn_id: None, error: None, cancel_requested: false, context: None});
        })?;
        if rejected {return Err("此会话仍有执行未结束，或执行标识重复".into());}
        let host = self.clone(); let id = id.to_string();
        std::thread::spawn(move || {
            let result = (|| {
                let rpc = host.connect(&id)?; let session = host.session(&id)?;
                if session.runs.last().is_none_or(|r| r.state != "running" || r.cancel_requested) {return Ok(());}
                let source = if session.backend == "codex" {
                    let result = rpc.request("turn/start", json!({"threadId":session.source_id,"input":[{"type":"text","text":text}]}))?;
                    result["turn"]["id"].as_str().ok_or("Codex 未返回执行标识")?.to_string()
                } else {
                    host.update(&id, |s| {if let Some(run) = s.runs.last_mut() {run.source_turn_id = Some(run_id.clone());}})?;
                    if session.backend == "claude" {rpc.write(json!({"type":"user","message":{"role":"user","content":text},"parent_tool_use_id":null,"session_id":session.source_id}))?;}
                    else {let result = rpc.request("prompt", json!({"message":text}))?; if result["disposition"] == "handled" {host.update(&id, |s| {if let Some(run) = s.runs.last_mut().filter(|r| r.state == "running") {run.state = "succeeded".into(); run.finished_at = Some(now());}})?;}}
                    run_id.clone()
                };
                let after = host.update(&id, |s| {if let Some(run) = s.runs.iter_mut().find(|r| r.id == run_id) {run.source_turn_id = Some(source.clone());}})?;
                if after.runs.last().is_some_and(|r| r.state == "cancelled" || r.cancel_requested) {interrupt(&rpc, &after, Some(&source))?;}
                Ok(())
            })();
            if let Err(error) = result {if host.session(&id).is_ok_and(|s| s.runs.last().is_none_or(|r| r.state != "cancelled")) {let _ = host.fail(&id, error);} host.runtimes.lock().unwrap().remove(&id);}
        }); Ok(snapshot)
    }
    fn fail(&self, id: &str, error: String) -> Result<AgentSession> {self.update(id, |s| {s.error = Some(error.clone()); s.requests.clear(); if let Some(run) = s.runs.last_mut().filter(|r| ["running", "needs_input"].contains(&r.state.as_str())) {run.state = if run.cancel_requested {"cancelled"} else {"failed"}.into(); run.finished_at = Some(now()); run.error = (!run.cancel_requested).then_some(error); if run.cancel_requested {s.error = None;}}})}
    pub fn stop(&self, id: &str) -> Result<AgentSession> {
        let session = self.session(id)?;
        if let Some(_) = session.runs.last().filter(|r| ["running", "needs_input"].contains(&r.state.as_str())) {
            if session.runs.last().is_some_and(|r| r.cancel_requested) {return Ok(session);}
            let session = self.update(id, |s| {if let Some(run) = s.runs.last_mut().filter(|r| ["running", "needs_input"].contains(&r.state.as_str())) {run.cancel_requested = true;}})?;
            let Some(run) = session.runs.last().filter(|r| r.cancel_requested) else {return Ok(session);};
            let rpc = self.runtimes.lock().unwrap().get(id).cloned();
            let fallback = rpc.as_ref().is_some_and(|rpc| (session.backend != "codex" || run.source_turn_id.is_some()) && interrupt(rpc, &session, run.source_turn_id.as_deref()).is_err());
            let latest = self.session(id)?;
            if latest.runs.last().is_some_and(|r| !["running", "needs_input"].contains(&r.state.as_str())) {return Ok(latest);}
            // An accepted turn can precede the provider's active-turn registration.
            // If interrupt cannot address it yet, close this owned process instead.
            let stopped = self.update(id, |s| {s.requests.clear(); if let Some(run) = s.runs.last_mut() {if ["running", "needs_input"].contains(&run.state.as_str()) {run.state = "cancelled".into(); run.finished_at = Some(now());}}})?;
            if fallback {self.runtimes.lock().unwrap().remove(id);}
            drop(rpc); Ok(stopped)
        } else {Ok(session)}
    }
    pub fn respond(&self, id: &str, request_id: &str, answer: Value) -> Result<AgentSession> {
        let session = self.session(id)?;
        let request = session.requests.iter().find(|r| r.id == request_id).ok_or("请求已结束或不存在")?;
        let rpc = self.runtimes.lock().unwrap().get(id).cloned().ok_or("执行器已断开")?;
        let result = match request.kind.as_str() {
            "approval" => {let decision = answer["decision"].as_str().filter(|s| ["accept", "decline", "cancel"].contains(s)).ok_or("请选择允许或拒绝")?; json!({"decision":decision})},
            "input" => {if !answer["answers"].is_object() {return Err("回答内容无效".into());} answer},
            "elicitation" => {let action=answer["action"].as_str().filter(|action|["accept","decline","cancel"].contains(action)).ok_or("请选择允许或拒绝")?;if action=="accept" && !answer["content"].is_object(){return Err("表单内容无效".into());}json!({"action":action,"content":if action=="accept"{answer["content"].clone()}else{Value::Null}})},
            _ => return Err("请求类型暂不支持".into()),
        };
        rpc.write(if session.backend == "codex" {json!({"id":request.source_id,"result":result})} else {providers::response(&session.backend, request, result)?})?;
        self.update(id, |s| {s.requests.retain(|r| r.id != request_id); if s.requests.is_empty() {if let Some(run) = s.runs.last_mut().filter(|r| r.state == "needs_input") {run.state = "running".into();}}})
    }
    pub fn shutdown(&self) {if !self.maintenance.load(Ordering::SeqCst){let _=self.checkpoint_all();}if let Ok(mut runtimes) = self.runtimes.lock() {runtimes.clear();}}
    pub fn checkpoint_all(&self)->Result<()> {let ids=self.list()?.into_iter().map(|s|s.id).collect::<Vec<_>>();for id in ids {self.update(&id,|_|{})?;}Ok(())}
    pub fn prepare_restore(&self)->Result<()> {
        self.maintenance.store(true,Ordering::SeqCst);let active=self.sessions.lock().map_err(|e|e.to_string())?.values().any(|s|s.runs.iter().any(|r|["running","needs_input"].contains(&r.state.as_str())));
        if active {self.maintenance.store(false,Ordering::SeqCst);return Err("请先等待正在执行的会话结束，或停止它们，再恢复备份。".into());}self.shutdown();Ok(())
    }
    pub fn cancel_restore(&self){self.maintenance.store(false,Ordering::SeqCst);}
    fn event(&self, id: &str, value: &Value) {
        if let Some(backend)=self.sessions.lock().ok().and_then(|sessions|sessions.get(id).map(|s|s.backend.clone())) {if backend != "codex" {if providers::relevant(&backend, value) {let stream = value["type"] == "stream_event" || value["type"] == "message_update"; let _ = self.update_stream(id, stream, |s| providers::apply_event(s, value));} return;}}
        let method = value["method"].as_str().unwrap_or(""); let p = &value["params"];
        if value.get("id").is_some() && value.get("method").is_some() {
            let kind = if ["item/commandExecution/requestApproval","item/fileChange/requestApproval"].contains(&method) {"approval"} else if method=="mcpServer/elicitation/request" && p["mode"]=="form" {"elicitation"} else if method == "item/tool/requestUserInput" {"input"} else {"unsupported"};
            let title = p["message"].as_str().or(p["reason"].as_str()).or(p["command"].as_str()).unwrap_or(method).chars().take(2000).collect();
            let _ = self.update(id, |s| {let request_id = value["id"].to_string(); if !s.requests.iter().any(|r| r.id == request_id) {s.requests.push(Request {id: request_id, kind: kind.into(), title, payload: p.clone(), source_id: value["id"].clone()});} if let Some(run) = s.runs.last_mut() {run.state = "needs_input".into();}}); return;
        }
        if ["item/agentMessage/delta", "item/completed", "turn/started", "turn/completed", "error"].contains(&method) {
            let _ = self.update_stream(id, method == "item/agentMessage/delta", |s| apply_codex_event(s, method, p));
        }
    }
}
fn read_protocol(stdout: std::process::ChildStdout, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, host: Weak<AgentHost>, id: String, backend: String) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {break;}; let Ok(value) = serde_json::from_str::<Value>(&line) else {continue;};
        if let Some((key, reply)) = providers::reply(&backend, &value) {if let Some(sender) = pending.lock().unwrap().remove(&key) {let _ = sender.send(reply);}}
        else if let Some(host) = host.upgrade() {host.event(&id, &value);} else {break;}
    }
    pending.lock().unwrap().clear();
    if let Some(host) = host.upgrade() {if host.session(&id).is_ok_and(|s| s.runs.last().is_some_and(|r| ["running", "needs_input"].contains(&r.state.as_str()))) {let _ = host.fail(&id, "执行器连接已关闭，可继续此会话。".into());} host.runtimes.lock().unwrap().remove(&id);}
}
fn interrupt(rpc: &Rpc, session: &AgentSession, turn: Option<&str>) -> Result<()> {
    let (method, params) = match session.backend.as_str() {"codex" => ("turn/interrupt", json!({"threadId":session.source_id,"turnId":turn})), "claude" => ("interrupt", json!({})), "pi" => ("abort", json!({})), _ => return Err("执行器类型无效".into())};
    rpc.request(method, params).map(|_| ())
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
            if let Some(run) = s.runs.last_mut() {if run.state == "cancelled" {return;} run.state = if run.cancel_requested {"cancelled"} else {match p["turn"]["status"].as_str() {Some("completed") => "succeeded", Some("interrupted") => "cancelled", _ => "failed"}}.into(); run.finished_at = Some(now()); run.error = if run.cancel_requested {None} else {p["turn"]["error"]["message"].as_str().map(String::from)};}
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
pub fn backends() -> Vec<Backend> {["codex", "claude", "pi"].into_iter().map(|id| {let provider = providers::discover(id); Backend {id: id.into(), available: provider.is_some(), detail: provider.map(|p| format!("{} · {}", if p.wsl {"WSL"} else {"本机"}, id)).unwrap_or_else(|| "未安装或不可用".into())}}).collect()}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_and_undoing_a_node_only_changes_session_binding(){
        let root=std::env::temp_dir().join(format!("northstar-node-binding-{}",uuid::Uuid::new_v4()));let host=AgentHost::open(root.clone(),Arc::new(|_|{})).unwrap();let mut session=record();session.node_id=Some("node".into());session.messages.push(Message{id:"user".into(),role:"user".into(),text:"Keep prompt".into(),at:1});host.persist(&session).unwrap();host.sessions.lock().unwrap().insert("s".into(),session);
        let mut snapshot=json!({"spaces":[{"id":"w","nodes":[{"id":"root"}]}],"sessions":[{"id":"s","workspaceId":"w","nodeId":null}]});host.reconcile_nodes(&snapshot).unwrap();let detached=host.session("s").unwrap();assert!(detached.node_id.is_none());assert_eq!(detached.messages[0].text,"Keep prompt");assert_eq!(detached.runs[0].state,"running");assert_eq!(detached.source_id.as_deref(),Some("thread"));
        snapshot["spaces"][0]["nodes"]=json!([{"id":"node"}]);snapshot["sessions"][0]["nodeId"]=json!("node");host.reconcile_nodes(&snapshot).unwrap();assert_eq!(host.session("s").unwrap().node_id.as_deref(),Some("node"));
        host.shutdown();drop(host);assert_eq!(AgentHost::open(root,Arc::new(|_|{})).unwrap().session("s").unwrap().node_id.as_deref(),Some("node"));
    }
    fn record() -> AgentSession {AgentSession {id: "s".into(), workspace_id: "w".into(), node_id: None, backend: "codex".into(), title: "test".into(), cwd: String::new(), source_id: Some("thread".into()), created_at: 0, revision: 1, messages: vec![], requests: vec![], error: None, runs: vec![Run {id: "run".into(), state: "running".into(), started_at: 0, finished_at: None, source_turn_id: Some("turn".into()), error: None, cancel_requested: false, context: None}]}}
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
    fn restore_requires_idle_agents_and_blocks_updates_until_cancelled(){
        let root=std::env::temp_dir().join(format!("northstar-agent-restore-{}",uuid::Uuid::new_v4()));let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();host.sessions.lock().unwrap().insert("s".into(),record());assert!(host.prepare_restore().is_err());host.update("s",|s|s.runs[0].state="cancelled".into()).unwrap();host.prepare_restore().unwrap();assert!(host.update("s",|s|s.title="overwrite".into()).is_err());assert_eq!(host.session("s").unwrap().title,"test");host.cancel_restore();host.update("s",|s|s.title="after".into()).unwrap();
    }
    #[test]
    fn sparse_stream_publishes_without_another_token_and_omits_history() {
        let root=std::env::temp_dir().join(format!("northstar-stream-frame-{}",uuid::Uuid::new_v4()));
        let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();let mut session=record();
        session.messages=(0..1000).map(|i|Message{id:format!("old-{i}"),role:"assistant".into(),text:"history ".repeat(100),at:0}).collect();
        session.messages.push(Message{id:"run-user".into(),role:"user".into(),text:"raw prompt".into(),at:1});
        host.sessions.lock().unwrap().insert("s".into(),session);let base=host.update("s",|_|{}).unwrap().revision;
        let (tx,rx)=mpsc::channel();host.configure_transcript_sink(Arc::new(move|frame|{let _=tx.send(frame.clone());}));
        host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"first token"}))).unwrap();
        let frame=rx.recv_timeout(Duration::from_millis(500)).expect("a paused stream must still reach the UI");
        assert_eq!(frame.base_revision,base);assert_eq!(frame.messages.len(),1);assert_eq!(frame.messages[0].text,"first token");
        let compact=serde_json::to_vec(&frame).unwrap().len();let full=serde_json::to_vec(&host.session("s").unwrap()).unwrap().len();
        assert!(compact*100<full,"stream IPC must not carry the history");
    }
    #[test]
    fn quiet_stream_is_checkpointed_and_disk_failure_stops_it() {
        let root=std::env::temp_dir().join(format!("northstar-stream-checkpoint-{}",uuid::Uuid::new_v4()));
        let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();host.sessions.lock().unwrap().insert("s".into(),record());
        host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"saved partial reply"}))).unwrap();
        host.flush_streams();
        let saved:String=host.db.lock().unwrap().query_row("select data from agent_sessions where id='s'",[],|row|row.get(0)).unwrap();
        assert!(saved.contains("saved partial reply"));
        host.db.lock().unwrap().execute_batch("PRAGMA query_only=ON").unwrap();
        host.update_stream("s",true,|s|s.messages[0].text.push_str(" unsaved")).unwrap();
        host.checkpoints.lock().unwrap().get_mut("s").unwrap().saved_at=0;host.flush_streams();
        assert_eq!(host.session("s").unwrap().runs[0].state,"failed");assert!(host.session("s").unwrap().error.unwrap().contains("保存失败"));
    }
    #[test]
    fn stream_is_coalesced_but_terminal_update_flushes_every_delta() {
        let dir = std::env::temp_dir().join(format!("northstar-stream-test-{}",uuid::Uuid::new_v4()));
        let count=Arc::new(AtomicU64::new(0));let calls=count.clone();let host=AgentHost::open(dir.clone(),Arc::new(move |_| {calls.fetch_add(1,Ordering::SeqCst);})).unwrap();
        host.sessions.lock().unwrap().insert("s".into(),record());
        for _ in 0..100 {host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"x"}))).unwrap();}
        assert!(count.load(Ordering::SeqCst)<100);
        host.update("s",|s|s.runs[0].state="succeeded".into()).unwrap();
        let restored=AgentHost::open(dir,Arc::new(|_|{})).unwrap().session("s").unwrap();assert_eq!(restored.messages[0].text.len(),100);assert_eq!(restored.runs[0].state,"succeeded");
    }
    #[test]
    fn failed_persistence_is_reported_and_never_published_as_success() {
        let dir = std::env::temp_dir().join(format!("northstar-agent-test-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(dir, Arc::new(|_| {})).unwrap(); host.sessions.lock().unwrap().insert("s".into(), record());
        host.db.lock().unwrap().execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(host.update("s", |s| {s.runs[0].state = "succeeded".into();}).is_err());
        let state = host.session("s").unwrap(); assert_eq!(state.runs[0].state, "failed"); assert!(state.error.as_deref().unwrap().contains("保存失败"));
    }
    #[test]
    fn stop_closes_an_unreachable_owned_runtime_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("northstar-agent-test-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(dir, Arc::new(|_| {})).unwrap(); host.sessions.lock().unwrap().insert("s".into(), record());
        let mut command = std::process::Command::new(std::env::current_exe().unwrap()); command.arg("--help").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
        let mut child = command.spawn().unwrap(); let writer = child.stdin.take().unwrap(); child.wait().unwrap();
        host.runtimes.lock().unwrap().insert("s".into(), Arc::new(Rpc {writer: Mutex::new(writer), child: Mutex::new(child), pending: Arc::new(Mutex::new(HashMap::new())), serial: AtomicU64::new(1), backend: "codex".into(), ownership: process::Ownership::empty()}));
        assert_eq!(host.stop("s").unwrap().runs[0].state, "cancelled"); assert!(host.runtimes.lock().unwrap().is_empty()); assert_eq!(host.stop("s").unwrap().runs[0].state, "cancelled");
    }
}
