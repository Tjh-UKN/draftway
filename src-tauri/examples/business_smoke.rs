// API probe for trusted same-origin component frames, without GUI automation.
use serde_json::{json,Value};
use std::{sync::Mutex,time::{Duration,Instant}};
use tauri::{Emitter,Manager};
#[derive(Default)]struct Probe(Mutex<Option<Value>>);
#[tauri::command]
fn business_probe(app:tauri::AppHandle,webview:tauri::Webview,stage:String,result:Option<Value>,state:tauri::State<Probe>)->Result<String,String>{
    if webview.label()!="main" {return Err("Guest command denied".into());}
    if stage=="bridge" {app.emit_to("main","business-bridge-event","native-event").map_err(|e|e.to_string())?;return Ok("NATIVE_MAIN_BRIDGE".into());}
    *state.0.lock().unwrap()=result;Ok("recorded".into())
}
fn main(){tauri::Builder::default().manage(Probe::default()).invoke_handler(tauri::generate_handler![business_probe]).setup(|app|{let app=app.handle().clone();std::thread::spawn(move||{let started=Instant::now();loop{let result=app.state::<Probe>().0.lock().unwrap().clone();if result.is_some()||started.elapsed()>Duration::from_secs(20){let result=result.unwrap_or(json!({"error":"Component bridge timed out"}));let code=if result["passed"].as_array().is_some_and(|p|p.len()==3){0}else{1};std::fs::write(std::env::var("NORTHSTAR_BUSINESS_REPORT").unwrap(),serde_json::to_vec_pretty(&result).unwrap()).unwrap();app.exit(code);break;}std::thread::sleep(Duration::from_millis(50));}});Ok(())}).run(tauri::generate_context!()).expect("Business bridge probe failed");}
