use northstar_lib::native_agents::{AgentHost,AgentSession,TranscriptFrame};
use serde_json::json;
use std::{sync::{Arc,Mutex},time::{Duration,Instant}};
fn settled(host:&AgentHost)->Result<AgentSession,String>{
    let start=Instant::now();loop{let session=host.session("chat")?;let run=session.runs.last().unwrap();
        if run.state=="succeeded"{return Ok(session);}if run.state!="running"{return Err(format!("{}: {:?}",run.state,run.error));}
        if start.elapsed()>Duration::from_secs(120){host.stop("chat")?;return Err("Live conversation timed out".into());}
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn main()->Result<(),Box<dyn std::error::Error>>{
    let backend=std::env::var("NORTHSTAR_AGENT_BACKEND").unwrap_or("codex".into());
    let root=std::env::current_dir()?.join("artifacts").join(format!("chat-live-{}",uuid::Uuid::new_v4()));
    let host=AgentHost::open(root.clone(),Arc::new(|_|{}))?;
    let frames=Arc::new(Mutex::new(Vec::<(Instant,TranscriptFrame)>::new()));let output=frames.clone();
    host.configure_transcript_sink(Arc::new(move|frame|output.lock().unwrap().push((Instant::now(),frame.clone()))));
    host.create("chat".into(),"chat-workspace".into(),None,backend.clone(),"新的会话".into(),None)?;
    let prompt=" \t\r\nRemember the exact token NORTHSTAR_CHAT_OK. Write 24 separate short lines, labelled 1 to 24, each containing that token. Do not use tools.\n ";
    let cold=Instant::now();host.send("chat","first".into(),prompt.into())?;let send_ack_ms=cold.elapsed().as_millis();let first=settled(&host)?;
    assert_eq!(first.messages[0].text,prompt);assert!(first.messages.iter().any(|m|m.role=="assistant"&&m.text.contains("NORTHSTAR_CHAT_OK")));
    let source=first.source_id.clone();let first_token_ms=frames.lock().unwrap().first().map(|(at,_)|at.duration_since(cold).as_millis());
    assert!(first_token_ms.is_some(),"the real provider must deliver streaming frames");
    let warm=Instant::now();host.send("chat","second".into(),"What exact token did I ask you to remember? Reply with only that token. Do not use tools.".into())?;let second=settled(&host)?;
    assert_eq!(second.source_id,source);assert!(second.messages.iter().any(|m|m.id.starts_with("second-")&&m.role=="assistant"&&m.text.contains("NORTHSTAR_CHAT_OK")));
    let warm_turn_ms=warm.elapsed().as_millis();
    host.send("chat","cancel".into(),"Write 10000 distinct integers, one per line. Do not use tools.".into())?;
    let deadline=Instant::now();while host.session("chat")?.runs.last().unwrap().source_turn_id.is_none()&&deadline.elapsed()<Duration::from_secs(20){std::thread::sleep(Duration::from_millis(20));}
    let stop=Instant::now();let stopped=host.stop("chat")?;let stop_ms=stop.elapsed().as_millis();assert_eq!(stopped.runs.last().unwrap().state,"cancelled");host.shutdown();
    let frames=frames.lock().unwrap();let last=host.session("chat")?;
    let report=json!({"backend":backend,"dataPath":root,"sendAckMs":send_ack_ms,"firstTokenMs":first_token_ms,"warmTurnMs":warm_turn_ms,"stopMs":stop_ms,"streamFrames":frames.len(),"maxFrameBytes":frames.iter().map(|(_,f)|serde_json::to_vec(f).unwrap().len()).max(),"fullTranscriptBytes":serde_json::to_vec(&last)?.len(),"passed":["real streaming frames","raw prompt including whitespace","same provider session across turns","context retained","stop acknowledged"]});
    std::fs::write(format!("artifacts/chat-live-{backend}.json"),serde_json::to_vec_pretty(&report)?)?;println!("{report}");Ok(())
}
