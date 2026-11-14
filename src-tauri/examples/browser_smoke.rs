// Standalone runtime probe: calls native APIs, without automating the user's app UI.
#[path = "../src/native_browser.rs"]
mod native_browser;
use native_browser::{Browsers, BrowserSnapshot};
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{Listener, Manager};
use serde_json::{json, Value};

fn snapshot(url: &str, visible: bool) -> BrowserSnapshot {
    serde_json::from_value(json!({"tabs":[{"id":"smoke","url":url}],"slots":if visible {json!([{"id":"smoke","x":10.,"y":65.,"width":780.,"height":480.}])}else{json!([])},"viewportWidth":900.,"viewportHeight":650.})).unwrap()
}
async fn wait_page(events: &Arc<Mutex<Vec<Value>>>, expected: &str) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if events.lock().unwrap().iter().any(|e| e["url"] == expected && e["loading"] == false) {return Ok(());}
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("Page load timed out: {expected}; events={:?}", events.lock().unwrap()))
}
fn main() {
    tauri::Builder::default().manage(Browsers::default()).setup(|app| {
        let app = app.handle().clone();
        let events = Arc::new(Mutex::new(Vec::new())); let recorded = events.clone();
        app.listen_any("browser-page", move |event| {if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {recorded.lock().unwrap().push(payload);}});
        tauri::async_runtime::spawn(async move {
            let result: Result<Value, String> = async {
                let caller = app.get_webview("main").ok_or("Host missing")?;
                let fixture_url = std::env::var("NORTHSTAR_BROWSER_FIXTURE").map_err(|e| e.to_string())?;
                let fixture = fixture_url.as_str();
                let results = native_browser::sync_browser_views(app.clone(), caller.clone(), app.state::<Browsers>(), snapshot(fixture, true)).await?;
                if serde_json::to_value(results).unwrap()[0]["error"] != Value::Null {return Err("Guest creation failed".into());}
                wait_page(&events, fixture).await?;
                let guest = app.get_webview("browser-smoke").ok_or("Guest missing")?;
                // Exercise the exact command guard using the guest identity.
                if native_browser::browser_action(app.clone(), guest.clone(), "smoke".into(), "reload".into()).await.is_ok() {return Err("Guest invoked a host command".into());}
                let second_url = format!("{fixture}second.html");
                let second = second_url.as_str();
                guest.navigate(second.parse().unwrap()).map_err(|e| e.to_string())?;
                wait_page(&events, second).await?;
                let statuses = serde_json::to_value(native_browser::browser_history(app.clone(), caller.clone(), vec!["smoke".into()]).await?).unwrap();
                if statuses[0]["back"] != true || statuses[0]["url"] != second {return Err(format!("History not tracked: {statuses}"));}
                native_browser::sync_browser_views(app.clone(), caller.clone(), app.state::<Browsers>(), snapshot(second, false)).await?;
                native_browser::sync_browser_views(app.clone(), caller.clone(), app.state::<Browsers>(), snapshot(second, true)).await?;
                let preserved = serde_json::to_value(native_browser::browser_history(app.clone(), caller.clone(), vec!["smoke".into()]).await?).unwrap();
                if preserved[0]["back"] != true {return Err("Hide/show recreated the guest and lost history".into());}
                let resized = serde_json::from_value(json!({"tabs":[{"id":"smoke","url":second}],"slots":[{"id":"smoke","x":100.,"y":120.,"width":640.,"height":420.}],"viewportWidth":900.,"viewportHeight":650.})).unwrap();
                native_browser::sync_browser_views(app.clone(), caller.clone(), app.state::<Browsers>(), resized).await?;
                let host_size = caller.window().inner_size().map_err(|e| e.to_string())?;
                let actual_size = guest.size().map_err(|e| e.to_string())?;
                if (actual_size.width as f64 - 640. * host_size.width as f64 / 900.).abs() > 1. || (actual_size.height as f64 - 420. * host_size.height as f64 / 650.).abs() > 1. {return Err(format!("Native bounds mismatch: {actual_size:?}"));}
                events.lock().unwrap().clear();
                native_browser::browser_action(app.clone(), caller.clone(), "smoke".into(), "back".into()).await?;
                wait_page(&events, fixture).await?;
                // This is the user's running dashboard, still serving DENY/frame-ancestors none.
                let dashboard_url = std::env::var("NORTHSTAR_BROWSER_DASHBOARD").unwrap_or_else(|_| fixture_url.clone());
                let dashboard = dashboard_url.as_str();
                native_browser::sync_browser_views(app.clone(), caller.clone(), app.state::<Browsers>(), snapshot(dashboard, true)).await?;
                wait_page(&events, dashboard).await?;
                let history = native_browser::browser_history(app.clone(), caller.clone(), vec!["smoke".into()]).await?;
                let empty = serde_json::from_value(json!({"tabs":[],"slots":[],"viewportWidth":900.,"viewportHeight":650.})).unwrap();
                native_browser::sync_browser_views(app.clone(), caller, app.state::<Browsers>(), empty).await?;
                if app.get_webview("browser-smoke").is_some() {return Err("Closing a tab leaked its WebView".into());}
                Ok(json!({"passed":["native top-level load with X-Frame-Options DENY", "guest cannot call host commands", "hide/show retains navigation history", "native pane resize matches host viewport", "real navigation history and back", "configured dashboard/page loaded", "close releases guest"],"dashboard":dashboard,"history":history,"pageEvents":events.lock().unwrap().clone()}))
            }.await;
            let report = std::env::var("NORTHSTAR_BROWSER_REPORT").expect("Report path required");
            let exit_code = if result.is_ok() {0} else {1};
            let value = match result {Ok(value) => value, Err(error) => json!({"error":error})};
            std::fs::write(report, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            app.exit(exit_code);
        });
        Ok(())
    }).run(tauri::generate_context!()).expect("Browser runtime probe failed");
}
