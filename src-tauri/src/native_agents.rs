use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{OnceLock, RwLock};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command}, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc}, time::{Duration, Instant}};
#[path = "agent_providers.rs"]
mod providers;
#[cfg(target_os = "macos")]
pub use providers::adopt_login_shell_path;
#[path = "agent_process.rs"]
mod process;
#[path = "codex_feedback.rs"]
mod feedback;
#[path = "codex_options.rs"]
mod options;
#[path = "claude_model_options.rs"]
mod claude_options;
#[path = "pi_model_options.rs"]
mod pi_options;
#[path = "pi_transcript_repair.rs"]
mod pi_transcript_repair;
#[path = "chat_files.rs"]
mod chat_files;
pub use chat_files::{ChatFile, FileSuggestion};
pub use feedback::{Activity, RunPhase};
pub use options::ModelOptions;

pub type Result<T> = std::result::Result<T, String>;
pub type Sink = Arc<dyn Fn(&AgentSession) + Send + Sync>;
pub type TranscriptSink = Arc<dyn Fn(&TranscriptFrame) + Send + Sync>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFrame {
    pub id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity: Option<TranscriptActivityFrame>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptActivityFrame {run_id: String, items: Vec<Activity>}
#[derive(Default)]
struct Checkpoint {saved_at:u64,base_revision:u64,dirty:bool,unsaved:bool}
fn now() -> u64 {chrono::Utc::now().timestamp_millis() as u64}
fn valid_id(id: &str) -> bool {!id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {pub id: String, pub role: String, pub text: String, pub at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub files: Vec<ChatFile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String, pub state: String, pub started_at: u64, pub finished_at: Option<u64>, pub source_turn_id: Option<String>, pub error: Option<String>,
    #[serde(default)] pub cancel_requested: bool,
    #[serde(default)] pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub phase: Option<RunPhase>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub activity: Vec<Activity>,
    #[serde(skip)] pi_messages: PiMessageSequence,
}

#[derive(Clone, Default)]
struct PiMessageSequence {
    last: u32,
    active: Option<u32>,
}

impl PiMessageSequence {
    fn start(&mut self) -> u32 {
        self.last = self.last.saturating_add(1);
        self.active = Some(self.last);
        self.last
    }

    fn current(&mut self) -> u32 {
        match self.active {
            Some(ordinal) => ordinal,
            None => self.start(),
        }
    }

    fn finish(&mut self) {self.active = None;}
}
impl Run {
    fn advance_phase(&mut self, phase: RunPhase) {self.phase = self.phase.max(Some(phase));}
    fn settle_activity(&mut self) {feedback::settle(&mut self.activity, &self.state);}
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {pub id: String, pub kind: String, pub title: String, pub payload: Value, pub source_id: Value}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String, pub workspace_id: String, pub node_id: Option<String>, pub backend: String, pub title: String,
    pub cwd: String, pub source_id: Option<String>, pub created_at: u64, pub revision: u64,
    pub messages: Vec<Message>, pub runs: Vec<Run>, pub requests: Vec<Request>, pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_effort: Option<String>,
}
fn mark_host_exit(session: &mut AgentSession) {
    let mut changed = false;
    for run in &mut session.runs {
        if ["running", "needs_input"].contains(&run.state.as_str()) {
            run.state = if run.cancel_requested {"cancelled"} else {"interrupted"}.into();
            run.finished_at = Some(now());
        } else if run.state == "failed" && run.error.as_deref() == Some("上次执行随宿主退出而中断，可继续此会话。") {
            run.state = "interrupted".into();
        } else {continue;}
        run.error = None;
        run.settle_activity();
        changed = true;
    }
    if changed {session.requests.clear(); session.revision += 1;}
}
#[derive(Serialize)]
pub struct Backend {pub id: String, pub available: bool, pub detail: String}
#[derive(Clone)]
pub struct WorkspaceTools {pub executable: PathBuf, pub root: PathBuf, pub definitions: Value}
pub struct ToolConfig {pub command: String, pub args: Vec<String>, pub definitions: Value}
#[derive(Default)]
struct ReaderOwner {
    startup_run: String,
    attached: AtomicBool,
    retired: AtomicBool,
}
impl ReaderOwner {
    fn applies_to(&self, session: &AgentSession) -> bool {
        !self.retired.load(Ordering::SeqCst) && (self.attached.load(Ordering::SeqCst)
            || session.runs.last().is_some_and(|run| run.id == self.startup_run))
    }
}
struct Rpc {
    writer: Mutex<ChildStdin>, child: Mutex<Child>, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, serial: AtomicU64,
    backend: String,
    ownership: process::Ownership,
    reader: Arc<ReaderOwner>,
}
impl Drop for Rpc {fn drop(&mut self) {self.ownership.group.stop(); if let Ok(child) = self.child.get_mut() {let _ = child.kill(); let _ = child.wait();}}}
impl Rpc {
    fn start(mut command: Command, backend: String, token: Option<String>, events: Option<(Weak<AgentHost>, String, String)>) -> Result<Arc<Self>> {
        let mut child = command.spawn().map_err(|e| format!("无法启动执行器：{e}"))?;
        let ownership = match process::Ownership::attach(&child, token) {
            Ok(owner) => owner,
            Err(error) => {let _ = child.kill(); let _ = child.wait(); return Err(error);}
        };
        let writer = child.stdin.take().ok_or("无法连接执行器输入")?;
        let stdout = child.stdout.take().ok_or("无法连接执行器输出")?;
        let stderr = child.stderr.take().ok_or("无法连接执行器错误流")?;
        // Drain diagnostics, without retaining provider configuration or credentials.
        let group = ownership.group.clone();
        std::thread::spawn(move || {for line in BufReader::new(stderr).lines() {match line {Ok(line) => group.observe(&line), Err(_) => break,}}});
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader = Arc::new(ReaderOwner {startup_run: events.as_ref().map(|(_, _, run)| run.clone()).unwrap_or_default(), ..Default::default()});
        let rpc = Arc::new(Self {writer: Mutex::new(writer), child: Mutex::new(child), pending: pending.clone(), serial: AtomicU64::new(1), backend: backend.clone(), ownership,reader:reader.clone()});
        std::thread::spawn(move || read_protocol(stdout, pending, events, backend, reader));
        Ok(rpc)
    }
    fn terminate(&self) {
        self.ownership.group.stop();
        if let Ok(mut child) = self.child.lock() {let _ = child.kill();}
    }
    fn write(&self, value: Value) -> Result<()> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *writer, &value).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").and_then(|_| writer.flush()).map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, Duration::from_secs(if ["turn/interrupt", "interrupt", "abort"].contains(&method) {5} else {45}))
    }
    fn request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(); self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        if let Err(error) = self.write(providers::wire_request(&self.backend, id, method, params)) {self.pending.lock().unwrap().remove(&id); return Err(error);}
        let reply = rx.recv_timeout(timeout); self.pending.lock().unwrap().remove(&id);
        let reply = reply.map_err(|_| format!("{method} 未收到执行器响应"))?;
        if let Some(error) = reply.get("error") {return Err(error.get("message").and_then(Value::as_str).unwrap_or("执行器请求失败").to_string());}
        Ok(reply["result"].clone())
    }
    fn initialize_codex(&self, timeout: Duration) -> Result<()> {
        self.request_with_timeout("initialize", json!({"clientInfo":{"name":"northstar_workbench","title":"Draftway","version":env!("CARGO_PKG_VERSION")}}), timeout)?;
        self.write(json!({"method":"initialized"}))
    }
}
type ModelCatalogKey = (String, String, Option<String>);
type CatalogFlight = Arc<OnceLock<Result<ModelOptions>>>;
pub type ModelCatalogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;
const CATALOG_FRESH_FOR: Duration = Duration::from_secs(300);
const CATALOG_SAVED_FOR_MS: u64 = 24 * 60 * 60 * 1000;

struct CachedModelCatalog {
    saved_at: u64,
    checked_at: Option<Instant>,
    options: ModelOptions,
}
impl CachedModelCatalog {
    fn fresh(&self) -> bool {self.checked_at.is_some_and(|at| at.elapsed() < CATALOG_FRESH_FOR)}
}

#[derive(Default)]
struct ModelCatalogEntry {
    cached: Option<CachedModelCatalog>,
    flight: Option<CatalogFlight>,
}

