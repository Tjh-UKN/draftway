use crate::{native_agents::AgentSession, review_service::{self, Snapshot}, store::{Store, Result, error}, workspace_state};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};

fn now() -> u64 {chrono::Utc::now().timestamp_millis() as u64}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {Session {#[serde(rename="sessionId")] session_id: String}, Report {url: String, file: String}, Workspace}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String, pub workspace_id: String, pub title: String, pub body: String, pub target: Target, pub read: bool,
    pub at: u64, pub delivery: String, pub delivery_error: Option<String>, pub retry_at: u64, pub group: String,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)] pub revision: u64,
    #[serde(default)] pub error: Option<String>,
    pub notices: Vec<Notice>, pub reviews: HashMap<String, Snapshot>,
    #[serde(default)] seen_reports: HashMap<String, HashMap<String, String>>,
    #[serde(default)] agent_states: HashMap<String, HashMap<String, String>>,
}
type Sink = Arc<dyn Fn(&State) + Send + Sync>;
type Delivery = Arc<dyn Fn(&Notice) -> Result<()> + Send + Sync>;
pub struct Background {
    store: Arc<Store>, state: Mutex<State>, sink: Sink, delivery: Delivery, foreground: Arc<dyn Fn() -> bool + Send + Sync>,
    stopped: AtomicBool, client: reqwest::blocking::Client,
}
impl Background {
    pub fn open(store: Arc<Store>, sink: Sink, delivery: Delivery, foreground: Arc<dyn Fn() -> bool + Send + Sync>) -> Result<Arc<Self>> {
        let saved: Option<String> = store.db.lock().map_err(error)?.query_row("SELECT value FROM metadata WHERE key='background-runtime-v1'", [], |row| row.get(0)).optional().map_err(error)?;
        let state = saved.map(|raw| serde_json::from_str::<State>(&raw).map_err(error)).transpose()?.unwrap_or_default();
        Ok(Arc::new(Self {store, state: Mutex::new(state), sink, delivery, foreground, stopped: AtomicBool::new(false), client: review_service::client()?}))
    }
    pub fn snapshot(&self) -> Result<State> {Ok(self.state.lock().map_err(error)?.clone())}
    fn commit(&self, state: &State) -> Result<()> {
        self.store.db.lock().map_err(error)?.execute("INSERT INTO metadata(key,value) VALUES('background-runtime-v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(state).map_err(error)?]).map_err(error)?; Ok(())
    }
    fn change(&self, update: impl FnOnce(&mut State)) -> Result<()> {
        let (next, saved) = {let mut state = self.state.lock().map_err(error)?; let old = state.clone(); update(&mut state); state.revision += 1; state.error = None; let saved = self.commit(&state); if let Err(error) = &saved {*state = old; state.revision += 1; state.error=Some(format!("后台状态保存失败：{error}"));} (state.clone(),saved)};
        (self.sink)(&next); saved
    }
    pub fn mark_read(&self, ids: &[String]) -> Result<()> {self.change(|state| {for notice in &mut state.notices {if ids.contains(&notice.id) {notice.read = true;}}})}
    fn shell(&self) -> Option<Value> {workspace_state::load(&self.store).ok().flatten()}
    fn session_visible(&self, workspace_id: &str, session_id: &str) -> bool {
        if !(self.foreground)() {return false;}
        let Some(shell) = self.shell() else {return false;};
        if shell["activeId"] != workspace_id {return false;}
        fn visible(node: &Value, id: &str) -> bool {if node["kind"] == "group" {node["activeId"] == id} else {node["children"].as_array().is_some_and(|nodes| nodes.iter().any(|n| visible(n,id)))}}
        shell["spaces"].as_array().and_then(|spaces| spaces.iter().find(|space| space["id"] == workspace_id)).is_some_and(|space| visible(&space["dock"]["root"], session_id))
    }
    pub fn observe_agent(&self, session: &AgentSession) -> Result<()> {
        if self.stopped.load(Ordering::SeqCst) {return Ok(());}
        let states: HashMap<_, _> = session.runs.iter().map(|run| (run.id.clone(),run.state.clone())).collect();
        if self.state.lock().map_err(error)?.agent_states.get(&session.id) == Some(&states) {return Ok(());}
        let visible = self.session_visible(&session.workspace_id, &session.id);
        self.change(|state| {
            let previous = state.agent_states.entry(session.id.clone()).or_default();
            let mut notices = Vec::new();
            for run in &session.runs {
                if previous.get(&run.id).is_some_and(|old| old != &run.state) && ["succeeded", "failed", "needs_input"].contains(&run.state.as_str()) {
                    let id = format!("native-{}-{}",run.id,run.state);
                    notices.push(Notice {id:id.clone(), workspace_id:session.workspace_id.clone(), title: match run.state.as_str() {"succeeded"=>"执行完成", "needs_input"=>"需要你的输入", _=>"执行失败"}.into(), body:session.title.clone(), target:Target::Session{session_id:session.id.clone()}, read:visible, at:now(), delivery:"pending".into(), delivery_error:None, retry_at:0, group:id});
                }
            }
            *previous = states;
            for notice in notices {if !state.notices.iter().any(|old| old.id == notice.id) {state.notices.push(notice);}}
        })
    }
    pub fn bindings(&self) -> Vec<(String,String)> {
        self.shell().and_then(|shell| shell["spaces"].as_array().cloned()).unwrap_or_default().iter().filter_map(|space| Some((space["id"].as_str()?.to_string(), space["review"]["url"].as_str()?.to_string()))).collect()
    }
    pub fn poll_once(&self) {
        let bindings = self.bindings();
        std::thread::scope(|scope| {for (workspace, base) in bindings {scope.spawn(move || {
            let result = (|| {let status = review_service::get(&self.client,&base,"api/status")?; let reports = review_service::get(&self.client,&base,"api/reports")?; review_service::parse(&workspace,&base,&status,&reports)})();
            match result {Ok(snapshot) => {let _ = self.observe_review(snapshot);}, Err(error) => {let _ = self.disconnect(&workspace,&base,error);}}
        });}});
        self.deliver_pending();
    }
    fn disconnect(&self, workspace: &str, base: &str, error: String) -> Result<()> {
        let old = self.state.lock().map_err(crate::store::error)?.reviews.get(workspace).filter(|old|old.url==base).cloned();
        if old.as_ref().is_some_and(|old| !old.connected && old.error.as_ref() == Some(&error)) {return Ok(());}
        self.change(|state| {let mut snapshot = old.unwrap_or_else(|| Snapshot {workspace_id:workspace.into(),url:base.into(),connected:false,repository:String::new(),running_count:0,paused:false,reports:vec![],error:None,history_gap:false}); snapshot.connected=false; snapshot.error=Some(error); state.reviews.insert(workspace.into(),snapshot);})
    }
    pub fn observe_review(&self, mut snapshot: Snapshot) -> Result<()> {
        {let state=self.state.lock().map_err(error)?;snapshot.history_gap=state.reviews.get(&snapshot.workspace_id).is_some_and(|old|old.url==snapshot.url && old.repository==snapshot.repository && old.history_gap);if state.error.is_none() && state.reviews.get(&snapshot.workspace_id)==Some(&snapshot) {return Ok(());}}
        self.change(|state| {
            let key = format!("{}:{}:{}",snapshot.workspace_id,snapshot.url,snapshot.repository);
            let baseline = !state.seen_reports.contains_key(&key);
            let seen = state.seen_reports.entry(key).or_default();
            snapshot.history_gap |= !baseline && snapshot.reports.len() >= 50 && !snapshot.reports.iter().any(|report| seen.contains_key(&report.file));
            let changed = review_service::terminal_changes(seen,&snapshot.reports,baseline);
            for report in changed {
                let group = format!("review:{}:{}:{}:{}",snapshot.url,snapshot.repository,report.file,report.state);
                let id = format!("{}:{}",snapshot.workspace_id,group);
                if !state.notices.iter().any(|notice| notice.id == id) {state.notices.push(Notice {id,workspace_id:snapshot.workspace_id.clone(),title:if report.state == "succeeded" {"PR 检视完成"}else{"PR 检视失败"}.into(),body:format!("{} 个 PR 的检视报告已更新",report.prs.len()),target:Target::Report{url:snapshot.url.clone(),file:report.file},read:false,at:now(),delivery:"pending".into(),delivery_error:None,retry_at:0,group});}
            }
            state.reviews.insert(snapshot.workspace_id.clone(),snapshot);
        })
    }
    pub fn report(&self, workspace: &str, file: &str, url: &str) -> Result<Value> {
        if !review_service::report_file(file) {return Err("报告标识无效".into());}
        let base = review_service::local_url(url)?;
        let bound = self.bindings().iter().any(|(id, value)| id == workspace && review_service::local_url(value).ok().as_ref() == Some(&base));
        let notified = self.snapshot()?.notices.iter().any(|n| n.workspace_id == workspace && matches!(&n.target, Target::Report {url, file: name} if url == &base && name == file));
        if !bound && !notified {return Err("此报告未关联到当前工作区".into());}
        review_service::get(&self.client,&base,&format!("api/reports/{file}"))
    }
    pub fn deliver_pending(&self) {
        let notices = match self.snapshot() {Ok(state)=>state.notices,Err(_)=>return};
        if !notices.iter().any(|notice|notice.delivery=="pending" && notice.retry_at<=now()) {return;}
        let enabled = self.store.db.lock().ok().and_then(|db|db.query_row("SELECT json_extract(data,'$.notifications') FROM settings WHERE id=1",[],|row|row.get::<_,bool>(0)).ok()).unwrap_or(false);
        let mut sent: std::collections::HashSet<_> = notices.iter().filter(|notice|notice.delivery=="sent").map(|notice|notice.group.clone()).collect();
        for notice in notices.iter().filter(|notice| notice.delivery == "pending" && notice.retry_at <= now()) {
            let duplicate = sent.contains(&notice.group);
            let suppress = notice.read || (self.foreground)() || !enabled || duplicate;
            let result = if suppress {Ok(())} else {(self.delivery)(notice)};
            if result.is_ok() && !suppress {sent.insert(notice.group.clone());}
            let _ = self.change(|state| {if let Some(current) = state.notices.iter_mut().find(|n|n.id == notice.id) {match &result {Ok(()) => {current.delivery=if suppress {"suppressed"}else{"sent"}.into(); current.delivery_error=None;},Err(error)=>{current.delivery_error=Some(error.clone());current.retry_at=now()+30000;}}}});
        }
    }
    pub fn start(self: &Arc<Self>) {let host=self.clone();std::thread::spawn(move || {while !host.stopped.load(Ordering::SeqCst) {host.poll_once();for _ in 0..50 {if host.stopped.load(Ordering::SeqCst) {return;}std::thread::sleep(Duration::from_millis(100));}}});}
    pub fn stop(&self) {self.stopped.store(true,Ordering::SeqCst);}
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    fn host(delivered: Arc<AtomicUsize>) -> Arc<Background> {
        let root = std::env::temp_dir().join(format!("northstar-background-test-{}",uuid::Uuid::new_v4())); let store=Arc::new(Store::open(root).unwrap()); store.seed_if_new().unwrap();
        Background::open(store,Arc::new(|_|{}),Arc::new(move |_| {delivered.fetch_add(1,Ordering::SeqCst);Ok(())}),Arc::new(||false)).unwrap()
    }
    fn snapshot(file: &str,state: &str) -> Snapshot {Snapshot{workspace_id:"w".into(),url:"http://localhost:8765/".into(),connected:true,repository:"example/repo".into(),running_count:1,paused:false,reports:vec![review_service::Report{file:file.into(),state:state.into(),prs:vec![1],pending:0}],error:None,history_gap:false}}
    #[test]
    fn first_connection_is_a_baseline_then_only_new_terminal_results_notify() {
        let delivered=Arc::new(AtomicUsize::new(0));let host=host(delivered.clone());host.observe_review(snapshot("round-old.json","succeeded")).unwrap();assert!(host.snapshot().unwrap().notices.is_empty());
        host.observe_review(snapshot("round-new.json","running")).unwrap();host.observe_review(snapshot("round-new.json","succeeded")).unwrap();host.observe_review(snapshot("round-new.json","succeeded")).unwrap();assert_eq!(host.snapshot().unwrap().notices.len(),1);
        host.deliver_pending();host.deliver_pending();assert_eq!(delivered.load(Ordering::SeqCst),1);
    }
    #[test]
    fn shared_service_keeps_each_workspace_inbox_but_sends_one_os_notice() {
        let delivered=Arc::new(AtomicUsize::new(0));let host=host(delivered.clone());
        for workspace in ["w","other"] {let mut baseline=snapshot("round-old.json","succeeded");baseline.workspace_id=workspace.into();host.observe_review(baseline).unwrap();let mut next=snapshot("round-new.json","failed");next.workspace_id=workspace.into();host.observe_review(next).unwrap();}
        assert_eq!(host.snapshot().unwrap().notices.len(),2);host.deliver_pending();assert_eq!(delivered.load(Ordering::SeqCst),1);
    }
    #[test]
    fn disconnect_retains_last_task_state_instead_of_finishing_it() {
        let host=host(Arc::new(AtomicUsize::new(0)));host.observe_review(snapshot("round-a.json","running")).unwrap();host.disconnect("w","http://localhost:8765/","offline".into()).unwrap();let state=host.snapshot().unwrap();assert!(!state.reviews["w"].connected);assert_eq!(state.reviews["w"].running_count,1);assert!(state.notices.is_empty());
    }
    #[test]
    fn agent_history_is_not_replayed_and_unread_notifications_survive_restart() {
        let host=host(Arc::new(AtomicUsize::new(0)));let mut session:AgentSession=serde_json::from_value(json!({"id":"s","workspaceId":"w","nodeId":null,"backend":"codex","title":"Work","cwd":"x","sourceId":"t","createdAt":0,"revision":1,"messages":[],"requests":[],"error":null,"runs":[{"id":"r","state":"running","startedAt":0,"finishedAt":null,"sourceTurnId":"t","error":null}]})).unwrap();host.observe_agent(&session).unwrap();session.runs[0].state="succeeded".into();host.observe_agent(&session).unwrap();host.observe_agent(&session).unwrap();assert_eq!(host.snapshot().unwrap().notices.len(),1);
        let restored=Background::open(host.store.clone(),Arc::new(|_|{}),Arc::new(|_|Ok(())),Arc::new(||false)).unwrap();assert_eq!(restored.snapshot().unwrap().notices.len(),1);let id=restored.snapshot().unwrap().notices[0].id.clone();restored.mark_read(&[id]).unwrap();assert!(restored.snapshot().unwrap().notices[0].read);
    }
}
