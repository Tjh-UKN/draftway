mod domain;
mod store;
mod backup;
mod workspaces;
mod native_browser;
mod native_agents;
mod workspace_state;
use crate::store::{Store,Result,error};
use serde_json::{json,Value};
use std::{fs, path::PathBuf, sync::{Arc,atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter,Manager,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

struct AppState {store:Arc<Store>,quit:AtomicBool}
#[tauri::command]
async fn load_shell_state(state: tauri::State<'_, AppState>) -> Result<Option<Value>> {workspace_state::load(&state.store)}
#[tauri::command]
async fn save_shell_state(state: tauri::State<'_, AppState>, snapshot: Value) -> Result<()> {workspace_state::save(&state.store, &snapshot)}
#[tauri::command]
async fn agent_backends() -> Vec<native_agents::Backend> {native_agents::backends()}
#[tauri::command]
async fn agent_list(state: tauri::State<'_, Arc<native_agents::AgentHost>>) -> Result<Vec<native_agents::AgentSession>> {state.list()}
#[tauri::command]
async fn agent_create(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, workspace_id: String, node_id: Option<String>, backend: String, title: String, cwd: Option<String>) -> Result<native_agents::AgentSession> {state.create(id, workspace_id, node_id, backend, title, cwd)}
#[tauri::command]
async fn agent_send(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, run_id: String, text: String) -> Result<native_agents::AgentSession> {state.inner().send(&id, run_id, text)}
#[tauri::command]
async fn agent_stop(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String) -> Result<native_agents::AgentSession> {state.stop(&id)}
#[tauri::command]
async fn agent_respond(state: tauri::State<'_, Arc<native_agents::AgentHost>>, id: String, request_id: String, answer: Value) -> Result<native_agents::AgentSession> {state.respond(&id, &request_id, answer)}
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
async fn create_backup(state:tauri::State<'_,AppState>)->Result<backup::BackupInfo>{let store=state.store.clone();tauri::async_runtime::spawn_blocking(move||backup::create(&store,"manual")).await.map_err(error)?}
#[tauri::command]
async fn restore_backup(name:Option<String>,path:Option<String>,app:tauri::AppHandle,state:tauri::State<'_,AppState>)->Result<()> {
    let store=state.store.clone();let source=if let Some(name)=name {backup::resolve_backup(&store,&name)?} else {PathBuf::from(path.ok_or("请选择备份文件")?)};
    tauri::async_runtime::spawn_blocking(move||backup::restore(&store,&source)).await.map_err(error)??;
    let loaded=state.store.load()?;let enabled=app.autolaunch().is_enabled().map_err(error)?;
    if enabled!=loaded.settings.auto_start {let mut s=loaded.settings;s.auto_start=enabled;state.store.put_settings(&s)?;}
    app.emit("workspace-changed",()).map_err(error)?;Ok(())
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
    let db=store.db.lock().map_err(error)?;
    if let Some(ref entity)=entity_id {let record=store::get(&db,entity)?.ok_or("关联记录不存在")?;if record["archived"]==true{return Err("请先恢复关联记录".into());}}
    let id=uuid::Uuid::new_v4().to_string();let extension=source.extension().and_then(|e|e.to_str()).filter(|e|e.len()<20&&e.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin");
    let item=store::Attachment{id:id.clone(),name:source.file_name().ok_or("文件名无效")?.to_string_lossy().into(),size:meta.len(),stored_name:format!("{id}.{extension}"),entity_id,created_at:domain::now()};
    let target=backup::attachment_path(store,&item.stored_name)?;fs::copy(&source,&target).map_err(error)?;
    if let Err(e)=db.execute("INSERT INTO attachments(id,data) VALUES(?1,?2)",rusqlite::params![id,serde_json::to_string(&item).map_err(error)?]) {let _=fs::remove_file(target);return Err(error(e));}
    Ok(item)
}
#[tauri::command]
fn open_attachment(id:String,state:tauri::State<AppState>)->Result<()> {
    let store=&state.store;let db=store.db.lock().map_err(error)?;let item=store::attachments(&db)?.into_iter().find(|a|a.id==id).ok_or("附件不存在")?;
    let path=backup::attachment_path(store,&item.stored_name)?;if !path.is_file(){return Err("附件文件丢失，请从备份恢复".into());}
    let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ["exe","com","bat","cmd","ps1","vbs","js","msi","scr","lnk","hta"].contains(&ext.as_str()) {return Err("可执行附件请从数据目录手动打开".into());}
    open::that(path).map_err(error)
}
#[tauri::command]
fn remove_attachment(id:String,state:tauri::State<AppState>)->Result<()> {
    let store=&state.store;let db=store.db.lock().map_err(error)?;let item=store::attachments(&db)?.into_iter().find(|a|a.id==id).ok_or("附件不存在")?;
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
fn test_notification(app:tauri::AppHandle)->Result<()> {app.notification().builder().title("北极星 · 提醒测试").body("提醒服务已连接。托盘运行期间会继续检查任务和节点提醒。").show().map_err(error)}
#[tauri::command]
fn export_drawing_file(path:String,bytes:Vec<u8>)->Result<()> {
    if PathBuf::from(&path).extension().and_then(|e|e.to_str()).is_none_or(|e|!["excalidraw","png","svg"].contains(&e.to_ascii_lowercase().as_str())){return Err("请选择 .excalidraw、.png 或 .svg 文件".into());}
    if bytes.len()>50_000_000{return Err("导出文件超过 50 MB".into());}
    fs::write(path,bytes).map_err(error)
}
#[tauri::command]
fn quit_app(app:tauri::AppHandle,state:tauri::State<AppState>){state.quit.store(true,Ordering::SeqCst);app.exit(0);}

fn reveal(app:&tauri::AppHandle){if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.unminimize();let _=w.set_focus();}}
fn start_services(app:tauri::AppHandle,store:Arc<Store>) {
    std::thread::spawn(move||{
        let mut last_backup=String::new();
        loop {
            if let Ok(work)=store.load() {
                if work.settings.notifications {
                    let now=chrono::Utc::now();
                    for record in work.records.iter().filter(|r|r["archived"]!=true&&r["status"]!="done"&&["task","milestone"].contains(&domain::text(r,"kind"))) {
                        let remind=domain::text(record,"remindAt");
                        if let Ok(time)=chrono::DateTime::parse_from_rfc3339(remind) {
                            if time>now {continue;}
                            let token=match domain::reminder_token(domain::text(record,"id"),remind){Ok(token)=>token,Err(_)=>continue};
                            let db=match store.db.lock(){Ok(db)=>db,Err(_)=>continue};
                            let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM reminders WHERE token=?1)",[&token],|r|r.get(0)).unwrap_or(true);
                            if exists{continue;}
                            if app.notification().builder().title("北极星 · 该推进了").body(domain::text(record,"title")).show().is_ok() {
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
            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    });
}
pub fn run() {
    tauri::Builder::default()
        .manage(native_browser::Browsers::default())
        .plugin(tauri_plugin_single_instance::init(|app,args,_|{if args.iter().any(|a|a=="--quit"){app.state::<AppState>().quit.store(true,Ordering::SeqCst);app.exit(0);}else{reveal(app);}}))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,Some(vec!["--tray"])))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED).build())
        .setup(|app|{
            let data=if cfg!(debug_assertions) {std::env::var_os("NORTHSTAR_DATA_DIR").map(PathBuf::from)} else {None};
            let store=Arc::new(Store::open(data.unwrap_or(app.path().app_data_dir()?)).map_err(std::io::Error::other)?);
            store.seed_if_new().map_err(std::io::Error::other)?;
            app.manage(AppState{store:store.clone(),quit:AtomicBool::new(false)});
            let agent_app = app.handle().clone();
            app.manage(native_agents::AgentHost::open(store.root.join("agents"), Arc::new(move |session| {let _ = agent_app.emit_to("main", "agent-session", session);})).map_err(std::io::Error::other)?);
            let show=MenuItem::with_id(app,"show","打开北极星",true,None::<&str>)?;
            let quick=MenuItem::with_id(app,"new","新建任务",true,None::<&str>)?;
            let quit=MenuItem::with_id(app,"quit","退出",true,None::<&str>)?;
            let menu=Menu::with_items(app,&[&show,&quick,&quit])?;
            TrayIconBuilder::new().icon(app.default_window_icon().ok_or("应用图标缺失")?.clone()).tooltip("北极星 · 个人工作台").menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app,event|match event.id.as_ref(){"show"=>reveal(app),"new"=>{reveal(app);let _=app.emit("quick-capture",());},"quit"=>{app.state::<AppState>().quit.store(true,Ordering::SeqCst);app.exit(0);},_=>()})
                .on_tray_icon_event(|tray,event|{if let TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}=event{reveal(tray.app_handle());}}).build(app)?;
            if std::env::args().any(|a|a=="--tray") {if let Some(w)=app.get_webview_window("main"){let _=w.hide();}}
            start_services(app.handle().clone(),store);Ok(())
        })
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                let state=window.state::<AppState>();
                if !state.quit.load(Ordering::SeqCst)&&state.store.load().map(|w|w.settings.close_to_tray).unwrap_or(false){api.prevent_close();let _=window.hide();}
            }
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![load_workspace,save_workspace_layout,save_record,check_habit,archive_record,delete_record,save_settings,list_backups,create_backup,restore_backup,export_backup,export_records,export_markdown,export_drawing_file,open_external_url,open_web_workspace,add_attachment,open_attachment,remove_attachment,open_data_folder,test_notification,quit_app,native_browser::sync_browser_views,native_browser::browser_action,native_browser::browser_history,agent_backends,agent_list,agent_create,agent_send,agent_stop,agent_respond,load_shell_state,save_shell_state];
            move |invoke| {
                if invoke.message.webview_ref().label() != "main" {invoke.resolver.reject("网页不能访问北极星宿主命令"); return true;}
                handler(invoke)
            }
        })
        .build(tauri::generate_context!()).expect("北极星启动失败")
        .run(|app, event| {if let tauri::RunEvent::Exit = event {app.state::<Arc<native_agents::AgentHost>>().shutdown();}});
}
