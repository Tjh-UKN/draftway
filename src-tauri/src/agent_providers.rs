use super::{AgentSession, Message, Request, Result, now};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

#[derive(Clone)]
pub struct Provider {pub backend: String, pub program: PathBuf, pub wsl: bool, prefix: Vec<String>}
pub fn discover(backend: &str) -> Option<Provider> {
    if backend == "codex" {return super::codex_executable().map(|program| Provider {backend: backend.into(), program, wsl: false, prefix: vec![]});}
    if !["claude", "pi"].contains(&backend) {return None;}
    let file = if backend == "claude" {"claude.exe"} else {"pi.exe"};
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {let program = directory.join(file); if program.is_file() {return Some(Provider {backend: backend.into(), program, wsl: false, prefix: vec![]});}}
    #[cfg(windows)] {
        if backend == "claude" {if let Some(home) = std::env::var_os("USERPROFILE") {let file = Path::new(&home).join(".local/bin/claude.exe"); if file.is_file() {return Some(Provider {backend: backend.into(), program: file, wsl: false, prefix: vec![]});}}}
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let script = Path::new(&appdata).join(if backend == "claude" {"npm/node_modules/@anthropic-ai/claude-code/cli.js"} else {"npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"});
            if script.is_file() {for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {let node = directory.join("node.exe"); if node.is_file() {return Some(Provider {backend: backend.into(), program: node, wsl: false, prefix: vec![script.to_string_lossy().into_owned()]});}}}
        }
        let mut command = Command::new("wsl.exe");
        command.args(["--exec", "/bin/bash", "-ic", if backend == "claude" {"command -v claude"} else {"command -v pi"}]);
        let output = timed_output(command, 8)?;
        let path = String::from_utf8_lossy(&output).lines().find(|line| line.starts_with('/'))?.trim().to_string();
        return Some(Provider {backend: backend.into(), program: PathBuf::from(path), wsl: true, prefix: vec![]});
    }
    #[cfg(not(windows))] None
}
fn timed_output(mut command: Command, seconds: u64) -> Option<Vec<u8>> {
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
    let mut child = command.spawn().ok()?; let start = Instant::now();
    loop {
        if child.try_wait().ok()?.is_some() {let output = child.wait_with_output().ok()?; return output.status.success().then_some(output.stdout);}
        if start.elapsed() > Duration::from_secs(seconds) {let _ = child.kill(); let _ = child.wait(); return None;}
        std::thread::sleep(Duration::from_millis(40));
    }
}
fn wsl_path(path: &str) -> Result<String> {
    if path.starts_with('/') {return Ok(path.into());}
    let mut command = Command::new("wsl.exe"); command.args(["--exec", "wslpath", "-a", "-u", path]);
    timed_output(command, 8).and_then(|bytes| String::from_utf8(bytes).ok()).map(|s| s.trim().to_string()).filter(|s| s.starts_with('/')).ok_or_else(|| "无法把工作目录转换为 WSL 路径".into())
}
impl Provider {
    pub fn command(&self, cwd: &str, source: Option<&str>, session_root: &Path) -> Result<(Command, Option<String>, Option<String>)> {
        let mut args: Vec<String> = Vec::new(); let mut planned = None;
        match self.backend.as_str() {
            "codex" => args.extend(["app-server", "--listen", "stdio://"].map(String::from)),
            "claude" => {
                args.extend(["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "manual", "--permission-prompts", "host"].map(String::from));
                let id = source.map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                args.extend([if source.is_some() {"--resume"} else {"--session-id"}.to_string(), id.clone()]); planned = Some(id);
            },
            "pi" => {
                std::fs::create_dir_all(session_root).map_err(|e| e.to_string())?;
                let file = source.map(String::from).unwrap_or_else(|| session_root.join(format!("{}.jsonl", uuid::Uuid::new_v4())).to_string_lossy().into_owned());
                let file = if self.wsl {wsl_path(&file)?} else {file};
                args.extend(["--mode".into(), "rpc".into(), "--session".into(), file.clone()]); planned = Some(file);
            },
            _ => return Err("不支持的执行器".into()),
        }
        let token = self.wsl.then(|| uuid::Uuid::new_v4().to_string());
        let mut command = if self.wsl {
            let mut command = Command::new("wsl.exe");
            command.args(["--cd", &wsl_path(cwd)?, "--exec", "/usr/bin/setsid", "--wait", "/bin/bash", "-ic", r#"printf '__NORTHSTAR_PROCESS__:%s:%s:%s\n' "$WSL_DISTRO_NAME" "$(id -un)" "$$" >&2; export NORTHSTAR_SESSION_TOKEN="$1"; shift; exec "$@""#, "northstar", token.as_deref().unwrap()]).arg(&self.program).args(args); command
        } else {let mut command = Command::new(&self.program); command.current_dir(cwd).args(&self.prefix).args(args); command};
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
        Ok((command, planned, token))
    }
}
pub fn wire_request(backend: &str, id: u64, method: &str, params: Value) -> Value {
    match backend {
        "pi" => {let mut value = params; value["id"] = json!(id.to_string()); value["type"] = json!(method); value},
        "claude" => {let mut request = params; request["subtype"] = json!(method); json!({"type":"control_request","request_id":id.to_string(),"request":request})},
        _ => json!({"id":id,"method":method,"params":params}),
    }
}
pub fn reply(backend: &str, value: &Value) -> Option<(u64, Value)> {
    if backend == "pi" && value["type"] == "response" {
        let id = value["id"].as_str()?.parse().ok()?;
        return Some((id, if value["success"] == true {json!({"result":value["data"]})} else {json!({"error":{"message":value["error"].as_str().unwrap_or("Pi 命令失败")}})}));
    }
    if backend == "claude" && value["type"] == "control_response" {
        let response = &value["response"]; let id = response["request_id"].as_str()?.parse().ok()?;
        return Some((id, if response["subtype"] == "success" {json!({"result":response["response"]})} else {json!({"error":{"message":response["error"].as_str().unwrap_or("Claude 命令失败")}})}));
    }
    if backend == "codex" && value.get("method").is_none() {return Some((value["id"].as_u64()?, value.clone()));}
    None
}
fn text(content: &Value) -> String {content.as_array().map(|items| items.iter().filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n\n")).unwrap_or_default()}
fn assistant(session: &mut AgentSession, value: &str, replace: bool) {
    let Some(run) = session.runs.last().filter(|run| ["running", "needs_input"].contains(&run.state.as_str())) else {return;};
    if value.is_empty() {return;} let key = format!("{}-assistant", run.id);
    if !session.messages.iter().any(|message| message.id == key) {session.messages.push(Message {id: key.clone(), role: "assistant".into(), text: String::new(), at: now()});}
    let message = session.messages.iter_mut().find(|message| message.id == key).unwrap();
    if replace {message.text = value.into();} else {message.text.push_str(value);}
}
fn finish(session: &mut AgentSession, state: &str, error: Option<String>) {
    let cancelled = session.runs.last().is_some_and(|run| run.cancel_requested);
    let state = if cancelled {"cancelled"} else {state}; let error = if cancelled {None} else {error};
    if let Some(run) = session.runs.last_mut() {if run.state == "cancelled" {return;} run.state = state.into(); run.finished_at = Some(now()); run.error = error.clone();}
    session.error = error; session.requests.clear();
}
pub fn relevant(backend: &str, value: &Value) -> bool {
    match backend {
        "claude" => ["system", "assistant", "result", "stream_event", "control_request"].contains(&value["type"].as_str().unwrap_or("")),
        "pi" => ["agent_start", "agent_end", "agent_settled", "message_update", "message_end", "extension_ui_request"].contains(&value["type"].as_str().unwrap_or("")),
        _ => false,
    }
}
pub fn apply_event(session: &mut AgentSession, value: &Value) {
    if session.backend == "claude" {
        match value["type"].as_str().unwrap_or("") {
            "system" if value["subtype"] == "init" => {if let Some(id) = value["session_id"].as_str() {session.source_id = Some(id.into());}},
            "stream_event" if value["parent_tool_use_id"].is_null() && value["event"]["delta"]["type"] == "text_delta" => assistant(session, value["event"]["delta"]["text"].as_str().unwrap_or(""), false),
            "assistant" if value["parent_tool_use_id"].is_null() => assistant(session, &text(&value["message"]["content"]), true),
            "result" => {
                if let Some(result) = value["result"].as_str() {assistant(session, result, true);}
                let succeeded = value["subtype"] == "success" && value["is_error"] != true;
                let error = if succeeded {None} else {Some(value["errors"].as_array().map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).filter(|s| !s.is_empty()).or_else(|| value["result"].as_str().map(String::from)).unwrap_or_else(|| "Claude 执行失败".into()))};
                finish(session, if succeeded {"succeeded"} else {"failed"}, error);
            },
            "control_request" => {
                let request = &value["request"]; let input = &request["input"];
                let question = request["tool_name"] == "AskUserQuestion";
                let questions: Vec<_> = input["questions"].as_array().map(|questions| questions.iter().enumerate().map(|(i, question)| json!({"id":i.to_string(),"question":question["question"],"options":question["options"]})).collect()).unwrap_or_default();
                let payload = json!({"raw":request,"command":input["command"],"cwd":session.cwd,"questions":questions});
                session.requests.push(Request {id: value["request_id"].as_str().unwrap_or("").into(), kind: if question {"input"} else if request["subtype"] == "can_use_tool" {"approval"} else {"unsupported"}.into(), title: request["tool_name"].as_str().unwrap_or("Claude 请求").into(), payload, source_id: value["request_id"].clone()});
                if let Some(run) = session.runs.last_mut() {run.state = "needs_input".into();}
            },
            _ => {}
        }
    } else if session.backend == "pi" {
        match value["type"].as_str().unwrap_or("") {
            "agent_start" => {if let Some(run) = session.runs.last_mut() {if run.state != "cancelled" {run.error = None;}}},
            "message_update" if value["assistantMessageEvent"]["type"] == "text_delta" => assistant(session, value["assistantMessageEvent"]["delta"].as_str().unwrap_or(""), false),
            "message_end" if value["message"]["role"] == "assistant" => {
                let message = &value["message"]; assistant(session, &text(&message["content"]), true);
                if ["error", "aborted"].contains(&message["stopReason"].as_str().unwrap_or("")) {if let Some(run) = session.runs.last_mut() {run.error = Some(message["errorMessage"].as_str().unwrap_or("Pi 执行中断或失败").into());}}
            },
            "agent_settled" => {
                let error = session.runs.last().and_then(|run| run.error.clone());
                finish(session, if value["aborted"] == true {"cancelled"} else if error.is_some() {"failed"} else {"succeeded"}, error);
            },
            "extension_ui_request" => {
                let method = value["method"].as_str().unwrap_or("");
                if !["select", "confirm", "input", "editor"].contains(&method) {return;}
                let options: Vec<_> = value["options"].as_array().map(|items| items.iter().filter_map(Value::as_str).map(|label| json!({"label":label})).collect()).unwrap_or_default();
                session.requests.push(Request {id: value["id"].as_str().unwrap_or("").into(), kind: if method == "confirm" {"approval"} else {"input"}.into(), title: value["title"].as_str().unwrap_or("Pi 请求").into(), payload: json!({"raw":value,"questions":[{"id":"value","question":value["title"],"options":options}]}), source_id: value["id"].clone()});
                if let Some(run) = session.runs.last_mut() {run.state = "needs_input".into();}
            },
            _ => {}
        }
    }
}
pub fn response(backend: &str, request: &Request, answer: Value) -> Result<Value> {
    if backend == "pi" {
        return Ok(if request.kind == "approval" {json!({"type":"extension_ui_response","id":request.source_id,"confirmed":answer["decision"] == "accept"})} else {json!({"type":"extension_ui_response","id":request.source_id,"value":answer["answers"]["value"]["answers"][0].as_str().ok_or("请输入回答")?})});
    }
    if backend == "claude" {
        let raw = &request.payload["raw"]; let mut input = raw["input"].clone();
        let allow = request.kind == "input" || answer["decision"] == "accept";
        if request.kind == "input" {
            let mut answers = serde_json::Map::new();
            for (i, question) in raw["input"]["questions"].as_array().ok_or("问题格式无效")?.iter().enumerate() {answers.insert(question["question"].as_str().ok_or("问题格式无效")?.into(), answer["answers"][i.to_string()]["answers"][0].clone());}
            input["answers"] = json!(answers);
        }
        return Ok(json!({"type":"control_response","response":{"subtype":"success","request_id":request.source_id,"response":if allow {json!({"behavior":"allow","updatedInput":input})} else {json!({"behavior":"deny","message":"用户拒绝本次操作"})}}}));
    }
    Err("不支持的响应类型".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(backend: &str) -> AgentSession {serde_json::from_value(json!({"id":"s","workspaceId":"w","nodeId":null,"backend":backend,"title":"test","cwd":"C:/project","sourceId":null,"createdAt":0,"revision":1,"messages":[],"requests":[],"error":null,"runs":[{"id":"r","state":"running","startedAt":0,"finishedAt":null,"sourceTurnId":null,"error":null}]})).unwrap()}
    #[test]
    fn rpc_frames_preserve_text_and_correlate_each_provider() {
        let value = wire_request("pi", 7, "prompt", json!({"message":"text\u{2028}with\nnewlines"})); assert_eq!(value["message"], "text\u{2028}with\nnewlines"); assert_eq!(value["id"], "7");
        assert_eq!(reply("pi", &json!({"type":"response","id":"7","success":true,"data":{"disposition":"started"}})).unwrap().0, 7);
        let request = wire_request("claude", 3, "initialize", json!({"hooks":{}})); assert_eq!(request["request"]["subtype"], "initialize");
        assert!(reply("claude", &json!({"type":"control_response","response":{"subtype":"success","request_id":"3","response":{}}})).is_some());
    }
    #[test]
    fn pi_acknowledgement_and_agent_end_are_not_completion() {
        let mut s = session("pi"); apply_event(&mut s, &json!({"type":"agent_end","willRetry":true,"messages":[]})); assert_eq!(s.runs[0].state, "running");
        apply_event(&mut s, &json!({"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"provider unavailable"}}));
        apply_event(&mut s, &json!({"type":"agent_settled","aborted":false})); assert_eq!(s.runs[0].state, "failed");
    }
    #[test]
    fn pi_retry_can_recover_and_abort_never_becomes_success() {
        let mut s = session("pi"); s.runs[0].error = Some("temporary".into()); apply_event(&mut s, &json!({"type":"agent_start"}));
        apply_event(&mut s, &json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}));
        apply_event(&mut s, &json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"stopReason":"stop"}}));
        assert_eq!(s.messages.len(), 1); apply_event(&mut s, &json!({"type":"agent_settled","aborted":true})); assert_eq!(s.runs[0].state, "cancelled");
    }
    #[test]
    fn explicit_stop_is_cancelled_even_when_pi_reports_abort_as_a_provider_error() {
        let mut s = session("pi"); s.runs[0].cancel_requested = true;
        apply_event(&mut s, &json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Request aborted","content":[]}}));
        apply_event(&mut s, &json!({"type":"agent_settled","aborted":false}));
        assert_eq!(s.runs[0].state,"cancelled"); assert!(s.runs[0].error.is_none());
    }
    #[test]
    fn claude_final_response_replaces_stream_and_checks_result_status() {
        let mut s = session("claude"); apply_event(&mut s, &json!({"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hel"}}}));
        apply_event(&mut s, &json!({"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}));
        apply_event(&mut s, &json!({"type":"result","subtype":"success","result":"Hello","is_error":false})); assert_eq!(s.messages[0].text,"Hello"); assert_eq!(s.messages.len(),1); assert_eq!(s.runs[0].state,"succeeded");
        let mut failed = session("claude"); apply_event(&mut failed, &json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Failed"]})); assert_eq!(failed.runs[0].state,"failed");
    }
    #[test]
    fn provider_permission_requests_wait_for_an_explicit_reply() {
        let mut s = session("claude"); apply_event(&mut s, &json!({"type":"control_request","request_id":"q","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"test"}}}));
        assert_eq!(s.runs[0].state,"needs_input"); let denied = response("claude", &s.requests[0], json!({"decision":"decline"})).unwrap(); assert_eq!(denied["response"]["response"]["behavior"],"deny");
        let mut pi = session("pi"); apply_event(&mut pi, &json!({"type":"extension_ui_request","id":"p","method":"confirm","title":"Continue?"}));
        assert_eq!(response("pi", &pi.requests[0], json!({"decision":"accept"})).unwrap()["confirmed"],true);
    }
}
