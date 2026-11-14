#[path = "../src/native_agents.rs"]
mod native_agents;
use native_agents::AgentHost;
use serde_json::json;
use std::{sync::Arc, time::{Duration, Instant}};

fn wait(host: &AgentHost, session: &str) -> native_agents::Result<native_agents::AgentSession> {
    let started = Instant::now();
    loop {
        let state = host.session(session)?;
        if let Some(run) = state.runs.last() {if !["running", "needs_input"].contains(&run.state.as_str()) {if run.state != "succeeded" {return Err(format!("Execution {}: {:?}", run.state, run.error));} return Ok(state);} if run.state == "needs_input" {return Err("Smoke test unexpectedly requested user input".into());}}
        if started.elapsed() > Duration::from_secs(120) {return Err("Live agent smoke timed out".into());}
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?.join("artifacts").join(format!("agent-live-{}", uuid::Uuid::new_v4()));
    let host = AgentHost::open(root.clone(), Arc::new(|_| {}))?;
    let session = host.create("smoke".into(), "smoke-workspace".into(), None, "codex".into(), "新的会话".into(), None)?;
    host.send(&session.id, "r1".into(), "Reply with exactly NORTHSTAR_OK. Do not use any tools.".into())?;
    let first = wait(&host, &session.id)?;
    if !first.messages.iter().any(|m| m.role == "assistant" && m.text.contains("NORTHSTAR_OK")) {return Err("Missing real first reply".into());}
    let source = first.source_id.clone(); host.shutdown(); drop(host);
    let resumed = AgentHost::open(root.clone(), Arc::new(|_| {}))?;
    resumed.send("smoke", "r2".into(), "What exact token did I ask you to say in the previous message? Reply with only that token. Do not use any tools.".into())?;
    let second = wait(&resumed, "smoke")?;
    if second.source_id != source || second.messages.iter().filter(|m| m.role == "assistant" && m.text.contains("NORTHSTAR_OK")).count() < 2 {return Err("Conversation did not resume correctly".into());}
    resumed.send("smoke", "r3".into(), "List 10000 distinct integers, one per line. Do not use any tools.".into())?;
    let started = Instant::now();
    while resumed.session("smoke")?.runs.last().is_some_and(|run| run.source_turn_id.is_none() && run.state == "running") && started.elapsed() < Duration::from_secs(20) {std::thread::sleep(Duration::from_millis(20));}
    let stopped = resumed.stop("smoke")?;
    if stopped.runs.last().is_none_or(|run| run.state != "cancelled") {return Err("Stop did not cancel the run".into());}
    resumed.shutdown();
    let report = json!({"passed":["real Codex response", "durable transcript", "resume after host restart", "same provider thread", "interrupt running turn"],"sourceId":source,"dataPath":root,"messages":second.messages.len()});
    std::fs::write("artifacts/agent-live.json", serde_json::to_vec_pretty(&report)?)?;
    println!("{report}"); Ok(())
}
