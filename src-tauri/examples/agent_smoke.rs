use northstar_lib::native_agents;
use native_agents::AgentHost;
use serde_json::json;
use std::{sync::Arc, time::{Duration, Instant}};

fn wait(host: &AgentHost, session: &str) -> native_agents::Result<native_agents::AgentSession> {
    let started = Instant::now();
    loop {
        let state = host.session(session)?;
        if let Some(run) = state.runs.last() {if !["running", "needs_input"].contains(&run.state.as_str()) {if run.state != "succeeded" {return Err(format!("Execution {}: {:?}", run.state, run.error));} return Ok(state);} if run.state == "needs_input" {
            if std::env::var_os("NORTHSTAR_TOOLS_ONLY").is_some() && !state.requests.is_empty() && state.requests.iter().all(|r|r.kind=="elicitation" && r.payload["serverName"]=="northstar" && r.payload["_meta"]["tool_params"]["nodeId"]=="root" && ["verify-progress","verify-artifact"].contains(&r.payload["_meta"]["tool_params"]["mutationId"].as_str().unwrap_or(""))) {for request in &state.requests {host.respond(session,&request.id,json!({"action":"accept","content":{}}))?;}}
            else {return Err("Smoke test unexpectedly requested user input".into());}
        }}
        if started.elapsed() > Duration::from_secs(120) {return Err("Live agent smoke timed out".into());}
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn cancel(host: &Arc<AgentHost>, id: &str, run_id: &str) -> native_agents::Result<()> {
    host.send(id, run_id.into(), "List 10000 distinct integers, one per line. Do not use any tools.".into())?;
    let started = Instant::now();
    while host.session(id)?.runs.last().is_some_and(|run| run.source_turn_id.is_none() && run.state == "running") && started.elapsed() < Duration::from_secs(20) {std::thread::sleep(Duration::from_millis(20));}
    let stopped = host.stop(id)?;
    if stopped.runs.last().is_none_or(|run| run.state != "cancelled") {return Err("Stop did not cancel the run".into());}
    Ok(())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?.join("artifacts").join(format!("agent-live-{}", uuid::Uuid::new_v4()));
    let tool_test=std::env::var_os("NORTHSTAR_TOOLS_ONLY").is_some();
    let backup_test=std::env::var_os("NORTHSTAR_BACKUP_ONLY").is_some();
    let host = AgentHost::open(if tool_test||backup_test {root.join("agents")}else{root.clone()}, Arc::new(|_| {}))?;
    let backend = std::env::var("NORTHSTAR_AGENT_BACKEND").unwrap_or_else(|_| "codex".into());
    let passthrough_test=std::env::var_os("NORTHSTAR_PASSTHROUGH_ONLY").is_some();
    let session = host.create("smoke".into(), "smoke-workspace".into(), if passthrough_test {Some("root".into())}else{None}, backend.clone(), "新的会话".into(), None)?;
    if backup_test {
        if backend!="pi"{return Err("Portable provider-file recovery probe uses Pi".into());}
        std::fs::write(std::path::Path::new(&session.cwd).join("workspace-location.txt"),"NORTHSTAR_OLD_LOCATION")?;
        host.send(&session.id,"before-backup".into(),"Reply only NORTHSTAR_BACKUP_OK. Do not use tools.".into())?;wait(&host,&session.id)?;host.shutdown();drop(host);
        let store=northstar_lib::WorkbenchStore::open(root.clone())?;let backup=northstar_lib::create_full_backup(&store,"live-recovery")?;let restored_root=root.join("restored-location");let restored_store=northstar_lib::WorkbenchStore::open(restored_root.clone())?;northstar_lib::restore_full_backup(&restored_store,&root.join("backups").join(backup.name))?;
        let restored=AgentHost::open(restored_root.join("agents"),Arc::new(|_|{}))?;let relocated=restored.session("smoke")?;let token=format!("NORTHSTAR_RESTORED_{}",uuid::Uuid::new_v4());std::fs::write(std::path::Path::new(&relocated.cwd).join("workspace-location.txt"),&token)?;restored.send("smoke","after-backup".into(),"What exact token did I ask you to say in the previous message? Also use the read tool on the relative file workspace-location.txt and echo its exact content. Do not use shell or other tools.".into())?;let result=wait(&restored,"smoke")?;restored.shutdown();assert!(result.messages.iter().filter(|m|m.role=="assistant"&&m.text.contains("NORTHSTAR_BACKUP_OK")).count()>=2);assert!(result.messages.iter().any(|m|m.role=="assistant"&&m.text.contains(&token)),"Pi must read from the restored work directory, not the previous header cwd");assert!(result.source_id.as_deref().unwrap_or("").contains("restored-location"));
        let report=json!({"backend":backend,"passed":["complete backup restores real transcript", "Pi resumes copied provider session in another directory", "owned work directory is relocated", "real relative file read uses restored directory"],"dataPath":root,"restoredPath":restored_root});std::fs::write("artifacts/agent-backup-pi.json",serde_json::to_vec_pretty(&report)?)?;println!("{report}");return Ok(());
    }
    if tool_test {
        let db=rusqlite::Connection::open(root.join("northstar.sqlite3"))?;db.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);PRAGMA user_version=5;")?;
        let snapshot=json!({"version":2,"activeId":"smoke-workspace","spaces":[{"id":"smoke-workspace","name":"MCP verification","nodes":[{"id":"root","kind":"root","title":"MCP fixture","parentId":null,"side":1,"body":"Fixture","progress":20,"due":"","steps":[]}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]});
        db.execute("INSERT INTO metadata(key,value) VALUES('workbench-shell-v2',?1)",[snapshot.to_string()])?;
        host.configure_tools(native_agents::WorkspaceTools{executable:std::env::var_os("NORTHSTAR_TOOLS_EXE").ok_or("Set NORTHSTAR_TOOLS_EXE to the current Northstar binary")?.into(),root:root.clone(),definitions:northstar_lib::workspace_tool_definitions()});
        host.send(&session.id,"tools".into(),"Use northstar_workspace_read. Then call northstar_progress with nodeId root, mutationId verify-progress, text MCP_PROGRESS_OK. Call northstar_keep_artifact with nodeId root, mutationId verify-artifact, title MCP artifact, body MCP_ARTIFACT_OK. Do not run shell or file tools. Report any tool failure; do not pretend success.".into())?;
        let result=wait(&host,&session.id)?;host.shutdown();let count:i64=db.query_row("SELECT COUNT(*) FROM map_operations",[],|row|row.get(0))?;assert_eq!(count,2,"Both real MCP mutations must be recorded");
        let raw:String=db.query_row("SELECT value FROM metadata WHERE key='workbench-shell-v2'",[],|row|row.get(0))?;let value:serde_json::Value=serde_json::from_str(&raw)?;assert_eq!(value["spaces"][0]["nodes"].as_array().unwrap().len(),2);assert_eq!(value["spaces"][0]["nodes"][0]["progress"],20);
        let report=json!({"backend":backend,"passed":["real MCP workspace read", "progress with session/run source", "explicit artifact node", "acceptance progress stays independent"],"dataPath":root,"sourceId":result.source_id});std::fs::write(format!("artifacts/agent-tools-{backend}.json"),serde_json::to_vec_pretty(&report)?)?;println!("{report}");return Ok(());
    }
    if std::env::var_os("NORTHSTAR_CANCEL_ONLY").is_some() {
        cancel(&host, &session.id, "cancel")?; host.shutdown();
        let report = json!({"backend":backend,"passed":["explicit stop is cancelled, not failed", "owned runtime cleanup"],"dataPath":root});
        std::fs::write(format!("artifacts/agent-cancel-{backend}.json"), serde_json::to_vec_pretty(&report)?)?; println!("{report}"); return Ok(());
    }
    if passthrough_test {
        if backend!="pi" {return Err("Provider transcript passthrough probe uses Pi".into());}
        let prompt=" \t\r\nReply only NORTHSTAR_RAW_OK. Do not use tools.\n格式：\"quotes\"、`code`、\\path\u{2028}中文\r\n\t ".to_string();
        host.send(&session.id,"passthrough".into(),prompt.clone())?;
        let result=wait(&host,&session.id)?;host.shutdown();
        assert!(!result.title.trim().is_empty());
        assert_eq!(result.messages.iter().find(|m|m.role=="user").unwrap().text,prompt);
        assert!(result.runs[0].context.is_none());
        let file=result.source_id.as_ref().ok_or("Missing provider transcript")?.rsplit(['\\','/']).next().ok_or("Missing provider filename")?;
        let transcript=std::fs::read_to_string(root.join("provider-sessions").join(file))?;
        let received=transcript.lines().filter_map(|line|serde_json::from_str::<serde_json::Value>(line).ok()).filter(|value|value["message"]["role"]=="user").map(|value|value["message"]["content"].as_array().unwrap().iter().filter_map(|part|part["text"].as_str()).collect::<String>()).collect::<Vec<_>>();
        assert_eq!(received,vec![prompt.clone()],"Provider must receive exactly the original prompt");
        let restored=AgentHost::open(root.clone(),Arc::new(|_|{}))?.session(&session.id)?;
        assert_eq!(restored.messages.iter().find(|m|m.role=="user").unwrap().text,prompt);assert!(restored.runs[0].context.is_none());
        let report=json!({"backend":backend,"passed":["bound-node message reaches provider unchanged", "leading and trailing whitespace preserved", "no automatic context", "exact prompt survives restart"],"dataPath":root});std::fs::write(format!("artifacts/agent-passthrough-{backend}.json"),serde_json::to_vec_pretty(&report)?)?;println!("{report}");return Ok(());
    }
    host.send(&session.id, "r1".into(), "Reply with exactly NORTHSTAR_OK. Do not use any tools.".into())?;
    let first = wait(&host, &session.id)?;
    if !first.messages.iter().any(|m| m.role == "assistant" && m.text.contains("NORTHSTAR_OK")) {return Err("Missing real first reply".into());}
    let source = first.source_id.clone(); host.shutdown(); drop(host);
    let resumed = AgentHost::open(root.clone(), Arc::new(|_| {}))?;
    resumed.send("smoke", "r2".into(), "What exact token did I ask you to say in the previous message? Reply with only that token. Do not use any tools.".into())?;
    let second = wait(&resumed, "smoke")?;
    if second.source_id != source || second.messages.iter().filter(|m| m.role == "assistant" && m.text.contains("NORTHSTAR_OK")).count() < 2 {return Err("Conversation did not resume correctly".into());}
    cancel(&resumed, "smoke", "r3")?;
    resumed.shutdown();
    let report = json!({"backend":backend,"passed":["real provider response", "durable transcript", "resume after host restart", "same provider session", "interrupt running turn"],"sourceId":source,"dataPath":root,"messages":second.messages.len()});
    std::fs::write(format!("artifacts/agent-live-{backend}.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{report}"); Ok(())
}
