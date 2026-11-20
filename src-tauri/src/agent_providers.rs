use super::{feedback, AgentSession, Message, Request, Result, RunPhase, ToolConfig, now};
use serde_json::{json, Value};
use std::{io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

#[cfg(windows)]
static PI_WSL_EXECUTABLE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

pub fn invalidate_pi_discovery() {
    #[cfg(windows)]
    if let Ok(mut path) = PI_WSL_EXECUTABLE.lock() {*path = None;}
}

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
        if backend == "pi" {
            if let Some(program) = PI_WSL_EXECUTABLE.lock().ok().and_then(|entry| entry.clone()) {
                return Some(Provider {backend: backend.into(), program, wsl: true, prefix: vec![]});
            }
        }
        let mut command = Command::new("wsl.exe");
        command.args(["--exec", "/bin/bash", "-ic", if backend == "claude" {"command -v claude"} else {"command -v pi"}]);
        let output = timed_output(command, 8)?;
        let path = String::from_utf8_lossy(&output).lines().find(|line| line.starts_with('/'))?.trim().to_string();
        let program = PathBuf::from(path);
        if backend == "pi" {
            if let Ok(mut entry) = PI_WSL_EXECUTABLE.lock() {*entry = Some(program.clone());}
        }
        return Some(Provider {backend: backend.into(), program, wsl: true, prefix: vec![]});
    }
    #[cfg(not(windows))] None
}
fn timed_output(command: Command, seconds: u64) -> Option<Vec<u8>> {
    timed_output_with_input(command, None, seconds)
}
fn timed_output_with_input(mut command: Command, input: Option<Vec<u8>>, seconds: u64) -> Option<Vec<u8>> {
    command.stdin(if input.is_some() {Stdio::piped()} else {Stdio::null()});
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
    let mut child = command.spawn().ok()?; let start = Instant::now();
    let mut stdout = child.stdout.take()?;
    let output = std::thread::spawn(move || {let mut bytes = Vec::new(); stdout.read_to_end(&mut bytes).ok()?; Some(bytes)});
    if let Some(input) = input {
        let mut stdin = child.stdin.take()?;
        std::thread::spawn(move || {let _ = stdin.write_all(&input);});
    }
    loop {
        if let Some(status) = child.try_wait().ok()? {return if status.success() {output.join().ok()?} else {None};}
        if start.elapsed() > Duration::from_secs(seconds) {let _ = child.kill(); let _ = child.wait(); return None;}
        std::thread::sleep(Duration::from_millis(40));
    }
}
fn wsl_path(path: &str) -> Result<String> {
    if path.starts_with('/') {return Ok(path.into());}
    let mut command = Command::new("wsl.exe"); command.args(["--exec", "wslpath", "-a", "-u", path]);
    timed_output(command, 8).and_then(|bytes| String::from_utf8(bytes).ok()).map(|s| s.trim().to_string()).filter(|s| s.starts_with('/')).ok_or_else(|| "无法把工作目录转换为 WSL 路径".into())
}
fn wsl_paths(paths: &[String]) -> Result<Vec<String>> {
    let mut command = Command::new("wsl.exe");
    let script = r#"for path; do case "$path" in /*) converted="$path";; *) converted=$(wslpath -a -u "$path") || exit 1;; esac; printf '%s\0' "$converted"; done"#;
    command.args(["--exec", "/bin/bash", "-c", script, "northstar"]).args(paths);
    let output = timed_output(command, 8).and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or("无法批量转换 Pi 的 WSL 路径")?;
    let translated: Vec<_> = output.split_terminator('\0').map(str::to_owned).collect();
    if translated.len() != paths.len() || translated.iter().any(|path| !path.starts_with('/')) {
        return Err("Pi 返回的 WSL 路径不完整".into());
    }
    Ok(translated)
}
fn relocate_pi_header(path:&Path,cwd:&str)->Result<()> {
    use std::io::{BufRead,Write};
    let mut input=std::io::BufReader::new(std::fs::File::open(path).map_err(|e|e.to_string())?);let mut line=String::new();input.read_line(&mut line).map_err(|e|e.to_string())?;let mut header:Value=serde_json::from_str(&line).map_err(|_|"Pi 来源会话头无效，历史文件已保留")?;
    if header["type"]!="session"{return Err("Pi 来源会话头无效，历史文件已保留".into());}if header["cwd"]==cwd{return Ok(());}header["cwd"]=json!(cwd);
    let temporary=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));let result=(||{let mut output=std::fs::File::create(&temporary).map_err(|e|e.to_string())?;serde_json::to_writer(&mut output,&header).map_err(|e|e.to_string())?;output.write_all(b"\n").map_err(|e|e.to_string())?;std::io::copy(&mut input,&mut output).map_err(|e|e.to_string())?;output.sync_all().map_err(|e|e.to_string())?;drop(output);drop(input);std::fs::rename(&temporary,path).map_err(|e|e.to_string())})();if result.is_err(){let _=std::fs::remove_file(temporary);}result
}
impl Provider {
    pub fn pi_model_scope(&self, cwd: &str, models: &Value) -> Option<Vec<String>> {
        let helper = include_str!("pi-model-scope.mjs");
        let command = if self.wsl {
            let mut command = Command::new("wsl.exe");
            command.args(["--cd", cwd, "--exec", "/bin/bash", "-ic",
                r#"dist="$(dirname "$(readlink -f "$1")")"; exec node --input-type=module -e "$2" "$dist/index.js""#,
                "northstar"]).arg(&self.program).arg(helper);
            command
        } else {
            let cli = Path::new(self.prefix.first()?);
            let mut command = Command::new(&self.program);
            command.current_dir(cwd).args(["--input-type=module", "-e", helper]).arg(cli.with_file_name("index.js"));
            command
        };
        let inventory: Vec<_> = models.as_array()?.iter().map(|model| json!({
            "id":model["id"], "provider":model["provider"], "name":model["name"], "reasoning":model["reasoning"],
            "thinkingLevelMap":model["thinkingLevelMap"]
        })).collect();
        let bytes = timed_output_with_input(command, Some(serde_json::to_vec(&inventory).ok()?), 5)?;
        serde_json::from_slice(bytes.split(|&byte| byte == b'\n').rfind(|line| line.starts_with(b"["))?).ok()
    }
    pub fn command(&self, cwd: &str, source: Option<&str>, session_root: &Path, tools: Option<&ToolConfig>, probe: bool, (model, effort): (Option<&str>, Option<&str>)) -> Result<(Command, Option<String>, Option<String>)> {
        let mut args: Vec<String> = Vec::new(); let mut planned = None;
        let pi_file = (self.backend == "pi" && !probe).then(|| source.map(String::from)
            .unwrap_or_else(|| session_root.join(format!("{}.jsonl", uuid::Uuid::new_v4())).to_string_lossy().into_owned()));
        let pi_owned = pi_file.as_ref().and_then(|file| file.rsplit(['\\', '/']).next())
            .map(|name| session_root.join(name)).filter(|path| path.is_file());
        let pi_extension = if self.backend == "pi" {
            tools.map(|tools| tools.args.last().ok_or("缺少工具会话范围")
                .map(|id| session_root.join(format!("northstar-{id}.ts")))).transpose()?
        } else { None };
        let pi_paths = if let Some(file) = pi_file.as_ref().filter(|_| self.wsl) {
            let mut paths = vec![cwd.to_owned(), file.clone()];
            paths.extend(pi_owned.as_ref().map(|path| path.to_string_lossy().into_owned()));
            paths.extend(tools.map(|tool| tool.command.clone()));
            paths.extend(pi_extension.as_ref().map(|path| path.to_string_lossy().into_owned()));
            let translated = wsl_paths(&paths)?;
            paths.into_iter().zip(translated).collect::<Vec<_>>()
        } else { Vec::new() };
        let translate = |path: &str| -> Result<String> {
            if !self.wsl { return Ok(path.to_owned()); }
            if !pi_paths.is_empty() {
                return pi_paths.iter().find(|(original, _)| original == path)
                    .map(|(_, translated)| translated.clone()).ok_or_else(|| "未找到 Pi 的 WSL 路径".into());
            }
            wsl_path(path)
        };
        let runtime_cwd = if probe { cwd.into() } else { translate(cwd)? };
        match self.backend.as_str() {
            "codex" => args.extend(["app-server", "--listen", "stdio://"].map(String::from)),
            "claude" => {
                args.extend(["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "manual", "--permission-prompts", "host"].map(String::from));
                if probe {
                    args.extend(["--no-session-persistence", "--strict-mcp-config", "--settings", r#"{"disableAllHooks":true}"#].map(String::from));
                } else {
                    let id = source.map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    args.extend([if source.is_some() {"--resume"} else {"--session-id"}.to_string(), id.clone()]); planned = Some(id);
                    if let Some(model) = model {args.extend(["--model".into(), model.into()]);}
                    if let Some(effort) = effort {args.extend(["--effort".into(), effort.into()]);}
                }
            },
            "pi" if probe => args.extend(["--mode", "rpc", "--no-session"].map(String::from)),
            "pi" => {
                std::fs::create_dir_all(session_root).map_err(|e| e.to_string())?;
                let file = translate(pi_file.as_deref().ok_or("缺少 Pi 会话路径")?)?;
                if let Some(owned) = &pi_owned {
                    if file == translate(&owned.to_string_lossy())? { relocate_pi_header(owned, &runtime_cwd)?; }
                }
                args.extend(["--mode".into(), "rpc".into(), "--session".into(), file.clone()]); planned = Some(file);
            },
            _ => return Err("不支持的执行器".into()),
        }
        if let Some(tools)=tools {
            let executable=translate(&tools.command)?;
            let server=json!({"command":executable,"args":tools.args});
            if self.backend=="claude" {args.extend(["--mcp-config".into(),json!({"mcpServers":{"northstar":server}}).to_string()]);}
            if let Some(path) = pi_extension {
                std::fs::create_dir_all(session_root).map_err(|e|e.to_string())?;
                let code=include_str!("pi-workspace-tools.ts").replace("__NORTHSTAR_SERVER__",&server.to_string()).replace("__NORTHSTAR_TOOLS__",&tools.definitions.to_string());
                std::fs::write(&path,code).map_err(|e|e.to_string())?;
                args.extend(["--extension".into(), translate(&path.to_string_lossy())?]);
            }
        }
        let token = self.wsl.then(|| uuid::Uuid::new_v4().to_string());
        let mut command = if self.wsl {
            let mut command = Command::new("wsl.exe");
            command.args(["--cd", &runtime_cwd, "--exec", "/usr/bin/setsid", "--wait", "/bin/bash", "-ic", r#"printf '__NORTHSTAR_PROCESS__:%s:%s:%s\n' "$WSL_DISTRO_NAME" "$(id -un)" "$$" >&2; export NORTHSTAR_SESSION_TOKEN="$1"; shift; exec "$@""#, "northstar", token.as_deref().unwrap()]).arg(&self.program).args(args); command
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
    assistant_segment(session, value, replace, None, 0);
}
fn assistant_segment(session: &mut AgentSession, value: &str, replace: bool, timestamp: Option<u64>, block: usize) {
    let Some(run) = session.runs.last().filter(|run| ["running", "needs_input"].contains(&run.state.as_str())) else {return;};
    if value.is_empty() {return;}
    let key = match (timestamp, block) {
        (Some(at), _) => format!("{}-assistant-{at}-{block}", run.id),
        (None, 0) => format!("{}-assistant", run.id),
        (None, _) => format!("{}-assistant-{block}", run.id),
    };
    let message = match session.messages.iter().position(|message| message.id == key) {
        Some(index) => &mut session.messages[index],
        None => {
            session.messages.push(Message {id: key, role: "assistant".into(), text: String::new(), at: timestamp.unwrap_or_else(now)});
            session.messages.last_mut().unwrap()
        }
    };
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
        "claude" => if value["type"] == "stream_event" {value["parent_tool_use_id"].is_null() && value["event"]["delta"]["type"] == "text_delta"} else {["system", "assistant", "result", "control_request"].contains(&value["type"].as_str().unwrap_or(""))},
        "pi" => match value["type"].as_str().unwrap_or("") {
            "message_update" => ["text_delta", "thinking_start", "thinking_end"].contains(&value["assistantMessageEvent"]["type"].as_str().unwrap_or("")),
            "message_end" => value["message"]["role"] == "assistant",
            "extension_error" => value["event"] == "command",
            "agent_start" | "agent_settled" | "tool_execution_start" | "tool_execution_end" |
            "auto_retry_start" | "auto_retry_end" | "auto_compaction_start" | "auto_compaction_end" |
            "extension_ui_request" => true,
            _ => false,
        },
        _ => false,
    }
}
pub fn apply_event(session: &mut AgentSession, value: &Value) {
    if session.backend == "claude" {
        match value["type"].as_str().unwrap_or("") {
            "system" if value["subtype"] == "init" => {
                if let Some(id) = value["session_id"].as_str() {session.source_id = Some(id.into());}
                if let Some(model) = value["model"].as_str() {session.effective_model = Some(model.into());}
            },
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
        let Some(run) = session.runs.last_mut().filter(|run| ["running", "needs_input"].contains(&run.state.as_str())) else {return;};
        if let Some(mut activity) = feedback::pi_activity(value) {
            activity.after_message_id = session.messages.last().map(|message| message.id.clone());
            feedback::upsert(&mut run.activity, activity);
            return;
        }
        match value["type"].as_str().unwrap_or("") {
            "agent_start" => {run.advance_phase(RunPhase::Executing); run.error = None;},
            "extension_error" if value["event"] == "command" && run.phase == Some(RunPhase::Submitting) => {
                run.error = Some(value["error"].as_str().unwrap_or("Pi 扩展命令执行失败").chars().take(1000).collect());
            }
            "message_update" if value["assistantMessageEvent"]["type"] == "text_delta" => {
                run.advance_phase(RunPhase::Responding);
                let update = &value["assistantMessageEvent"];
                let message = &value["message"];
                let partial = &update["partial"];
                let at = message["timestamp"].as_u64().or_else(|| partial["timestamp"].as_u64());
                let blocks = partial["content"].as_array().or_else(|| message["content"].as_array());
                let index = update["contentIndex"].as_u64().and_then(|index| usize::try_from(index).ok())
                    .or_else(|| blocks.and_then(|items| items.iter().rposition(|item| item["type"] == "text")))
                    .unwrap_or(0);
                if let Some(text) = blocks.and_then(|items| items.get(index))
                    .filter(|block| block["type"] == "text").and_then(|block| block["text"].as_str()) {
                    assistant_segment(session, text, true, at, index);
                } else {
                    assistant_segment(session, update["delta"].as_str().unwrap_or(""), false, at, index);
                }
            }
            "message_end" if value["message"]["role"] == "assistant" => {
                let message = &value["message"];
                let texts = message["content"].as_array().into_iter().flatten().enumerate()
                    .filter(|(_, part)| part["type"] == "text").filter_map(|(index, part)| {
                        part["text"].as_str().filter(|text| !text.is_empty()).map(|text| (index, text))
                    }).collect::<Vec<_>>();
                if !texts.is_empty() {run.advance_phase(RunPhase::Responding);}
                for (index, text) in texts {
                    assistant_segment(session, text, true, message["timestamp"].as_u64(), index);
                }
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

pub fn pi_idle(state: &Value) -> bool {
    state["isStreaming"] == false && state["isCompacting"] == false && state["pendingMessageCount"].as_u64() == Some(0)
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
    fn relocating_owned_pi_header_preserves_the_transcript_bytes(){let root=std::env::temp_dir().join(format!("northstar-pi-header-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&root).unwrap();let path=root.join("session.jsonl");let body="{\"type\":\"message\",\"text\":\"保留\"}\n";std::fs::write(&path,format!("{{\"type\":\"session\",\"cwd\":\"old\"}}\n{body}")).unwrap();relocate_pi_header(&path,"new").unwrap();let text=std::fs::read_to_string(path).unwrap();let (header,rest)=text.split_once('\n').unwrap();assert_eq!(serde_json::from_str::<Value>(header).unwrap()["cwd"],"new");assert_eq!(rest,body);}
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
    fn pi_command_error_is_retained_until_idle_confirmation() {
        let mut s = session("pi");
        s.runs[0].phase = Some(RunPhase::Submitting);
        let event = json!({"type":"extension_error","event":"command","error":"command failed"});
        assert!(relevant("pi", &event));
        apply_event(&mut s, &event);
        assert_eq!(s.runs[0].state, "running");
        assert_eq!(s.runs[0].error.as_deref(), Some("command failed"));
        let idle = json!({"isStreaming":false,"isCompacting":false,"pendingMessageCount":0});
        assert!(pi_idle(&idle));
        assert!(!pi_idle(&json!({"isStreaming":false,"isCompacting":true,"pendingMessageCount":0})));
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
