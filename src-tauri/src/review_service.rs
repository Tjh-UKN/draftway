use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, io::Read, net::IpAddr, time::Duration};
use url::Url;

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {pub file: String, pub state: String, pub prs: Vec<u64>, pub pending: u64}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub workspace_id: String, pub url: String, pub connected: bool, pub repository: String, pub running_count: usize,
    pub paused: bool, pub reports: Vec<Report>, pub error: Option<String>, pub history_gap: bool,
}
pub fn local_url(value: &str) -> Result<String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "请输入本机检视服务的 HTTP 地址")?;
    let local = match url.host() {Some(url::Host::Domain("localhost")) => true, Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(), Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(), _ => false};
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !local || url.path() != "/" {return Err("此适配器仅连接本机 HTTP 检视服务，例如 http://127.0.0.1:8765/".into());}
    url.set_path("/"); Ok(url.to_string())
}
pub fn report_file(value: &str) -> bool {value.starts_with("round-") && value.ends_with(".json") && value.len() <= 240 && !value.contains("..") && value.bytes().all(|b| b.is_ascii_alphanumeric() || [b'-', b'_', b'.'].contains(&b))}
pub fn client() -> Result<reqwest::blocking::Client> {reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(4)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())}
pub fn get(client: &reqwest::blocking::Client, base: &str, path: &str) -> Result<Value> {
    let base = local_url(base)?;
    let response = client.get(format!("{}{}", base, path.trim_start_matches('/'))).send().and_then(|r| r.error_for_status()).map_err(|e| format!("检视服务连接失败：{e}"))?;
    let mut bytes = Vec::new(); response.take(2_000_001).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 {return Err("检视响应超过 2 MB，请在原看板查看".into());}
    serde_json::from_slice(&bytes).map_err(|_| "检视接口未返回有效 JSON".into())
}
pub fn parse(workspace_id: &str, base: &str, status: &Value, reports: &Value) -> Result<Snapshot> {
    let repository = status["repository"].as_str().ok_or("检视状态格式不兼容")?.to_string();
    let runtime = status["runtime"].as_object().ok_or("检视运行状态格式不兼容")?;
    let rows = reports["reports"].as_array().ok_or("检视报告列表格式不兼容")?;
    let mut parsed = Vec::new();
    for report in rows.iter().take(50) {
        let file = report["file"].as_str().filter(|file| report_file(file)).ok_or("检视报告标识无效")?;
        let source = report["round_status"].as_str().unwrap_or("unknown");
        let state = if file.ends_with("-stage.json") || source == "in_progress" {"running"} else if source == "failed" {"failed"} else if ["completed", "noop"].contains(&source) {if report["counts"]["failed"].as_u64().unwrap_or(0) > 0 {"failed"} else {"succeeded"}} else {"unknown"};
        parsed.push(Report {file: file.into(), state: state.into(), prs: report["prs"].as_array().map(|items| items.iter().filter_map(Value::as_u64).collect()).unwrap_or_default(), pending: report["pending_count"].as_u64().unwrap_or(0)});
    }
    let running_count = runtime.get("active_prs").and_then(Value::as_object).ok_or("运行任务数量字段不兼容")?.len();
    Ok(Snapshot {workspace_id: workspace_id.into(), url: local_url(base)?, connected: true, repository, running_count, paused: runtime.get("paused") == Some(&Value::Bool(true)), reports: parsed, error: runtime.get("last_error").and_then(Value::as_str).map(String::from), history_gap: false})
}
pub fn terminal_changes(previous: &mut HashMap<String, String>, reports: &[Report], baseline: bool) -> Vec<Report> {
    let mut changed = Vec::new();
    for report in reports {
        if !baseline && ["succeeded", "failed"].contains(&report.state.as_str()) && previous.get(&report.file) != Some(&report.state) {changed.push(report.clone());}
        previous.insert(report.file.clone(), report.state.clone());
    }
    changed
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    #[ignore = "requires the user's running local review service; GET requests only"]
    fn live_local_service_status_and_report_are_compatible() {
        let base=std::env::var("NORTHSTAR_REVIEW_URL").unwrap_or("http://127.0.0.1:8765/".into());let client=client().unwrap();
        let status=get(&client,&base,"api/status").unwrap();let reports=get(&client,&base,"api/reports").unwrap();let snapshot=parse("live-probe",&base,&status,&reports).unwrap();assert!(snapshot.connected);
        if let Some(report)=snapshot.reports.first() {let result=get(&client,&base,&format!("api/reports/{}",report.file)).unwrap();assert!(result["pulls"].is_array());}
        let mut baseline=HashMap::new();assert!(terminal_changes(&mut baseline,&snapshot.reports,true).is_empty());
    }
    #[test]
    fn stopped_scheduler_is_not_a_completed_review_and_stage_reports_stay_running() {
        let status = json!({"repository":"example/repo","runtime":{"running":false,"active_prs":{},"paused":true}});
        let reports = json!({"reports":[{"file":"round-one-stage.json","round_status":"completed","prs":[1]},{"file":"round-two.json","round_status":"in_progress","pending_count":2}]});
        let result = parse("w", "http://localhost:8765/", &status, &reports).unwrap(); assert!(result.paused); assert!(result.reports.iter().all(|r| r.state == "running"));
    }
    #[test]
    fn historical_baseline_and_repeated_reports_do_not_generate_notifications() {
        let mut seen = HashMap::new(); let mut report = Report {file:"round-one.json".into(),state:"running".into(),prs:vec![1],pending:1};
        assert!(terminal_changes(&mut seen, &[report.clone()],true).is_empty()); report.state="succeeded".into(); assert_eq!(terminal_changes(&mut seen,&[report.clone()],false).len(),1); report.pending=0; assert!(terminal_changes(&mut seen,&[report],false).is_empty());
    }
    #[test]
    fn only_explicit_terminal_outcomes_are_success_and_paths_stay_local() {
        let status = json!({"repository":"r","runtime":{"active_prs":{"1":"queued","2":"reviewing"}}});
        let reports = json!({"reports":[{"file":"round-a.json","round_status":"completed"},{"file":"round-b.json","round_status":"failed"},{"file":"round-c.json"}]});
        let snapshot = parse("w","http://127.0.0.1:8765/",&status,&reports).unwrap(); assert_eq!(snapshot.running_count,2); assert_eq!(snapshot.reports.iter().map(|r|r.state.as_str()).collect::<Vec<_>>(),vec!["succeeded","failed","unknown"]);
        for url in ["https://example.com/","http://169.254.169.254/","http://user:pass@localhost/","http://localhost/?token=private"] {assert!(local_url(url).is_err());}
        for file in ["../secret","round-../../x.json","round-a.json/extra"] {assert!(!report_file(file));}
    }
}
