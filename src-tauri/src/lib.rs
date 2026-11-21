mod domain;
mod store;
mod backup;
mod agent_backup;
mod workspaces;
mod native_browser;
pub mod native_agents;
mod workspace_state;
mod knowledge;
mod local_services;
mod review_service;
mod background;
mod resources;
mod map_ops;
mod plugins;
mod workspace_tools;
pub use workspace_tools::cli as workspace_tools_cli;
pub use workspace_tools::definitions as workspace_tool_definitions;
pub use store::Store as WorkbenchStore;
pub use backup::{create as create_full_backup,restore as restore_full_backup};
use crate::store::{Store,Result,error};
use serde_json::{json,Value};
use std::{fs, path::PathBuf, sync::{Arc,atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter,Manager,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

struct AppState {store:Arc<Store>,quit:AtomicBool}
#[tauri::command]
fn load_plugins(state:tauri::State<'_,AppState>)->Result<Value>{plugins::load(&state.store)}
#[tauri::command]
fn change_plugins(state:tauri::State<'_,AppState>,app:tauri::AppHandle,operation:Value)->Result<Value>{let registry=plugins::change(&state.store,&operation)?;let _=app.emit("northstar-plugins-changed",());Ok(registry)}
#[tauri::command]
async fn collect_knowledge(state:tauri::State<'_,AppState>)->Result<usize>{knowledge::collect(&state.store)}
#[tauri::command]
async fn graph_changes(state: tauri::State<'_, AppState>, after: u64) -> Result<Vec<map_ops::Operation>> {let db=state.store.db.lock().map_err(error)?;map_ops::changes(&db,after)}
#[tauri::command]
async fn background_snapshot(state: tauri::State<'_, Arc<background::Background>>) -> Result<background::State> {state.snapshot()}
#[tauri::command]
async fn background_read(state: tauri::State<'_, Arc<background::Background>>, ids: Vec<String>) -> Result<()> {state.mark_read(&ids)}
#[tauri::command]
async fn review_report(state: tauri::State<'_, Arc<background::Background>>, workspace_id: String, file: String, url: String) -> Result<Value> {state.report(&workspace_id,&file,&url)}
#[tauri::command]
async fn local_web_services(on_service: tauri::ipc::Channel<local_services::LocalService>) -> Result<Vec<local_services::LocalService>> {
    tauri::async_runtime::spawn_blocking(move || local_services::discover(|service| {
        let _ = on_service.send(service);
    })).await.map_err(error)?
}
#[tauri::command]
async fn load_shell_state(state: tauri::State<'_, AppState>) -> Result<Option<Value>> {workspace_state::load(&state.store)}
#[tauri::command]
fn html_preview(previews:tauri::State<'_,knowledge::HtmlPreviews>,body:String)->Result<String>{previews.create(body)}
#[tauri::command]
fn close_html_preview(previews:tauri::State<'_,knowledge::HtmlPreviews>,token:String){previews.remove(&token);}
#[tauri::command]
async fn save_shell_state(state: tauri::State<'_, AppState>, agents:tauri::State<'_,Arc<native_agents::AgentHost>>, snapshot: Value) -> Result<()> {workspace_state::save(&state.store, &snapshot)?;agents.reconcile_nodes(&snapshot)}
#[tauri::command]
async fn agent_backends() -> Result<Vec<native_agents::Backend>> {tauri::async_runtime::spawn_blocking(native_agents::backends).await.map_err(error)}
#[tauri::command]
async fn agent_model_options(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String) -> Result<native_agents::ModelOptions> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.model_options(&id)).await.map_err(error)?
}
#[tauri::command]
async fn agent_prefetch_model_options(state: tauri::State<'_, Arc<native_agents::AgentHost>>, backend: String, workspace_id: String, cwd: Option<String>) -> Result<()> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.prefetch_model_options(backend, workspace_id, cwd)).await.map_err(error)?
}
#[tauri::command]
async fn agent_list(state: tauri::State<'_, Arc<native_agents::AgentHost>>) -> Result<Vec<native_agents::AgentSession>> {state.list()}
#[tauri::command]
async fn agent_get(state: tauri::State<'_, Arc<native_agents::AgentHost>>,id:String) -> Result<native_agents::AgentSession> {state.session(&id)}
#[tauri::command]
async fn read_workspace_html(state:tauri::State<'_,AppState>,workspace_id:String,path:String)->Result<resources::TextFile>{
    let store=state.store.clone();tauri::async_runtime::spawn_blocking(move||resources::workspace_html(&store,&workspace_id,&path)).await.map_err(error)?
}
#[tauri::command]
async fn agent_rename(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, title: String) -> Result<native_agents::AgentSession> {state.rename(&id,&title)}
#[tauri::command]
async fn agent_delete(state: tauri::State<'_, Arc<native_agents::AgentHost>>, ids: Vec<String>, workspace_id: Option<String>) -> Result<Vec<String>> {let host=state.inner().clone();tauri::async_runtime::spawn_blocking(move||host.delete(&ids,workspace_id.as_deref())).await.map_err(error)?}
#[tauri::command]
async fn open_session_path(state:tauri::State<'_,AppState>,agents:tauri::State<'_,Arc<native_agents::AgentHost>>,id:String,path:String)->Result<()>{
    let session=agents.session(&id)?;let store=state.store.clone();
    tauri::async_runtime::spawn_blocking(move||{let path=resources::session_target(&store,&session.workspace_id,&session.cwd,&path)?;open::that(resources::display_path(&path)).map_err(error)}).await.map_err(error)?
}
#[tauri::command]
async fn agent_create(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, workspace_id: String, node_id: Option<String>, backend: String, title: String, cwd: Option<String>) -> Result<native_agents::AgentSession> {let host=state.inner().clone();tauri::async_runtime::spawn_blocking(move||host.create(id, workspace_id, node_id, backend, title, cwd)).await.map_err(error)?}
#[tauri::command]
async fn agent_send(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, run_id: String, text: String, model: Option<String>, effort: Option<String>, files: Option<Vec<native_agents::ChatFile>>) -> Result<native_agents::AgentSession> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.send_with_options(&id, run_id, text, model, effort, files.unwrap_or_default())).await.map_err(error)?
}
#[tauri::command]
async fn agent_file_suggestions(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, query: String) -> Result<Vec<native_agents::FileSuggestion>> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.suggest_files(&id, &query)).await.map_err(error)?
}
#[tauri::command]
async fn read_material(state: tauri::State<'_, AppState>, workspace_id: String, node_id: String, material_id: String) -> Result<resources::TextFile> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || resources::read_manual_material(&store, &workspace_id, &node_id, &material_id))
        .await.map_err(error)?
}
#[tauri::command]
async fn open_material(state: tauri::State<'_, AppState>, workspace_id: String, node_id: String, material_id: String) -> Result<()> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || match resources::manual_material_open(&store, &workspace_id, &node_id, &material_id)? {
        resources::MaterialOpen::File(path) => open_local_document(&path),
        resources::MaterialOpen::Obsidian(url) => open::that(url.as_str()).map_err(error),
    }).await.map_err(error)?
}
fn open_local_document(path: &std::path::Path) -> Result<()> {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let viewer_format = ["html", "htm", "md", "markdown", "txt", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg",
        "gif", "webp", "svg", "csv", "log", "json", "yaml", "yml", "toml", "excalidraw", "mindmap"];
    if path.is_dir() || viewer_format.contains(&ext.as_str()) {
        return open::that(resources::display_path(path)).map_err(error);
    }
    #[cfg(windows)]
    { std::process::Command::new("explorer.exe").arg(format!("/select,{}", resources::display_path(path))).spawn().map(|_|()).map_err(error) }
    #[cfg(not(windows))]
    { open::that(path.parent().ok_or("文件目录无效")?).map_err(error) }
}
#[tauri::command]
async fn git_changed_files(state: tauri::State<'_, AppState>, workspace_id: String) -> Result<Vec<String>> {resources::git_files(&state.store,&workspace_id)}
#[tauri::command]
async fn git_file_diff(state: tauri::State<'_, AppState>, workspace_id: String, file: String) -> Result<Vec<resources::TextFile>> {resources::git_diff(&state.store,&workspace_id,&file)}
#[tauri::command]
async fn agent_stop(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String) -> Result<native_agents::AgentSession> {let host=state.inner().clone();tauri::async_runtime::spawn_blocking(move||host.stop(&id)).await.map_err(error)?}
#[tauri::command]
async fn agent_respond(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, request_id: String, answer: Value) -> Result<native_agents::AgentSession> {let host=state.inner().clone();tauri::async_runtime::spawn_blocking(move||host.respond(&id,&request_id,answer)).await.map_err(error)?}
#[tauri::command]
fn load_workspace(state:tauri::State<AppState>)->Result<store::WorkbenchData>{state.store.load()}
#[tauri::command]
fn save_workspace_layout(layout:Value,state:tauri::State<AppState>)->Result<()>{state.store.put_workspace_layout(&layout)}
#[tauri::command]
fn save_record(record:Value,state:tauri::State<AppState>)->Result<Value>{state.store.save(record)}
#[tauri::command]
fn check_habit(id:String,day:String,checked:bool,state:tauri::State<AppState>)->Result<Value>{state.store.check_habit(&id,&day,checked)}
#[tauri::command]
fn archive_record(id:String,restore:bool,state:tauri::State<AppState>)->Result<()>{state.store.archive(&id,restore)}
#[tauri::command]
fn delete_record(id:String,state:tauri::State<AppState>)->Result<()>{state.store.delete(&id)}
#[tauri::command]
fn delete_knowledge(id:String,version:u64,state:tauri::State<AppState>)->Result<()>{state.store.delete_knowledge(&id,version)}
#[tauri::command]
fn save_settings(settings:domain::Settings,app:tauri::AppHandle,state:tauri::State<AppState>)->Result<()> {
    let previous=state.store.load()?.settings;
    if previous.auto_start!=settings.auto_start {
        if settings.auto_start {app.autolaunch().enable().map_err(error)?;} else {app.autolaunch().disable().map_err(error)?;}
    }
    if let Err(e)=state.store.put_settings(&settings) {
        if previous.auto_start!=settings.auto_start {if previous.auto_start{let _=app.autolaunch().enable();}else{let _=app.autolaunch().disable();}}
        return Err(e);
    }
    Ok(())
}
#[tauri::command]
fn list_backups(state:tauri::State<AppState>)->Result<Vec<backup::BackupInfo>>{backup::list(&state.store)}
#[tauri::command]
async fn create_backup(state:tauri::State<'_,AppState>,agents:tauri::State<'_,Arc<native_agents::AgentHost>>)->Result<backup::BackupInfo>{agents.checkpoint_all()?;let store=state.store.clone();tauri::async_runtime::spawn_blocking(move||backup::create(&store,"manual")).await.map_err(error)?}
#[tauri::command]
async fn restore_backup(name:Option<String>,path:Option<String>,app:tauri::AppHandle,state:tauri::State<'_,AppState>)->Result<()> {
    let store=state.store.clone();let source=if let Some(name)=name {backup::resolve_backup(&store,&name)?} else {PathBuf::from(path.ok_or("请选择备份文件")?)};
    if store.maintenance.swap(true,Ordering::SeqCst){return Err("已有恢复操作正在进行".into());}
    let agents=app.state::<Arc<native_agents::AgentHost>>().inner().clone();
    let preparing_agents = agents.clone();
    let restore = tauri::async_runtime::spawn_blocking(move || preparing_agents.prepare_restore()).await.map_err(error).and_then(|result| result);
    if let Err(error)=restore{agents.cancel_restore();store.maintenance.store(false,Ordering::SeqCst);for session in agents.list().unwrap_or_default(){let _=app.state::<Arc<background::Background>>().observe_agent(&session);}return Err(error);}
    let restoring_store=store.clone();let result=tauri::async_runtime::spawn_blocking(move||backup::restore(&restoring_store,&source)).await.map_err(error).and_then(|result|result);
    if let Err(error)=result{if !error.contains("[recovery-required]"){agents.cancel_restore();store.maintenance.store(false,Ordering::SeqCst);for session in agents.list().unwrap_or_default(){let _=app.state::<Arc<background::Background>>().observe_agent(&session);}}return Err(error);}
    let mut settings=store.load()?.settings;if let Ok(enabled)=app.autolaunch().is_enabled(){settings.auto_start=enabled;}
    {let db=store.db.lock().map_err(error)?;db.execute("UPDATE settings SET data=?1 WHERE id=1",[serde_json::to_string(&settings).map_err(error)?]).map_err(error)?;db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('restore-show-once','true')",[]).map_err(error)?;}
    state.quit.store(true,Ordering::SeqCst);app.restart();
}
#[tauri::command]
fn export_backup(name:String,path:String,state:tauri::State<AppState>)->Result<()> {
    let source=backup::resolve_backup(&state.store,&name)?;
    if PathBuf::from(&path).extension().and_then(|e|e.to_str())!=Some("zip"){return Err("请选择 .zip 文件".into());}
    fs::copy(source,path).map_err(error)?;Ok(())
}
#[tauri::command]
fn export_records(path:String,state:tauri::State<AppState>)->Result<()> {
    if PathBuf::from(&path).extension().and_then(|e|e.to_str())!=Some("json"){return Err("请选择 .json 文件".into());}
    let work=state.store.load()?;
    let data=json!({"format":"northstar-records","version":1,"exportedAt":domain::now(),"records":work.records});
    fs::write(path,serde_json::to_vec_pretty(&data).map_err(error)?).map_err(error)
}
#[tauri::command]
fn add_attachment(path:String,entity_id:Option<String>,state:tauri::State<AppState>)->Result<store::Attachment> {
    let store=&state.store;let source=PathBuf::from(path);let meta=fs::metadata(&source).map_err(error)?;
    if !meta.is_file() || meta.len()>256_000_000 {return Err("请选择不超过 256 MB 的文件".into());}
    let db=store.write_db()?;
    if let Some(ref entity)=entity_id {let record=store::get(&db,entity)?.ok_or("关联记录不存在")?;if record["archived"]==true{return Err("请先恢复关联记录".into());}}
    let id=uuid::Uuid::new_v4().to_string();let extension=source.extension().and_then(|e|e.to_str()).filter(|e|e.len()<20&&e.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin");
    let item=store::Attachment{id:id.clone(),name:source.file_name().ok_or("文件名无效")?.to_string_lossy().into(),size:meta.len(),stored_name:format!("{id}.{extension}"),entity_id,created_at:domain::now()};
    let target=backup::attachment_path(store,&item.stored_name)?;fs::copy(&source,&target).map_err(error)?;
    if let Err(e)=db.execute("INSERT INTO attachments(id,data) VALUES(?1,?2)",rusqlite::params![id,serde_json::to_string(&item).map_err(error)?]) {let _=fs::remove_file(target);return Err(error(e));}
    Ok(item)
}
#[tauri::command]
fn open_attachment(id:String,state:tauri::State<AppState>)->Result<()> {
    let store=&state.store;let db=store.write_db()?;let item=store::attachments(&db)?.into_iter().find(|a|a.id==id).ok_or("附件不存在")?;
    let path=backup::attachment_path(store,&item.stored_name)?;if !path.is_file(){return Err("附件文件丢失，请从备份恢复".into());}
    let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ["exe","com","bat","cmd","ps1","vbs","js","msi","scr","lnk","hta"].contains(&ext.as_str()) {return Err("可执行附件请从数据目录手动打开".into());}
    open::that(path).map_err(error)
}
#[tauri::command]
fn remove_attachment(id:String,state:tauri::State<AppState>)->Result<()> {
    let store=&state.store;let db=store.write_db()?;let item=store::attachments(&db)?.into_iter().find(|a|a.id==id).ok_or("附件不存在")?;
    let path=backup::attachment_path(store,&item.stored_name)?;
    if path.exists(){fs::remove_file(path).map_err(error)?;}db.execute("DELETE FROM attachments WHERE id=?1",[id]).map_err(error)?;Ok(())
}
#[tauri::command]
fn open_data_folder(state:tauri::State<AppState>)->Result<()> {open::that(&state.store.root).map_err(error)}
#[tauri::command]
fn open_external_url(url:String)->Result<()> {open::that(domain::external_url(&url)?).map_err(error)}
#[tauri::command]
fn open_web_workspace(url:String)->Result<()> {open::that(domain::edge_workspace_url(&url)?).map_err(error)}
#[tauri::command]
fn export_markdown(id:String,path:String,state:tauri::State<AppState>)->Result<()> {
    if PathBuf::from(&path).extension().and_then(|e|e.to_str()).is_none_or(|e|!e.eq_ignore_ascii_case("md")){return Err("请选择 .md 文件".into());}
    let db=state.store.db.lock().map_err(error)?;let record=store::get(&db,&id)?.ok_or("笔记不存在")?;
    if domain::text(&record,"kind")!="note"{return Err("只有笔记可以导出 Markdown".into());}
    fs::write(path,domain::text(&record,"body").as_bytes()).map_err(error)
}
#[tauri::command]
fn test_notification(app:tauri::AppHandle)->Result<()> {app.notification().builder().title("Draftway · 提醒测试").body("提醒服务已连接。托盘运行期间会继续检查任务和节点提醒。").show().map_err(error)}
#[tauri::command]
fn export_drawing_file(path:String,bytes:Vec<u8>)->Result<()> {
    if PathBuf::from(&path).extension().and_then(|e|e.to_str()).is_none_or(|e|!["excalidraw","png","svg","html","md","mindmap"].contains(&e.to_ascii_lowercase().as_str())){return Err("请选择 .excalidraw、.png、.svg、.html、.md 或 .mindmap 文件".into());}
    if bytes.len()>50_000_000{return Err("导出文件超过 50 MB".into());}
    fs::write(path,bytes).map_err(error)
}
#[tauri::command]
fn quit_app(app:tauri::AppHandle,state:tauri::State<AppState>){state.quit.store(true,Ordering::SeqCst);app.exit(0);}

fn send_workspace_notice(app: &tauri::AppHandle, notice: &background::Notice) -> Result<()> {
    #[cfg(windows)] {
        let target_app=app.clone(); let id=notice.id.clone();
        tauri_winrt_notification::Toast::new(&app.config().identifier).title(&format!("Draftway · {}",notice.title)).text1(&notice.body).on_activated(move |_| {reveal(&target_app); let _=target_app.emit_to("main","notice-activate",id.clone()); Ok(())}).show().map_err(error)
    }
    #[cfg(not(windows))] {app.notification().builder().title(&notice.title).body(&notice.body).show().map_err(error)}
}
fn reveal(app:&tauri::AppHandle){if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.unminimize();let _=w.set_focus();}}
fn start_services(app:tauri::AppHandle,store:Arc<Store>) {
    std::thread::spawn(move||{
        let mut last_backup=String::new();
        loop {
            if !store.maintenance.load(Ordering::SeqCst) {if let Ok(work)=store.load() {
                if work.settings.notifications {
                    let now=chrono::Utc::now();
                    for record in work.records.iter().filter(|r|r["archived"]!=true&&r["status"]!="done"&&["task","milestone"].contains(&domain::text(r,"kind"))) {
                        let remind=domain::text(record,"remindAt");
                        if let Ok(time)=chrono::DateTime::parse_from_rfc3339(remind) {
                            if time>now {continue;}
                            let token=match domain::reminder_token(domain::text(record,"id"),remind){Ok(token)=>token,Err(_)=>continue};
                            let db=match store.write_db(){Ok(db)=>db,Err(_)=>continue};
                            let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM reminders WHERE token=?1)",[&token],|r|r.get(0)).unwrap_or(true);
                            if exists{continue;}
                            if app.notification().builder().title("Draftway · 该推进了").body(domain::text(record,"title")).show().is_ok() {
                                let _=db.execute("INSERT OR IGNORE INTO reminders(token,delivered_at) VALUES(?1,?2)",rusqlite::params![token,domain::now()]);
                                let _=app.emit("reminder",json!({"id":record["id"],"title":record["title"]}));
                            }
                        }
                    }
                }
                let today=chrono::Local::now().format("%Y-%m-%d").to_string();
                if work.settings.daily_backup && today!=last_backup {
                    let existing=backup::list(&store).unwrap_or_default().iter().any(|b|b.name.contains("-daily-")&&b.name.contains(&chrono::Local::now().format("%Y%m%d").to_string()));
                    if existing || backup::create(&store,"daily").is_ok(){last_backup=today;}
                }
            }
            }std::thread::sleep(std::time::Duration::from_secs(10));
        }
    });
}
pub fn run() {
    let application=tauri::Builder::default()
        .manage(knowledge::HtmlPreviews::default())
        .register_uri_scheme_protocol("knowledge",|context,request|context.app_handle().state::<knowledge::HtmlPreviews>().response(request.uri().path().trim_start_matches('/')))
        .manage(native_browser::Browsers::default())
        .plugin(tauri_plugin_single_instance::init(|app,args,_|{if args.iter().any(|a|a=="--quit"){app.state::<AppState>().quit.store(true,Ordering::SeqCst);app.exit(0);}else{reveal(app);}}))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,Some(vec!["--tray"])))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED).build())
        .setup(|app|{
            let data=if cfg!(debug_assertions) {std::env::var_os("NORTHSTAR_DATA_DIR").map(PathBuf::from)} else {None};
            let store=Arc::new(Store::open(data.unwrap_or(app.path().app_data_dir()?)).map_err(std::io::Error::other)?);
            backup::recover_interrupted(&store).map_err(std::io::Error::other)?;
            store.seed_if_new().map_err(std::io::Error::other)?;
            let restored={let db=store.db.lock().map_err(|e|std::io::Error::other(e.to_string()))?;let changed=db.execute("DELETE FROM metadata WHERE key='restore-show-once'",[]).map_err(std::io::Error::other)?;changed>0};
            app.manage(AppState{store:store.clone(),quit:AtomicBool::new(false)});
            let background_app = app.handle().clone();
            let delivery_app = app.handle().clone();
            let foreground_app = app.handle().clone();
            let background = background::Background::open(store.clone(), Arc::new(move |state| {let _ = background_app.emit_to("main","background-state",state);}), Arc::new(move |notice| send_workspace_notice(&delivery_app,notice)), Arc::new(move || foreground_app.get_webview("main").is_some_and(|view| view.window().is_visible().unwrap_or(false) && view.window().is_focused().unwrap_or(false)))).map_err(std::io::Error::other)?;
            let agent_app = app.handle().clone(); let agent_background = background.clone();
            let agents = native_agents::AgentHost::open(store.root.join("agents"), Arc::new(move |session| {let _ = agent_background.observe_agent(session); let _ = agent_app.emit_to("main", "agent-session", session);})).map_err(std::io::Error::other)?;
            let transcript_app=app.handle().clone();agents.configure_transcript_sink(Arc::new(move |frame|{let _=transcript_app.emit_to("main","agent-transcript",frame);}));
            let catalog_app=app.handle().clone();
            agents.configure_model_catalog_sink(Arc::new(move |backend,cwd| {
                let _ = catalog_app.emit_to("main", "agent-model-catalog", serde_json::json!({"backend":backend,"cwd":cwd}));
            }));
            agents.configure_tools(native_agents::WorkspaceTools{executable:std::env::current_exe()?,root:store.root.clone(),definitions:workspace_tools::definitions()});
            for session in agents.list().map_err(std::io::Error::other)? {background.observe_agent(&session).map_err(std::io::Error::other)?;}
            app.manage(agents); app.manage(background.clone()); background.start();
            let show=MenuItem::with_id(app,"show","打开 Draftway",true,None::<&str>)?;
            let quick=MenuItem::with_id(app,"new","新建任务",true,None::<&str>)?;
            let quit=MenuItem::with_id(app,"quit","退出",true,None::<&str>)?;
            let preview=app.config().identifier.ends_with(".preview");let menu=if preview{Menu::with_items(app,&[&show,&quit])?}else{Menu::with_items(app,&[&show,&quick,&quit])?};
            TrayIconBuilder::new().icon(app.default_window_icon().ok_or("应用图标缺失")?.clone()).tooltip(if preview{"Draftway · 工作区预览"}else{"Draftway · 个人工作台"}).menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app,event|match event.id.as_ref(){"show"=>reveal(app),"new"=>{reveal(app);let _=app.emit("quick-capture",());},"quit"=>{app.state::<AppState>().quit.store(true,Ordering::SeqCst);app.exit(0);},_=>()})
                .on_tray_icon_event(|tray,event|{if let TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}=event{reveal(tray.app_handle());}}).build(app)?;
            let reveal_after_restore = restored && app.config().app.windows.iter()
                .find(|window| window.label == "main").is_none_or(|window| window.visible);
            if std::env::args().any(|a| a == "--tray") && !reveal_after_restore {
                if let Some(window) = app.get_webview_window("main") {let _ = window.hide();}
            }
            if reveal_after_restore {reveal(app.handle());}
            start_services(app.handle().clone(),store);Ok(())
        })
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                let state=window.state::<AppState>();
                if !state.quit.load(Ordering::SeqCst)&&state.store.load().map(|w|w.settings.close_to_tray).unwrap_or(false){api.prevent_close();let _=window.hide();}
            }
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![load_plugins,change_plugins,html_preview,close_html_preview,collect_knowledge,load_workspace,save_workspace_layout,save_record,check_habit,archive_record,delete_record,delete_knowledge,save_settings,list_backups,create_backup,restore_backup,export_backup,export_records,export_markdown,export_drawing_file,open_external_url,open_web_workspace,add_attachment,open_attachment,remove_attachment,open_data_folder,test_notification,quit_app,native_browser::sync_browser_views,native_browser::browser_action,native_browser::browser_history,agent_backends,agent_model_options,agent_prefetch_model_options,agent_list,agent_get,read_workspace_html,agent_rename,agent_delete,open_session_path,agent_create,agent_send,agent_file_suggestions,agent_stop,agent_respond,load_shell_state,save_shell_state,background_snapshot,background_read,review_report,local_web_services,read_material,open_material,git_changed_files,git_file_diff,graph_changes];
            move |invoke| {
                if invoke.message.webview_ref().label() != "main" {invoke.resolver.reject("网页不能访问 Draftway 宿主命令"); return true;}
                if invoke.message.webview_ref().state::<AppState>().store.maintenance.load(Ordering::SeqCst)&&invoke.message.command()!="quit_app"{invoke.resolver.reject("正在恢复数据，暂时停止写入");return true;}
                handler(invoke)
            }
        })
        .build(tauri::generate_context!());
    match application{Ok(application)=>application.run(|app, event| {if let tauri::RunEvent::Exit = event {app.state::<Arc<background::Background>>().stop(); app.state::<Arc<native_agents::AgentHost>>().shutdown();}}),Err(error)=>{
        #[cfg(windows)]unsafe{use windows::{core::{HSTRING,PCWSTR},Win32::UI::WindowsAndMessaging::{MessageBoxW,MB_OK,MB_ICONERROR}};let text=HSTRING::from(format!("无法打开 Draftway。\n\n{error}\n\n请保留数据目录和备份后重试。"));let title=HSTRING::from("Draftway");let _=MessageBoxW(None,PCWSTR(text.as_ptr()),PCWSTR(title.as_ptr()),MB_OK|MB_ICONERROR);}
        #[cfg(not(windows))]eprintln!("Draftway 启动失败：{error}");
    }}
}