pub struct AgentHost {
    root: PathBuf, db: Mutex<Connection>, sessions: Mutex<HashMap<String, AgentSession>>, runtimes: Mutex<HashMap<String, Arc<Rpc>>>, sink: Sink,
    checkpoints: Mutex<HashMap<String, Checkpoint>>,
    transcript_sink:Mutex<Option<TranscriptSink>>,
    tools: Mutex<Option<WorkspaceTools>>,
    model_catalogs: Mutex<HashMap<ModelCatalogKey, ModelCatalogEntry>>,
    workspace_probe_gate: RwLock<()>,
    model_catalog_sink: Mutex<Option<ModelCatalogSink>>,
    maintenance: AtomicBool,
}
impl AgentHost {
    pub fn open(root: PathBuf, sink: Sink) -> Result<Arc<Self>> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let db = Connection::open(root.join("agent-sessions.sqlite3")).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE TABLE IF NOT EXISTS agent_model_catalog(backend TEXT NOT NULL, cwd TEXT NOT NULL, saved_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (backend,cwd));").map_err(|e| e.to_string())?;
        let mut sessions = HashMap::new();
        {let mut query = db.prepare("SELECT data FROM agent_sessions").map_err(|e| e.to_string())?;
        for row in query.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
            let mut session: AgentSession = serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            mark_host_exit(&mut session);
            if pi_transcript_repair::repair(&mut session, &root.join("provider-sessions")) {session.revision += 1;}
            sessions.insert(session.id.clone(), session);
        }}
        let mut catalogs = HashMap::new();
        {
            let oldest = now().saturating_sub(CATALOG_SAVED_FOR_MS);
            let _ = db.execute("DELETE FROM agent_model_catalog WHERE saved_at < ?1", [oldest]);
            let mut query = db.prepare("SELECT backend,cwd,saved_at,data FROM agent_model_catalog ORDER BY saved_at DESC LIMIT 80").map_err(|e| e.to_string())?;
            let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?, row.get::<_, String>(3)?))).map_err(|e| e.to_string())?;
            for (backend, cwd, saved_at, data) in rows.flatten() {
                if saved_at >= oldest {
                    if let Ok((mut options, scope)) = serde_json::from_str::<(ModelOptions, Vec<String>)>(&data) {
                        options.picker_scope = scope;
                        catalogs.insert((backend, cwd, None), ModelCatalogEntry {cached: Some(CachedModelCatalog {saved_at, checked_at: None, options}), flight: None});
                    }
                }
            }
        }
        let host = Arc::new(Self {root, db: Mutex::new(db), sessions: Mutex::new(sessions), runtimes: Mutex::new(HashMap::new()), sink, checkpoints: Mutex::new(HashMap::new()), transcript_sink:Mutex::new(None),tools: Mutex::new(None),model_catalogs:Mutex::new(catalogs),workspace_probe_gate:RwLock::new(()),model_catalog_sink:Mutex::new(None),maintenance:AtomicBool::new(false)});
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
    pub fn rename(&self, id: &str, title: &str) -> Result<AgentSession> {
        let title=title.trim();if title.is_empty() || title.chars().count()>100 || title.contains(['\r','\n']) {return Err("会话名称须为 1–100 个字符，且不能换行。".into());}
        let snapshot={let mut sessions=self.sessions.lock().map_err(|e|e.to_string())?;
            if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复会话，请稍后重试".into());}
            let mut session=sessions.get(id).cloned().ok_or("会话不存在")?;session.title=title.into();session.revision+=1;
            self.persist(&session)?;sessions.insert(id.into(),session.clone());session};
        (self.sink)(&snapshot);Ok(snapshot)
    }
    pub fn delete(&self, ids: &[String], workspace_id: Option<&str>) -> Result<Vec<String>> {
        let mut sessions=self.sessions.lock().map_err(|e|e.to_string())?;
        if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复会话，请稍后重试".into());}
        let targets:Vec<String>=sessions.values().filter(|s|ids.contains(&s.id)||workspace_id==Some(s.workspace_id.as_str())).map(|s|s.id.clone()).collect();
        if targets.iter().any(|id|sessions[id].runs.iter().any(|r|["running","needs_input"].contains(&r.state.as_str()))) {return Err("请先停止正在执行或等待输入的会话，再删除。".into());}
        let mut db=self.db.lock().map_err(|e|e.to_string())?;let tx=db.transaction().map_err(|e|e.to_string())?;
        for id in &targets {tx.execute("DELETE FROM agent_sessions WHERE id=?1",[id]).map_err(|e|e.to_string())?;}
        tx.commit().map_err(|e|e.to_string())?;
        let mut clocks=self.checkpoints.lock().map_err(|e|e.to_string())?;
        let mut runtimes=self.runtimes.lock().map_err(|e|e.to_string())?;
        for id in &targets {sessions.remove(id);clocks.remove(id);if let Some(runtime)=runtimes.remove(id){runtime.ownership.group.stop();}}
        Ok(targets)
    }
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
            let session = sessions.get_mut(id).ok_or("会话不存在")?;
            let phase = session.runs.last().and_then(|run| run.phase);
            change(session); session.revision += 1;
            if let Some(run) = session.runs.last_mut() {run.settle_activity();}
            let mut clocks=self.checkpoints.lock().map_err(|e|e.to_string())?;let clock=clocks.entry(id.into()).or_default();
            // The lifecycle snapshot carries the first response phase; subsequent text stays on the compact stream.
            if stream && phase == session.runs.last().and_then(|run| run.phase) {clock.dirty=true;clock.unsaved=true;return Ok(None);}
            *clock=Checkpoint{saved_at:now(),base_revision:session.revision,..Default::default()};
            let saved = self.persist(session);
            if let Err(error) = &saved {session.error = Some(format!("执行记录保存失败：{error}")); session.requests.clear(); if let Some(run) = session.runs.last_mut() {run.state = "failed".into(); run.finished_at = Some(now()); run.error = session.error.clone(); run.settle_activity();}}
            (Some(session.clone()), saved)
        };
        if saved.is_err() {self.retire_runtime(id, None);}
        if let Some(snapshot)=&snapshot{(self.sink)(snapshot);} saved?; Ok(snapshot)
    }
    fn flush_streams(&self){
        let mut frames=Vec::new();let mut snapshots=Vec::new();let mut failed=Vec::new();
        let sink = {
            let mut sessions=self.sessions.lock().unwrap();if self.maintenance.load(Ordering::SeqCst){return;}
            let sink=self.transcript_sink.lock().unwrap().clone();
            let mut clocks=self.checkpoints.lock().unwrap();let at=now();
            for (id,clock) in clocks.iter_mut(){
                let Some(session)=sessions.get_mut(id) else {continue;};
                if clock.unsaved&&at.saturating_sub(clock.saved_at)>=1000 {
                    clock.saved_at=at;clock.unsaved=false;
                    if let Err(error)=self.persist(session){
                        session.error=Some(format!("执行记录保存失败：{error}"));session.requests.clear();session.revision+=1;
                        if let Some(run)=session.runs.last_mut(){run.state="failed".into();run.finished_at=Some(at);run.error=session.error.clone();run.settle_activity();}
                        clock.dirty=false;clock.base_revision=session.revision;failed.push(id.clone());snapshots.push(session.clone());continue;
                    }
                }
                if !clock.dirty {continue;}clock.dirty=false;
                if sink.is_some(){
                    // Only this turn crosses IPC; historical messages remain in the transcript store.
                    let start=session.messages.iter().rposition(|m|m.role=="user").map_or(0,|i|i+1);
                    let activity = session.runs.last().and_then(|run| {
                        let items: Vec<_> = feedback::live_output(&run.activity).cloned().collect();
                        (!items.is_empty()).then(|| TranscriptActivityFrame {run_id: run.id.clone(), items})
                    });
                    frames.push(TranscriptFrame{id:id.clone(),base_revision:clock.base_revision,revision:session.revision,messages:session.messages[start..].to_vec(),activity});
                }else{snapshots.push(session.clone());}
            }
            sink
        };
        for id in failed{self.retire_runtime(&id, None);}
        for snapshot in snapshots{(self.sink)(&snapshot);}
        if let Some(sink)=sink{for frame in frames{sink(&frame);}}
    }
    pub fn create(&self, id: String, workspace_id: String, node_id: Option<String>, backend: String, title: String, cwd: Option<String>) -> Result<AgentSession> {
        if !valid_id(&id) || !valid_id(&workspace_id) || node_id.as_ref().is_some_and(|id| !valid_id(id)) {return Err("会话归属标识无效".into());}
        if !["codex", "claude", "pi"].contains(&backend.as_str()) {return Err("不支持的执行器".into());}
        if let Ok(existing) = self.session(&id) {if existing.workspace_id == workspace_id && existing.backend == backend {return Ok(existing);} return Err("会话标识已被占用".into());}
        if providers::discover(&backend).is_none() {return Err("未找到所选执行器，请先安装或确认 WSL 中的命令可用。".into());}
        let cwd = self.workspace_cwd(&workspace_id, cwd)?;
        let session = AgentSession {id: id.clone(), workspace_id, node_id, backend, title: if title.trim().is_empty() {"新的会话".into()} else {title.chars().take(100).collect()}, cwd, source_id: None, created_at: now(), revision: 1, messages: Vec::new(), runs: Vec::new(), requests: Vec::new(), error: None, effective_model: None, effective_effort: None};
        {let mut sessions=self.sessions.lock().map_err(|e|e.to_string())?;if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复会话，请稍后重试".into());}self.persist(&session)?;sessions.insert(id,session.clone());}(self.sink)(&session); Ok(session)
    }
    fn workspace_cwd(&self, workspace_id: &str, cwd: Option<String>) -> Result<String> {
        let _probe = self.workspace_probe_gate.read().map_err(|e| e.to_string())?;
        if self.maintenance.load(Ordering::SeqCst) {return Err("正在恢复会话，请稍后重试".into());}
        let directory = if let Some(cwd) = cwd.filter(|s| !s.trim().is_empty()) {PathBuf::from(cwd)} else {let directory = self.root.join("workspaces").join(workspace_id); fs::create_dir_all(&directory).map_err(|e| e.to_string())?; directory};
        let directory = directory.canonicalize().map_err(|e| format!("工作目录不可用：{e}"))?;
        if !directory.is_dir() {return Err("请选择文件夹作为工作目录".into());}
        let value = directory.to_string_lossy();
        Ok(if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {format!(r"\\{unc}")} else {value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()})
    }
    fn model_catalog_key(session: &AgentSession) -> ModelCatalogKey {
        let source = session.source_id.clone().filter(|_| session.backend == "codex" && session.effective_model.is_none());
        (session.backend.clone(), session.cwd.clone(), source)
    }
    fn cached_model_catalog(&self, key: &ModelCatalogKey) -> Result<Option<ModelOptions>> {
        let catalogs = self.model_catalogs.lock().map_err(|e| e.to_string())?;
        Ok(catalogs.get(key).and_then(|entry| entry.cached.as_ref()).filter(|cached| cached.fresh()).map(|cached| cached.options.clone()))
    }
    fn effective_model_options(mut catalog: ModelOptions, session: &AgentSession) -> ModelOptions {
        if session.effective_model.is_some() {
            if catalog.model != session.effective_model || session.effective_effort.is_some() {
                catalog.effort = session.effective_effort.clone();
            }
            catalog.model = session.effective_model.clone();
        }
        catalog
    }
    pub fn configure_model_catalog_sink(&self, sink: ModelCatalogSink) {
        if let Ok(mut stored) = self.model_catalog_sink.lock() {*stored = Some(sink);}
    }
    fn fetch_model_catalog(&self, (backend, cwd, thread_id): &ModelCatalogKey) -> Result<ModelOptions> {
        let _probe = self.workspace_probe_gate.read().map_err(|e| e.to_string())?;
        if self.maintenance.load(Ordering::SeqCst) {return Err("正在恢复会话，请稍后重试".into());}
        let provider = providers::discover(backend).ok_or("未找到本机或 WSL 执行器")?;
        let (command, _, token) = provider.command(cwd, None, &self.root.join("provider-sessions"), None, true, (None, None))?;
        let rpc = Rpc::start(command, backend.clone(), token, None)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        match backend.as_str() {
            "codex" => {
                rpc.initialize_codex(deadline.saturating_duration_since(Instant::now()))?;
                let request = |method: &str, params| rpc.request_with_timeout(method, params, deadline.saturating_duration_since(Instant::now()));
                let mut catalog = ModelOptions::read(cwd, request)?;
                if let Some(thread_id) = thread_id {
                    if let Ok(result) = request("thread/read", json!({"threadId": thread_id, "includeTurns": false})) {
                        let thread = &result["thread"];
                        if let Some(model) = options::string(thread, "model") {
                            catalog.model = Some(model);
                            catalog.effort = options::string(thread, "reasoningEffort");
                        }
                    }
                }
                Ok(catalog)
            },
            "claude" => claude_options::read(&rpc, deadline),
            "pi" => pi_options::read(&rpc, deadline, |models| provider.pi_model_scope(cwd, models)),
            _ => Err("执行器类型无效".into()),
        }
    }
    fn finish_model_catalog(&self, key: &ModelCatalogKey, flight: &CatalogFlight) -> Result<ModelOptions> {
        flight.get_or_init(|| {
            let outcome = self.fetch_model_catalog(key);
            let saved_at = now();
            if let Ok(options) = &outcome {
                if key.2.is_none() && !self.maintenance.load(Ordering::SeqCst) {
                    if let (Ok(data), Ok(db)) = (serde_json::to_string(&(options, &options.picker_scope)), self.db.lock()) {
                        let _ = db.execute("INSERT INTO agent_model_catalog(backend,cwd,saved_at,data) VALUES(?1,?2,?3,?4)
                            ON CONFLICT(backend,cwd) DO UPDATE SET saved_at=excluded.saved_at,data=excluded.data", params![key.0,key.1,saved_at,data]);
                    }
                }
            }
            if let Ok(mut catalogs) = self.model_catalogs.lock() {
                if let Some(entry) = catalogs.get_mut(key) {
                    entry.flight = None;
                    if let Ok(options) = &outcome {
                        entry.cached = Some(CachedModelCatalog {saved_at, checked_at: Some(Instant::now()), options: options.clone()});
                    }
                }
            }
            if outcome.is_ok() {
                let sink = self.model_catalog_sink.lock().ok().and_then(|sink| sink.clone());
                if let Some(sink) = sink {sink(&key.0, &key.1);}
            }
            outcome
        }).clone()
    }
    fn model_catalog(self: &Arc<Self>, key: ModelCatalogKey, wait_for_refresh: bool) -> Result<ModelOptions> {
        let (previous, flight, started) = {
            let mut catalogs = self.model_catalogs.lock().map_err(|e| e.to_string())?;
            let oldest = now().saturating_sub(CATALOG_SAVED_FOR_MS);
            catalogs.retain(|_, entry| entry.flight.is_some() || entry.cached.as_ref().is_some_and(|row| row.saved_at >= oldest));
            let entry = catalogs.entry(key.clone()).or_default();
            if let Some(cached) = entry.cached.as_ref().filter(|row| row.fresh()) {return Ok(cached.options.clone());}
            let previous = entry.cached.as_ref().map(|row| row.options.clone());
            let started = entry.flight.is_none();
            let flight = entry.flight.get_or_insert_with(|| Arc::new(OnceLock::new())).clone();
            (previous, flight, started)
        };
        if let Some(previous) = previous.filter(|_| !wait_for_refresh) {
            if started {
                let host = self.clone();
                std::thread::spawn(move || {let _ = host.finish_model_catalog(&key, &flight);});
            }
            return Ok(previous);
        }
        self.finish_model_catalog(&key, &flight)
    }
    pub fn prefetch_model_options(self: &Arc<Self>, backend: String, workspace_id: String, cwd: Option<String>) -> Result<()> {
        if !valid_id(&workspace_id) || !["codex", "claude", "pi"].contains(&backend.as_str()) {return Err("执行器或工作区无效".into());}
        let cwd = self.workspace_cwd(&workspace_id, cwd)?;
        self.model_catalog((backend, cwd, None), true).map(|_| ())
    }
    pub fn model_options(self: &Arc<Self>, id: &str) -> Result<ModelOptions> {
        let session = self.session(id)?;
        let catalog = self.model_catalog(Self::model_catalog_key(&session), false)?;
        let mut catalog = Self::effective_model_options(catalog, &self.session(id)?);
        if !catalog.picker_scope.is_empty() {
            let scoped = catalog.picker_scope.iter()
                .filter_map(|id| catalog.models.iter().find(|model| &model.model == id).cloned())
                .collect::<Vec<_>>();
            if !scoped.is_empty() {catalog.models = scoped;}
        }
        Ok(catalog)
    }
    fn connect(self: &Arc<Self>, id: &str, run_id: &str, selection: (Option<&str>, Option<&str>)) -> Result<(Arc<Rpc>, Option<String>)> {
        if let Some(runtime) = self.runtimes.lock().map_err(|e| e.to_string())?.get(id).cloned() {return Ok((runtime, None));}
        let session = self.session(id)?;
        let provider = providers::discover(&session.backend).ok_or("未找到执行器")?;
        let tools=self.tools.lock().map_err(|e|e.to_string())?.clone().map(|tools|ToolConfig{command:tools.executable.to_string_lossy().into(),args:vec!["--northstar-mcp".into(),tools.root.to_string_lossy().into(),id.into()],definitions:tools.definitions});
        let (command, planned, token) = provider.command(&session.cwd, session.source_id.as_deref(), &self.root.join("provider-sessions"), tools.as_ref(), false, selection)?;
        let rpc = Rpc::start(command, session.backend.clone(), token, Some((Arc::downgrade(self), id.to_string(), run_id.to_owned())))?;
        let mut effective_model = None;
        let mut effective_effort = None;
        let source = match session.backend.as_str() {
            "codex" => {
                rpc.initialize_codex(Duration::from_secs(45))?;
                let method = if session.source_id.is_some() {"thread/resume"} else {"thread/start"};
                let mut params = json!({"cwd":session.cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"});
                if let Some(tools)=&tools {params["config"]=json!({"mcp_servers":{"northstar":{"command":tools.command,"args":tools.args,"enabled":true,"startup_timeout_sec":15,"required":true}}});}
                if let Some(source) = session.source_id {params["threadId"] = json!(source);}
                let thread = rpc.request(method, params)?;
                effective_model = options::string(&thread, "model");
                effective_effort = options::string(&thread, "reasoningEffort");
                thread["thread"]["id"].as_str().ok_or("Codex 未返回来源会话标识")?.to_string()
            },
            "claude" => planned.ok_or("缺少 Claude 会话标识")?,
            "pi" => {
                let result = rpc.request("get_state", json!({}))?;
                (effective_model, effective_effort) = pi_options::effective(&result);
                result["sessionFile"].as_str().map(String::from).or(planned).ok_or("缺少 Pi 会话文件")?
            },
            _ => return Err("执行器类型无效".into()),
        };
        let claude_launch = (session.backend == "claude").then(|| source.clone());
        let mut attached = false;
        self.update(id, |session| {
            if rpc.reader.retired.load(Ordering::SeqCst) || session.runs.last().is_none_or(|run| {
                run.id != run_id || !["running", "needs_input"].contains(&run.state.as_str()) || run.cancel_requested
            }) {return;}
            // Claude's init event confirms the ID once its transcript exists.
            if claude_launch.is_none() {session.source_id = Some(source);}
            session.error = None;
            if effective_model.is_some() || session.backend == "claude" {
                session.effective_model = effective_model;
                session.effective_effort = effective_effort;
            }
            self.runtimes.lock().unwrap().insert(id.to_owned(), rpc.clone());
            rpc.reader.attached.store(true, Ordering::SeqCst);
            attached = true;
        })?;
        if !attached {
            rpc.reader.retired.store(true, Ordering::SeqCst);
            return Err("执行已结束，可继续此会话。".into());
        }
        Ok((rpc, claude_launch))
    }
    fn retire_runtime(&self, id: &str, owner: Option<&ReaderOwner>) -> Option<Arc<Rpc>> {
        let mut runtimes = self.runtimes.lock().unwrap();
        if owner.is_some_and(|expected| runtimes.get(id).is_none_or(|current| !std::ptr::eq(&*current.reader, expected))) {
            return None;
        }
        let rpc = runtimes.remove(id)?;
        rpc.reader.retired.store(true, Ordering::SeqCst);
        Some(rpc)
    }
    pub fn send(self: &Arc<Self>, id: &str, run_id: String, text: String) -> Result<AgentSession> {
        self.send_with_options(id, run_id, text, None, None, Vec::new())
    }
    pub fn suggest_files(&self, id: &str, query: &str) -> Result<Vec<FileSuggestion>> {
        let _probe = self.workspace_probe_gate.read().map_err(|e| e.to_string())?;
        if self.maintenance.load(Ordering::SeqCst) {return Err("正在恢复会话，请稍后重试".into());}
        let session = self.session(id)?;
        chat_files::suggestions(Path::new(&session.cwd), query)
    }
    pub fn send_with_options(self: &Arc<Self>, id: &str, run_id: String, text: String, model: Option<String>, effort: Option<String>, files: Vec<ChatFile>) -> Result<AgentSession> {
        if (text.trim().is_empty() && files.is_empty()) || text.len() > 100_000 || !valid_id(&run_id) {return Err("消息内容或执行标识无效".into());}
        let session = self.session(id)?;
        if session.runs.iter().any(|r| ["running", "needs_input"].contains(&r.state.as_str())) {return Err("此会话仍有执行未结束".into());}
        if session.runs.iter().any(|r| r.id == run_id) {return Ok(session);}
        if model.is_some() || effort.is_some() {
            if [model.as_deref(), effort.as_deref()].into_iter().flatten().any(|value| {
                value.is_empty() || value.len() > 200 || value.starts_with('-') || value.trim() != value || value.chars().any(char::is_control)
            }) {return Err("模型或推理强度无效".into());}
            if let Some(catalog) = self.cached_model_catalog(&Self::model_catalog_key(&session))? {
                Self::effective_model_options(catalog, &session).validate(model.as_deref(), effort.as_deref())?;
            }
        }
        let prepared = {
            let _probe = self.workspace_probe_gate.read().map_err(|e| e.to_string())?;
            if self.maintenance.load(Ordering::SeqCst) {return Err("正在恢复会话，请稍后重试".into());}
            chat_files::prepare(Path::new(&session.cwd), &text, files)?
        };
        let mut rejected = false;
        let snapshot = self.update(id, |session| {
            if session.runs.iter().any(|r| ["running", "needs_input"].contains(&r.state.as_str()) || r.id == run_id) {rejected = true; return;}
            if session.messages.is_empty() && session.title.starts_with("新的会话") {
                let title = text.trim().lines().next().filter(|line| !line.is_empty())
                    .or_else(|| prepared.files.first().map(|file| file.name.as_str())).unwrap_or("新的会话");
                session.title = title.chars().take(32).collect();
            }
            session.error = None;
            session.messages.push(Message {id: format!("{run_id}-user"), role: "user".into(), text: text.clone(), at: now(), files: prepared.files.clone()});
            session.runs.push(Run {id: run_id.clone(), state: "running".into(), started_at: now(), finished_at: None, source_turn_id: None, error: None, cancel_requested: false, context: None, phase: matches!(session.backend.as_str(), "codex" | "pi").then_some(RunPhase::Connecting), activity: Vec::new(), pi_messages: PiMessageSequence::default()});
        })?;
        if rejected {return Err("此会话仍有执行未结束，或执行标识重复".into());}
        let is_pi = session.backend == "pi";
        let host = self.clone(); let id = id.to_string();
        std::thread::spawn(move || {
            let mut reader = None;
            let result = (|| {
                let connection = host.connect(&id, &run_id, (model.as_deref(), effort.as_deref()));
                if is_pi && connection.is_err() {providers::invalidate_pi_discovery();}
                let (rpc, claude_launch) = connection?;
                reader = Some(rpc.reader.clone());
                let session = host.session(&id)?;
                if session.runs.last().is_none_or(|r| r.id != run_id || r.state != "running" || r.cancel_requested) {return Ok(());}
                let source = if session.backend == "codex" {
                    let submitting = host.update(&id, |s| {
                        if let Some(run) = s.runs.last_mut().filter(|r| r.id == run_id && r.state == "running" && !r.cancel_requested) {
                            run.advance_phase(RunPhase::Submitting);
                        }
                    })?;
                    if submitting.runs.last().is_none_or(|r| r.id != run_id || r.state != "running" || r.cancel_requested) {return Ok(());}
                    let mut params = json!({"threadId":session.source_id,"input":prepared.codex_input()});
                    if let Some(model) = &model {params["model"] = json!(model);}
                    if let Some(effort) = &effort {params["effort"] = json!(effort);}
                    let result = rpc.request("turn/start", params)?;
                    result["turn"]["id"].as_str().ok_or("Codex 未返回执行标识")?.to_string()
                } else {
                    if session.backend == "pi" {
                        host.update(&id, |s| {
                            if let Some(run) = s.runs.last_mut().filter(|r| r.id == run_id && r.state == "running" && !r.cancel_requested) {
                                run.advance_phase(RunPhase::Submitting);
                            }
                        })?;
                    }
                    let (applied_model, applied_effort) = if model.is_none() && effort.is_none() {
                        (None, None)
                    } else if claude_launch.is_some() {
                        (model.clone(), effort.clone())
                    } else if session.backend == "claude" {
                        let model = model.as_deref().filter(|value| Some(*value) != session.effective_model.as_deref());
                        let effort = effort.as_deref().filter(|value| model.is_some() || Some(*value) != session.effective_effort.as_deref());
                        claude_options::apply(&rpc, model, effort)?;
                        (model.map(str::to_owned), effort.map(str::to_owned))
                    } else {
                        pi_options::apply(&rpc, model.as_deref(), effort.as_deref())?
                    };
                    let submitting = host.update(&id, |s| {
                        if let Some(run) = s.runs.last_mut().filter(|r| r.id == run_id && r.state == "running" && !r.cancel_requested) {
                            run.source_turn_id = Some(run_id.clone());
                            if let Some(model) = applied_model {
                                if s.effective_model.as_ref() != Some(&model) {s.effective_effort = None;}
                                s.effective_model = Some(model);
                            }
                            if let Some(effort) = applied_effort {s.effective_effort = Some(effort);}
                        }
                    })?;
                    if submitting.runs.last().is_none_or(|r| r.id != run_id || r.state != "running" || r.cancel_requested) {return Ok(());}
                    if session.backend == "claude" {rpc.write(json!({"type":"user","message":{"role":"user","content":prepared.claude_content()},"parent_tool_use_id":null,"session_id":claude_launch.or(session.source_id)}))?;}
                    else {
                        let result = rpc.request("prompt", prepared.pi_prompt())?;
                        let no_agent_started = || host.session(&id).is_ok_and(|s| s.runs.last().is_some_and(|run| {
                            run.id == run_id && run.state == "running" && run.phase == Some(RunPhase::Submitting) && !run.cancel_requested
                        }));
                        let idle = || rpc.request_with_timeout("get_state", json!({}), Duration::from_secs(2))
                            .is_ok_and(|state| providers::pi_idle(&state));
                        // Pi 0.84 also acknowledges extension-handled prompts without a disposition.
                        // Allow an agent start to arrive before treating a still-idle acknowledgement as complete.
                        let handled = result["disposition"] == "handled" || (result.is_null() && no_agent_started() && idle() && {
                            std::thread::sleep(Duration::from_millis(250));
                            no_agent_started() && idle()
                        });
                        if handled {
                            host.update(&id, |s| {
                                if let Some(run) = s.runs.last_mut().filter(|r| r.id == run_id && r.state == "running" && r.phase == Some(RunPhase::Submitting) && !r.cancel_requested) {
                                    run.state = if run.error.is_some() {"failed"} else {"succeeded"}.into();
                                    run.finished_at = Some(now());
                                }
                            })?;
                        }
                    }
                    run_id.clone()
                };
                let after = host.update(&id, |s| {
                    if s.backend == "codex" && s.runs.last().is_some_and(|run| run.id == run_id) {
                        if let Some(model) = model {
                            if s.effective_model.as_ref() != Some(&model) {s.effective_effort = None;}
                            s.effective_model = Some(model);
                        }
                        if let Some(effort) = effort {s.effective_effort = Some(effort);}
                    }
                    if let Some(run) = s.runs.iter_mut().find(|r| r.id == run_id) {
                        run.source_turn_id.get_or_insert_with(|| source.clone());
                        if s.backend == "codex" && ["running", "needs_input"].contains(&run.state.as_str()) {
                            run.advance_phase(RunPhase::Executing);
                        }
                    }
                })?;
                if !rpc.reader.retired.load(Ordering::SeqCst) && after.runs.last().is_some_and(|r| r.id == run_id && r.cancel_requested && ["running", "needs_input"].contains(&r.state.as_str())) {
                    interrupt(&rpc, &after, Some(&source))?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                let mut discarded = None;
                let _ = host.update(&id, |s| {
                    if s.runs.last().is_none_or(|run| run.id != run_id || run.cancel_requested || !["running", "needs_input"].contains(&run.state.as_str())) {return;}
                    if let Some(reader) = reader.as_deref() {discarded = host.retire_runtime(&id, Some(reader));}
                    mark_failure(s, error);
                });
                drop(discarded);
            }
        }); Ok(snapshot)
    }
    pub fn stop(&self, id: &str) -> Result<AgentSession> {
        let session = self.session(id)?;
        let Some(run) = session.runs.last().filter(|run| ["running", "needs_input"].contains(&run.state.as_str()) && !run.cancel_requested) else {return Ok(session);};
        let run_id = &run.id;
        let mut claimed = false;
        let session = self.update(id, |s| {
            if let Some(run) = s.runs.last_mut().filter(|run| &run.id == run_id && ["running", "needs_input"].contains(&run.state.as_str()) && !run.cancel_requested) {
                run.cancel_requested = true;
                claimed = true;
            }
        })?;
        if !claimed {return Ok(session);}
        let run = session.runs.last().unwrap();
        let rpc = self.runtimes.lock().unwrap().get(id).cloned();
        if let Some(rpc) = &rpc {
            if session.backend != "codex" || run.source_turn_id.is_some() {
                let _ = interrupt(rpc, &session, run.source_turn_id.as_deref());
            }
        }
        // An interrupt ACK does not guarantee the provider's final event has arrived.
        // Retire an unconfirmed connection before another turn can consume those events.
        let discarded = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let latest = sessions.get(id).ok_or("会话不存在")?;
            if latest.runs.last().is_none_or(|r| &r.id != run_id || !["running", "needs_input"].contains(&r.state.as_str())) {
                return Ok(latest.clone());
            }
            self.retire_runtime(id, rpc.as_ref().map(|r| &*r.reader))
        };
        if let Some(discarded) = &discarded {discarded.terminate();}
        self.update(id, |s| {
            if let Some(run) = s.runs.last_mut().filter(|run| &run.id == run_id && ["running", "needs_input"].contains(&run.state.as_str())) {
                run.state = "cancelled".into();
                run.finished_at = Some(now());
                s.requests.clear();
            }
        })
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
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            // Persist before killing the processes, while excluding late protocol events.
            if !self.maintenance.swap(true, Ordering::SeqCst) {
                for session in sessions.values_mut() {
                    mark_host_exit(session);
                    let _ = self.persist(session);
                }
            }
        }
        if let Ok(mut runtimes) = self.runtimes.lock() {
            for rpc in runtimes.values() {rpc.reader.retired.store(true, Ordering::SeqCst);}
            runtimes.clear();
        }
    }
    pub fn checkpoint_all(&self)->Result<()> {let ids=self.list()?.into_iter().map(|s|s.id).collect::<Vec<_>>();for id in ids {self.update(&id,|_|{})?;}Ok(())}
    pub fn prepare_restore(&self)->Result<()> {
        self.maintenance.store(true,Ordering::SeqCst);let active=self.sessions.lock().map_err(|e|e.to_string())?.values().any(|s|s.runs.iter().any(|r|["running","needs_input"].contains(&r.state.as_str())));
        if active {self.maintenance.store(false,Ordering::SeqCst);return Err("请先等待正在执行的会话结束，或停止它们，再恢复备份。".into());}
        self.shutdown();
        // Windows cannot replace a workspace directory held by a catalog probe.
        let _drained = self.workspace_probe_gate.write().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn cancel_restore(&self){self.maintenance.store(false,Ordering::SeqCst);}
    fn event(&self, id: &str, value: &Value, reader: Option<&ReaderOwner>) {
        if reader.is_some_and(|r| r.retired.load(Ordering::SeqCst)) {return;}
        let applies = |session: &AgentSession| reader.is_none_or(|r| r.applies_to(session));
        let backend = self.sessions.lock().ok().and_then(|sessions| sessions.get(id).map(|s| s.backend.clone()));
        if let Some(backend) = backend.filter(|backend| backend != "codex") {
            if providers::relevant(&backend, value) {
                let stream = value["type"] == "stream_event" || value["type"] == "tool_execution_update"
                    || (value["type"] == "message_update" && value["assistantMessageEvent"]["type"] == "text_delta");
                let _ = self.update_stream(id, stream, |s| {if applies(s) {providers::apply_event(s, value);}});
            }
            return;
        }
        let method = value["method"].as_str().unwrap_or(""); let p = &value["params"];
        if value.get("id").is_some() && value.get("method").is_some() {
            let kind = if ["item/commandExecution/requestApproval","item/fileChange/requestApproval"].contains(&method) {"approval"} else if method=="mcpServer/elicitation/request" && p["mode"]=="form" {"elicitation"} else if method == "item/tool/requestUserInput" {"input"} else {"unsupported"};
            let title = p["message"].as_str().or(p["reason"].as_str()).or(p["command"].as_str()).unwrap_or(method).chars().take(2000).collect();
            let _ = self.update(id, |s| {
                if !applies(s) {return;}
                let Some((run, turn)) = codex_run(s, p) else {return;};
                if run.cancel_requested {return;}
                if let Some(turn) = turn {run.source_turn_id.get_or_insert_with(|| turn.to_owned());}
                run.state = "needs_input".into();
                let request_id = value["id"].to_string();
                if !s.requests.iter().any(|r| r.id == request_id) {
                    s.requests.push(Request {id: request_id, kind: kind.into(), title, payload: p.clone(), source_id: value["id"].clone()});
                }
            }); return;
        }
        let activity = match method {
            "item/started" | "item/completed" => feedback::item(&p["item"], method == "item/completed"),
            "turn/plan/updated" => feedback::plan(p),
            _ => None,
        };
        let stream = matches!(method, "item/agentMessage/delta" | "item/commandExecution/outputDelta");
        if activity.is_some() || stream || ["turn/started", "turn/completed", "error"].contains(&method)
            || (method == "item/completed" && p["item"]["type"] == "agentMessage") {
            let _ = self.update_stream(id, stream, |s| {
                if applies(s) {apply_codex_event(s, method, p, activity);}
            });
        }
    }
}
fn mark_failure(session: &mut AgentSession, error: String) {
    let Some(run) = session.runs.last_mut().filter(|run| ["running", "needs_input"].contains(&run.state.as_str())) else {return;};
    run.state = if run.cancel_requested {"cancelled"} else {"failed"}.into();
    run.finished_at = Some(now());
    run.error = (!run.cancel_requested).then_some(error);
    session.error = run.error.clone();
    session.requests.clear();
}
fn read_protocol(stdout: std::process::ChildStdout, pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, events: Option<(Weak<AgentHost>, String, String)>, backend: String, reader: Arc<ReaderOwner>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {break;}; let Ok(value) = serde_json::from_str::<Value>(&line) else {continue;};
        if let Some((key, reply)) = providers::reply(&backend, &value) {if let Some(sender) = pending.lock().unwrap().remove(&key) {let _ = sender.send(reply);}}
        else if let Some((host, id, _)) = &events {
            let Some(host) = host.upgrade() else {break;};
            host.event(id, &value, Some(&reader));
        }
    }
    pending.lock().unwrap().clear();
    if reader.retired.load(Ordering::SeqCst) {return;}
    if let Some((host, id, _)) = events {
        if let Some(host) = host.upgrade() {
            if backend == "pi" {providers::invalidate_pi_discovery();}
            let mut discarded = None;
            let _ = host.update(&id, |s| {
                if !reader.applies_to(s) {return;}
                discarded = host.retire_runtime(&id, Some(&reader));
                reader.retired.store(true, Ordering::SeqCst);
                mark_failure(s, "执行器连接已关闭，可继续此会话。".into());
            });
            drop(discarded);
        }
    }
}
fn interrupt(rpc: &Rpc, session: &AgentSession, turn: Option<&str>) -> Result<()> {
    let (method, params) = match session.backend.as_str() {"codex" => ("turn/interrupt", json!({"threadId":session.source_id,"turnId":turn})), "claude" => ("interrupt", json!({})), "pi" => ("abort", json!({})), _ => return Err("执行器类型无效".into())};
    rpc.request(method, params).map(|_| ())
}
fn codex_run<'a, 'b>(s: &'a mut AgentSession, p: &'b Value) -> Option<(&'a mut Run, Option<&'b str>)> {
    if p["threadId"].as_str().is_some_and(|id| s.source_id.as_deref().is_some_and(|own| own != id)) {return None;}
    let incoming_turn = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
    let (current, previous) = s.runs.split_last_mut()?;
    if !["running", "needs_input"].contains(&current.state.as_str()) {return None;}
    if incoming_turn.is_some_and(|turn| current.source_turn_id.as_deref().is_some_and(|own| own != turn)
        || previous.iter().any(|run| run.source_turn_id.as_deref() == Some(turn))) {return None;}
    Some((current, incoming_turn))
}
fn apply_codex_event(s: &mut AgentSession, method: &str, p: &Value, activity: Option<Activity>) {
    let anchor = activity.as_ref().and_then(|_| s.messages.last()).map(|message| message.id.clone());
    let Some((current, incoming_turn)) = codex_run(s, p) else {return;};
    if current.cancel_requested && method != "turn/completed" {return;}
    if current.phase == Some(RunPhase::Connecting) && method != "error" {return;}
    if let Some(incoming) = incoming_turn {
        current.source_turn_id.get_or_insert_with(|| incoming.to_owned());
    }
    if let Some(mut activity) = activity {
        current.advance_phase(RunPhase::Executing);
        activity.after_message_id = anchor;
        feedback::upsert(&mut current.activity, activity);
        return;
    }
    match method {
        "item/commandExecution/outputDelta" => feedback::update_output(&mut current.activity, &p["itemId"], &p["delta"], true),
        "turn/started" => current.advance_phase(RunPhase::Executing),
        "item/agentMessage/delta" => {
            let Some(delta) = p["delta"].as_str().filter(|delta| !delta.is_empty()) else {return;};
            current.advance_phase(RunPhase::Responding);
            let id = p["itemId"].as_str().unwrap_or("assistant"); let key = format!("{}-{id}", current.id);
            if !s.messages.iter().any(|m| m.id == key) {s.messages.push(Message {id: key.clone(), role: "assistant".into(), text: String::new(), at: now(), files: Vec::new()});}
            if let Some(message) = s.messages.iter_mut().find(|m| m.id == key) {message.text.push_str(delta);}
        },
        "item/completed" if p["item"]["type"] == "agentMessage" => {
            let item = &p["item"]; let key = format!("{}-{}", current.id, item["id"].as_str().unwrap_or("assistant"));
            let Some(text) = item["text"].as_str().filter(|text| !text.is_empty()).map(str::to_owned) else {return;};
            current.advance_phase(RunPhase::Responding);
            if let Some(message) = s.messages.iter_mut().find(|m| m.id == key) {message.text = text;} else {s.messages.push(Message {id: key, role: "assistant".into(), text, at: now(), files: Vec::new()});}
        },
        "turn/completed" => {
            current.state = if current.cancel_requested {"cancelled"} else {match p["turn"]["status"].as_str() {Some("completed") => "succeeded", Some("interrupted") => "cancelled", _ => "failed"}}.into();
            current.finished_at = Some(now());
            current.error = if current.cancel_requested {None} else {p["turn"]["error"]["message"].as_str().map(String::from)};
            current.settle_activity();
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
pub fn backends() -> Vec<Backend> {
    providers::invalidate_pi_discovery();
    ["codex", "claude", "pi"].into_iter().map(|id| {let provider = providers::discover(id); Backend {id: id.into(), available: provider.is_some(), detail: provider.map(|p| format!("{} · {}", if p.wsl {"WSL"} else {"本机"}, id)).unwrap_or_else(|| "未安装或不可用".into())}}).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_management_is_durable_and_rejects_active_batches_and_failed_writes() {
        let root=std::env::temp_dir().join(format!("northstar-session-management-{}",uuid::Uuid::new_v4()));let host=AgentHost::open(root.clone(),Arc::new(|_|{})).unwrap();
        let mut a=record();a.runs.clear();a.cwd=root.to_string_lossy().into();let mut b=a.clone();b.id="b".into();let mut other=a.clone();other.id="other".into();other.workspace_id="other".into();
        for s in [&a,&b,&other]{host.persist(s).unwrap();host.sessions.lock().unwrap().insert(s.id.clone(),s.clone());}
        assert!(host.rename("s","  ").is_err());assert!(host.rename("s","line\nbreak").is_err());
        host.rename("s","Renamed").unwrap();assert_eq!(host.session("s").unwrap().title,"Renamed");
        for state in ["running","needs_input"] {let mut run=record().runs.remove(0);run.state=state.into();host.sessions.lock().unwrap().get_mut("b").unwrap().runs=vec![run];assert!(host.delete(&["s".into(),"b".into()],None).is_err());assert!(host.session("s").is_ok());}
        host.sessions.lock().unwrap().get_mut("b").unwrap().runs.clear();
        host.db.lock().unwrap().execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON agent_sessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(host.delete(&[],Some("w")).is_err());assert!(host.session("s").is_ok());assert!(host.session("b").is_ok());
        host.db.lock().unwrap().execute_batch("DROP TRIGGER reject_delete;").unwrap();
        std::fs::write(root.join("keep.txt"),"Keep files").unwrap();assert_eq!(host.delete(&[],Some("w")).unwrap().len(),2);
        assert!(host.session("s").is_err());assert!(host.session("b").is_err());assert!(host.session("other").is_ok());
        assert!(host.delete(&["s".into()],None).unwrap().is_empty());host.shutdown();drop(host);
        let reopened=AgentHost::open(root.clone(),Arc::new(|_|{})).unwrap();assert!(reopened.session("s").is_err());assert_eq!(reopened.list().unwrap().len(),1);assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(),"Keep files");
    }
    #[test]
    fn deleting_and_undoing_a_node_only_changes_session_binding(){
        let root=std::env::temp_dir().join(format!("northstar-node-binding-{}",uuid::Uuid::new_v4()));let host=AgentHost::open(root.clone(),Arc::new(|_|{})).unwrap();let mut session=record();session.node_id=Some("node".into());session.messages.push(Message{id:"user".into(),role:"user".into(),text:"Keep prompt".into(),at:1, files: Vec::new()});host.persist(&session).unwrap();host.sessions.lock().unwrap().insert("s".into(),session);
        let mut snapshot=json!({"spaces":[{"id":"w","nodes":[{"id":"root"}]}],"sessions":[{"id":"s","workspaceId":"w","nodeId":null}]});host.reconcile_nodes(&snapshot).unwrap();let detached=host.session("s").unwrap();assert!(detached.node_id.is_none());assert_eq!(detached.messages[0].text,"Keep prompt");assert_eq!(detached.runs[0].state,"running");assert_eq!(detached.source_id.as_deref(),Some("thread"));
        snapshot["spaces"][0]["nodes"]=json!([{"id":"node"}]);snapshot["sessions"][0]["nodeId"]=json!("node");host.reconcile_nodes(&snapshot).unwrap();assert_eq!(host.session("s").unwrap().node_id.as_deref(),Some("node"));
        host.shutdown();drop(host);assert_eq!(AgentHost::open(root,Arc::new(|_|{})).unwrap().session("s").unwrap().node_id.as_deref(),Some("node"));
    }
    fn record() -> AgentSession {AgentSession {id: "s".into(), workspace_id: "w".into(), node_id: None, backend: "codex".into(), title: "test".into(), cwd: String::new(), source_id: Some("thread".into()), created_at: 0, revision: 1, messages: vec![], requests: vec![], error: None, effective_model: None, effective_effort: None, runs: vec![Run {id: "run".into(), state: "running".into(), started_at: 0, finished_at: None, source_turn_id: Some("turn".into()), error: None, cancel_requested: false, context: None, phase: Some(RunPhase::Responding), activity: Vec::new(), pi_messages: PiMessageSequence::default()}]}}
    #[test]
    fn streams_without_duplicate_final_messages_and_never_maps_failure_to_success() {
        let mut s = record();
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"thread","itemId":"a","delta":"Hel"}),None);
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"thread","itemId":"a","delta":"lo"}),None);
        apply_codex_event(&mut s, "item/completed", &json!({"item":{"type":"agentMessage","id":"a","text":"Hello"}}),None);
        assert_eq!(s.messages.len(), 1); assert_eq!(s.messages[0].text, "Hello");
        apply_codex_event(&mut s, "turn/completed", &json!({"turn":{"status":"failed","error":{"message":"network"}}}),None);
        assert_eq!(s.runs[0].state, "failed"); assert_eq!(s.runs[0].error.as_deref(), Some("network"));
        apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"itemId":"late","delta":"ignore"}),None); assert_eq!(s.messages.len(), 1);
    }
    #[test]
    fn ignores_other_threads_and_keeps_cancelled_run_cancelled() {
        let mut s = record(); apply_codex_event(&mut s, "item/agentMessage/delta", &json!({"threadId":"other","itemId":"a","delta":"wrong"}),None); assert!(s.messages.is_empty());
        s.runs[0].state = "cancelled".into(); apply_codex_event(&mut s, "turn/completed", &json!({"turn":{"status":"completed"}}),None); assert_eq!(s.runs[0].state, "cancelled");
    }
    #[test]
    fn codex_approvals_only_pause_the_matching_active_turn() {
        let root = std::env::temp_dir().join(format!("draftway-approval-routing-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(root, Arc::new(|_| {})).unwrap();
        let mut session = record();
        session.runs[0].state = "succeeded".into();
        host.sessions.lock().unwrap().insert("s".into(), session);
        let approval = |id, thread, turn| json!({"id":id,"method":"item/commandExecution/requestApproval",
            "params":{"threadId":thread,"turnId":turn}});
        host.event("s", &approval("late", "thread", "turn"), None);
        let saved = host.session("s").unwrap();
        assert_eq!(saved.runs[0].state, "succeeded");
        assert!(saved.requests.is_empty());
        host.update("s", |s| {
            let mut next = record().runs.remove(0);
            next.id = "next-run".into();
            next.source_turn_id = None;
            s.runs.push(next);
        }).unwrap();
        host.event("s", &approval("previous", "thread", "turn"), None);
        host.event("s", &approval("other", "other-thread", "next"), None);
        let saved = host.session("s").unwrap();
        assert_eq!(saved.runs[1].state, "running");
        assert!(saved.requests.is_empty());
        host.event("s", &approval("current", "thread", "next"), None);
        host.event("s", &approval("current", "thread", "next"), None);
        let saved = host.session("s").unwrap();
        assert_eq!(saved.runs[1].state, "needs_input");
        assert_eq!(saved.runs[1].source_turn_id.as_deref(), Some("next"));
        assert_eq!(saved.requests.len(), 1);
    }
    #[test]
    fn retired_or_superseded_reader_cannot_finish_new_turn() {
        let root = std::env::temp_dir().join(format!("draftway-reader-fence-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(root, Arc::new(|_| {})).unwrap();
        let mut session = record();
        session.backend = "claude".into();
        session.runs[0].id = "new-run".into();
        host.sessions.lock().unwrap().insert("s".into(), session);
        let old = ReaderOwner {startup_run: "old-run".into(), ..Default::default()};
        let frame = json!({"type":"result","subtype":"success","session_id":"thread","result":"Late"});
        host.event("s", &frame, Some(&old));
        old.attached.store(true, Ordering::SeqCst);
        old.retired.store(true, Ordering::SeqCst);
        host.event("s", &frame, Some(&old));
        let saved = host.session("s").unwrap();
        assert_eq!(saved.runs[0].state, "running");
        assert!(saved.messages.is_empty());
        let current = ReaderOwner {startup_run: "new-run".into(), ..Default::default()};
        host.event("s", &frame, Some(&current));
        assert_eq!(host.session("s").unwrap().runs[0].state, "succeeded");
    }
    #[test]
    fn codex_feedback_uses_real_current_turn_events_and_keeps_terminal_rows() {
        let mut session = record();
        let mut previous = session.runs[0].clone();
        previous.id = "older".into();
        previous.source_turn_id = Some("old-turn".into());
        previous.state = "succeeded".into();
        session.runs.insert(0, previous);
        session.runs[1].phase = Some(RunPhase::Connecting);
        session.runs[1].source_turn_id = None;
        apply_codex_event(&mut session, "turn/started", &json!({"turn":{"id":"old-turn"}}), None);
        assert_eq!(session.runs[1].phase, Some(RunPhase::Connecting));
        session.runs[1].advance_phase(RunPhase::Submitting);
        let done = json!({"id":"cmd", "type":"commandExecution", "command":"test", "aggregatedOutput":"failure", "exitCode":1});
        apply_codex_event(&mut session, "item/completed", &json!({"turnId":"old-turn"}), feedback::item(&done, true));
        assert!(session.runs[1].activity.is_empty());
        apply_codex_event(&mut session, "item/completed", &json!({"turnId":"turn"}), feedback::item(&done, true));
        apply_codex_event(&mut session, "item/started", &json!({"turnId":"turn"}), feedback::item(&done, false));
        assert_eq!(session.runs[1].phase, Some(RunPhase::Executing));
        assert_eq!(session.runs[1].activity.len(), 1);
        let current = serde_json::to_value(&session.runs[1]).unwrap();
        assert_eq!(current["activity"][0]["status"], "failed");
        assert_eq!(current["activity"][0]["detail"], "test");
        assert_eq!(current["activity"][0]["output"], "failure");
        assert_eq!(current["activity"][0]["exitCode"], 1);
        apply_codex_event(&mut session, "item/agentMessage/delta", &json!({"turnId":"turn","delta":"正文"}), None);
        apply_codex_event(&mut session, "turn/started", &json!({"turn":{"id":"turn"}}), None);
        assert_eq!(session.runs[1].phase, Some(RunPhase::Responding));
        let plan = json!({"turnId":"turn","plan":[{"step":"检查结果","status":"inProgress"}]});
        apply_codex_event(&mut session, "turn/plan/updated", &plan, feedback::plan(&plan));
        apply_codex_event(&mut session, "turn/completed", &json!({"turn":{"id":"turn","status":"completed"}}), None);
        let current = serde_json::to_value(&session.runs[1]).unwrap();
        assert_eq!(current["activity"][1]["status"], "completed");
        assert_eq!(current["activity"][0]["status"], "failed");
        let mut legacy = current;
        let fields = legacy.as_object_mut().unwrap();
        fields.remove("phase");
        fields.remove("activity");
        let legacy: Run = serde_json::from_value(legacy).unwrap();
        assert!(legacy.phase.is_none() && legacy.activity.is_empty());
    }
    #[test]
    fn codex_web_action_and_command_delta_anchor_after_streamed_text() {
        let mut s = record();
        let text = json!({"turnId":"turn","itemId":"intro","delta":"Checking sources."});
        apply_codex_event(&mut s, "item/agentMessage/delta", &text, None);
        let search = json!({"id":"search","type":"webSearch","query":"","action":{"type":"openPage","url":"https://example.com/source"}});
        apply_codex_event(&mut s, "item/completed", &json!({"turnId":"turn"}), feedback::item(&search, true));
        let command = json!({"id":"cmd","type":"commandExecution","command":"rg TODO src",
            "commandActions":[{"type":"search","command":"rg TODO src","query":"TODO","path":"src"}]});
        apply_codex_event(&mut s, "item/started", &json!({"turnId":"turn"}), feedback::item(&command, false));
        for delta in ["working ", "tree clean"] {
            let output = json!({"turnId":"turn","itemId":"cmd","delta":delta});
            apply_codex_event(&mut s, "item/commandExecution/outputDelta", &output, None);
        }
        let rows = serde_json::to_value(&s.runs[0].activity).unwrap();
        assert_eq!(rows[0]["detail"], "https://example.com/source");
        assert_eq!(rows[0]["afterMessageId"], "run-intro");
        assert_eq!(rows[1]["afterMessageId"], "run-intro");
        assert_eq!(rows[1]["title"], "搜索文件内容");
        assert_eq!(rows[1]["subject"], "TODO");
        assert_eq!(rows[1]["detail"], "rg TODO src");
        assert_eq!(rows[1]["output"], "working tree clean");
    }
    #[test]
    fn restores_unfinished_execution_as_interrupted_and_retains_transcript() {
        for graceful in [false, true] {
            let dir = std::env::temp_dir().join(format!("northstar-agent-test-{}", uuid::Uuid::new_v4()));
            let host = AgentHost::open(dir.clone(), Arc::new(|_| {})).unwrap();
            let mut session = record();
            session.runs[0].source_turn_id = None;
            session.messages.push(Message {id: "run-user".into(), role: "user".into(), text: "keep".into(), at: 0, files: Vec::new()});
            host.persist(&session).unwrap();
            if graceful {
                host.sessions.lock().unwrap().insert(session.id.clone(), session);
                host.shutdown();
                assert_eq!(host.session("s").unwrap().runs[0].state, "interrupted");
            }
            drop(host);
            let restored = AgentHost::open(dir, Arc::new(|_| {})).unwrap().session("s").unwrap();
            assert_eq!(restored.runs.len(), 1);
            assert_eq!(restored.runs[0].state, "interrupted");
            assert!(restored.runs[0].source_turn_id.is_none());
            assert_eq!(restored.messages.len(), 1);
            assert_eq!(restored.messages[0].text, "keep");
            assert_eq!(restored.source_id.as_deref(), Some("thread"));
        }
    }
    #[test]
    fn host_exit_migrates_legacy_interruptions_but_retains_failures_and_explicit_stops() {
        let mut session = record();
        let mut failed = session.runs[0].clone();
        failed.state = "failed".into();
        failed.error = Some("network".into());
        let mut previously_interrupted = failed.clone();
        previously_interrupted.error = Some("上次执行随宿主退出而中断，可继续此会话。".into());
        session.runs[0].cancel_requested = true;
        session.runs.extend([failed, previously_interrupted]);
        mark_host_exit(&mut session);
        assert_eq!(session.runs.iter().map(|run| run.state.as_str()).collect::<Vec<_>>(), ["cancelled", "failed", "interrupted"]);
        assert_eq!(session.runs[1].error.as_deref(), Some("network"));
        assert!(session.runs[2].error.is_none());
        let revision = session.revision;
        mark_host_exit(&mut session);
        assert_eq!(session.revision, revision);
    }
    #[test]
    fn restore_requires_idle_agents_and_blocks_updates_until_cancelled(){
        let root=std::env::temp_dir().join(format!("northstar-agent-restore-{}",uuid::Uuid::new_v4()));let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();host.sessions.lock().unwrap().insert("s".into(),record());assert!(host.prepare_restore().is_err());host.update("s",|s|s.runs[0].state="cancelled".into()).unwrap();host.prepare_restore().unwrap();assert!(host.update("s",|s|s.title="overwrite".into()).is_err());assert_eq!(host.session("s").unwrap().title,"test");host.cancel_restore();host.update("s",|s|s.title="after".into()).unwrap();
    }
    #[test]
    fn restore_drains_workspace_probes_and_rejects_new_ones() {
        let root = std::env::temp_dir().join(format!("draftway-restore-probes-{}", uuid::Uuid::new_v4()));
        let host = AgentHost::open(root, Arc::new(|_| {})).unwrap();
        let ongoing = host.workspace_probe_gate.read().unwrap();
        let (done, result) = mpsc::channel();
        let restoring = host.clone();
        std::thread::spawn(move || {done.send(restoring.prepare_restore()).unwrap();});
        let started = Instant::now();
        while !host.maintenance.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(2) {
            std::thread::yield_now();
        }
        assert!(host.maintenance.load(Ordering::SeqCst));
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        drop(ongoing);
        assert!(result.recv_timeout(Duration::from_secs(2)).unwrap().is_ok());
        assert!(host.workspace_cwd("workspace", None).is_err());
    }
    #[test]
    fn sparse_stream_publishes_without_another_token_and_omits_history() {
        let root=std::env::temp_dir().join(format!("northstar-stream-frame-{}",uuid::Uuid::new_v4()));
        let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();let mut session=record();
        session.messages=(0..1000).map(|i|Message{id:format!("old-{i}"),role:"assistant".into(),text:"history ".repeat(100),at:0,files:Vec::new()}).collect();
        session.messages.push(Message{id:"run-user".into(),role:"user".into(),text:"raw prompt".into(),at:1, files: Vec::new()});
        host.sessions.lock().unwrap().insert("s".into(),session);let base=host.update("s",|_|{}).unwrap().revision;
        let (tx,rx)=mpsc::channel();host.configure_transcript_sink(Arc::new(move|frame|{let _=tx.send(frame.clone());}));
        host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"first token"}),None)).unwrap();
        let frame=rx.recv_timeout(Duration::from_millis(500)).expect("a paused stream must still reach the UI");
        assert_eq!(frame.base_revision,base);assert_eq!(frame.messages.len(),1);assert_eq!(frame.messages[0].text,"first token");
        let compact=serde_json::to_vec(&frame).unwrap().len();let full=serde_json::to_vec(&host.session("s").unwrap()).unwrap().len();
        assert!(compact*100<full,"stream IPC must not carry the history");
    }
    #[test]
    fn quiet_stream_is_checkpointed_and_disk_failure_stops_it() {
        let root=std::env::temp_dir().join(format!("northstar-stream-checkpoint-{}",uuid::Uuid::new_v4()));
        let host=AgentHost::open(root,Arc::new(|_|{})).unwrap();host.sessions.lock().unwrap().insert("s".into(),record());
        host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"saved partial reply"}),None)).unwrap();
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
        for _ in 0..100 {host.update_stream("s",true,|s|apply_codex_event(s,"item/agentMessage/delta",&json!({"threadId":"thread","itemId":"a","delta":"x"}),None)).unwrap();}
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
        host.runtimes.lock().unwrap().insert("s".into(), Arc::new(Rpc {writer: Mutex::new(writer), child: Mutex::new(child), pending: Arc::new(Mutex::new(HashMap::new())), serial: AtomicU64::new(1), backend: "codex".into(), ownership: process::Ownership::empty(), reader: Arc::new(ReaderOwner::default())}));
        assert_eq!(host.stop("s").unwrap().runs[0].state, "cancelled"); assert!(host.runtimes.lock().unwrap().is_empty()); assert_eq!(host.stop("s").unwrap().runs[0].state, "cancelled");
    }
}
