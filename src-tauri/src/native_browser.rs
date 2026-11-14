use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, sync::Mutex};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Webview, WebviewUrl, webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder}};
use url::Url;

type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub struct Browsers(Mutex<HashMap<String, String>>);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {id: String, url: String}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSlot {id: String, x: f64, y: f64, width: f64, height: f64}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {tabs: Vec<BrowserTab>, slots: Vec<BrowserSlot>, viewport_width: f64, viewport_height: f64}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResult {id: String, error: Option<String>}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {id: String, url: String, back: bool, forward: bool}

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn label(id: &str) -> String {format!("browser-{id}")}
fn browser_url(value: &str, host_origin: Option<&str>) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "网页地址无效")?;
    if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {return Err("只支持不含登录凭据的 HTTP／HTTPS 地址".into());}
    if url.host_str().is_some_and(|host| ["tauri.localhost", "ipc.localhost", "asset.localhost"].contains(&host)) || host_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin) {return Err("请通过北极星本身访问工作区界面".into());}
    Ok(url)
}
fn validate_snapshot(snapshot: &BrowserSnapshot, origin: Option<&str>) -> Result<()> {
    if snapshot.tabs.len() > 64 || snapshot.slots.len() > 8 || ![snapshot.viewport_width, snapshot.viewport_height].iter().all(|v| v.is_finite() && *v >= 1. && *v <= 100000.) {return Err("浏览器分区参数无效".into());}
    let mut ids = HashSet::new();
    for tab in &snapshot.tabs {if !valid_id(&tab.id) || !ids.insert(tab.id.as_str()) {return Err("浏览器页签标识无效".into());}}
    let _ = origin;
    let mut placed = HashSet::new();
    for slot in &snapshot.slots {
        if !ids.contains(slot.id.as_str()) || !placed.insert(slot.id.as_str()) || ![slot.x, slot.y, slot.width, slot.height].iter().all(|v| v.is_finite()) || slot.x < 0. || slot.y < 0. || slot.width < 1. || slot.height < 1. || slot.x + slot.width > snapshot.viewport_width + 1. || slot.y + slot.height > snapshot.viewport_height + 1. {return Err("浏览器分区位置无效".into());}
    }
    Ok(())
}
fn host_origin(app: &tauri::AppHandle) -> Option<String> {app.config().build.dev_url.as_ref().map(|url| url.origin().ascii_serialization())}
fn host_only(caller: &Webview) -> Result<()> {if caller.label() == "main" {Ok(())} else {Err("网页不能控制北极星宿主".into())}}

#[tauri::command]
pub async fn sync_browser_views(app: tauri::AppHandle, caller: Webview, state: tauri::State<'_, Browsers>, snapshot: BrowserSnapshot) -> Result<Vec<BrowserResult>> {
    host_only(&caller)?;
    let origin = host_origin(&app);
    validate_snapshot(&snapshot, origin.as_deref())?;
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    let desired: HashSet<_> = snapshot.tabs.iter().map(|tab| tab.id.as_str()).collect();
    // The host owns guest lifetime; reparenting a tab does not recreate its WebView.
    for id in current.keys().filter(|id| !desired.contains(id.as_str())).cloned().collect::<Vec<_>>() {
        if let Some(view) = app.get_webview(&label(&id)) {view.close().map_err(|e| e.to_string())?;}
        current.remove(&id);
    }
    let window = caller.window();
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale_x = size.width as f64 / snapshot.viewport_width;
    let scale_y = size.height as f64 / snapshot.viewport_height;
    let mut results = Vec::new();
    for tab in snapshot.tabs {
        let slot = snapshot.slots.iter().find(|slot| slot.id == tab.id);
        let result: Result<()> = (|| {
            let url = browser_url(&tab.url, origin.as_deref())?;
            let view = if let Some(view) = app.get_webview(&label(&tab.id)) {view} else {
                let Some(slot) = slot else {return Ok(());};
                let nav_origin = origin.clone(); let event_id = tab.id.clone(); let popup_id = tab.id.clone(); let title_id = tab.id.clone(); let popup_app = app.clone();
                let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("browser-profile");
                let builder = WebviewBuilder::new(label(&tab.id), WebviewUrl::External(url.clone()))
                    .data_directory(profile).focused(false)
                    .on_navigation(move |url| browser_url(url.as_str(), nav_origin.as_deref()).is_ok())
                    .on_page_load(move |view, payload| {
                        let finished = payload.event() == PageLoadEvent::Finished;
                        let _ = view.app_handle().emit_to("main", "browser-page", serde_json::json!({"id":event_id,"loading":!finished,"url":if finished {Some(payload.url().as_str())} else {None}}));
                    })
                    .on_document_title_changed(move |view, title| {let _ = view.app_handle().emit_to("main", "browser-page", serde_json::json!({"id":title_id,"title":title.chars().take(200).collect::<String>()}));})
                    .on_new_window(move |url, _| {
                        if browser_url(url.as_str(), host_origin(&popup_app).as_deref()).is_ok() {let _ = popup_app.emit_to("main", "browser-new-tab", serde_json::json!({"id":popup_id,"url":url.as_str()}));}
                        NewWindowResponse::Deny
                    });
                let view = window.add_child(builder, PhysicalPosition::new(slot.x * scale_x, slot.y * scale_y), PhysicalSize::new(slot.width * scale_x, slot.height * scale_y)).map_err(|e| e.to_string())?;
                current.insert(tab.id.clone(), tab.url.clone());
                view
            };
            if current.get(&tab.id) != Some(&tab.url) {
                if view.url().map_err(|e| e.to_string())? != url {view.navigate(url).map_err(|e| e.to_string())?;}
                current.insert(tab.id.clone(), tab.url.clone());
            }
            if let Some(slot) = slot {
                view.set_bounds(tauri::Rect {position: PhysicalPosition::new(slot.x * scale_x, slot.y * scale_y).into(), size: PhysicalSize::new(slot.width * scale_x, slot.height * scale_y).into()}).map_err(|e| e.to_string())?;
                view.show().map_err(|e| e.to_string())?;
            } else {view.hide().map_err(|e| e.to_string())?;}
            Ok(())
        })();
        if result.is_err() {if let Some(view) = app.get_webview(&label(&tab.id)) {let _ = view.hide();}}
        results.push(BrowserResult {id: tab.id, error: result.err()});
    }
    Ok(results)
}

fn get_guest(app: &tauri::AppHandle, caller: &Webview, id: &str) -> Result<Webview> {
    host_only(caller)?;
    if !valid_id(id) {return Err("浏览器页签标识无效".into());}
    app.get_webview(&label(id)).ok_or_else(|| "网页尚未打开".into())
}
#[tauri::command]
pub async fn browser_action(app: tauri::AppHandle, caller: Webview, id: String, action: String) -> Result<()> {
    let view = get_guest(&app, &caller, &id)?;
    match action.as_str() {
        "reload" => view.reload().map_err(|e| e.to_string()),
        // Fixed scripts call the page's real history; no user-provided script is evaluated.
        "back" => view.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => view.eval("history.forward()").map_err(|e| e.to_string()),
        _ => Err("浏览器操作无效".into())
    }
}
#[tauri::command]
pub async fn browser_history(app: tauri::AppHandle, caller: Webview, ids: Vec<String>) -> Result<Vec<HistoryStatus>> {
    host_only(&caller)?;
    if ids.len() > 8 {return Err("分区数量无效".into());}
    let mut statuses = Vec::new();
    for id in ids {
        let Ok(view) = get_guest(&app, &caller, &id) else {continue;};
        #[cfg(windows)] {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            view.with_webview(move |platform| {
                let result = (|| unsafe {
                    let core = platform.controller().CoreWebView2().map_err(|e| e.to_string())?;
                    let mut back = Default::default(); let mut forward = Default::default();
                    core.CanGoBack(&mut back).map_err(|e| e.to_string())?; core.CanGoForward(&mut forward).map_err(|e| e.to_string())?;
                    Ok::<_, String>((back.as_bool(), forward.as_bool()))
                })();
                let _ = tx.send(result.map_err(|e| e.to_string()));
            }).map_err(|e| e.to_string())?;
            let (back, forward) = rx.recv_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())??;
            statuses.push(HistoryStatus {id, url: view.url().map_err(|e| e.to_string())?.to_string(), back, forward});
        }
        #[cfg(not(windows))] {statuses.push(HistoryStatus {id, url: view.url().map_err(|e| e.to_string())?.to_string(), ..Default::default()});}
    }
    Ok(statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guest_urls_cannot_reach_host_or_execute_protocols() {
        for value in ["javascript:alert(1)", "file:///C:/secret", "data:text/html,hello", "https://user:pass@example.com", "http://tauri.localhost/next.html", "http://127.0.0.1:1420/next.html"] {assert!(browser_url(value, Some("http://127.0.0.1:1420")).is_err(), "{value}");}
        assert!(browser_url("http://127.0.0.1:8765/", Some("http://127.0.0.1:1420")).is_ok());
    }
    #[test]
    fn validates_unique_guest_ownership_and_finite_clipped_bounds() {
        let mut snapshot = BrowserSnapshot {tabs: vec![BrowserTab {id: "test-1".into(), url: "https://example.com/".into()}], slots: vec![BrowserSlot {id: "test-1".into(), x: 220., y: 100., width: 500., height: 500.}], viewport_width: 1440., viewport_height: 900.};
        assert!(validate_snapshot(&snapshot, None).is_ok());
        snapshot.slots[0].x = f64::NAN; assert!(validate_snapshot(&snapshot, None).is_err());
        snapshot.slots[0].x = 1000.; assert!(validate_snapshot(&snapshot, None).is_err());
        snapshot.slots.clear(); snapshot.tabs.push(snapshot.tabs[0].clone()); assert!(validate_snapshot(&snapshot, None).is_err());
        assert!(!valid_id("../main")); assert_ne!(label("main"), "main");
    }
}
