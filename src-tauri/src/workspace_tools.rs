use crate::{map_ops::{self,Operation}, resources, store::{Store, Result, error}};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{io::{BufRead,Read,Write}, path::{Path,PathBuf}};
fn object(properties: Value, required: &[&str]) -> Value {json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})}
pub fn definitions() -> Value {
    let string=json!({"type":"string"});let node=json!({"type":"string","description":"Existing node ID in this session's workspace"});let mutation=json!({"type":"string","description":"Unique stable ID for this intended mutation; reuse it only when retrying the same operation"});
    json!([
        {"name":"northstar_workspace_read","description":"Read current workspace and node summaries. Ordinary conversation does not create map nodes.","inputSchema":object(json!({}),&[]),"annotations":{"readOnlyHint":true}},
        {"name":"northstar_node_read","description":"Read the full existing node including materials, progress and acceptance conditions.","inputSchema":object(json!({"nodeId":node}),&["nodeId"]),"annotations":{"readOnlyHint":true}},
        {"name":"northstar_material_read","description":"Read a node's explicitly linked UTF-8 material within approved directories.","inputSchema":object(json!({"nodeId":node,"materialId":string}),&["nodeId","materialId"]),"annotations":{"readOnlyHint":true}},
        {"name":"northstar_progress","description":"Append a meaningful progress record to an existing node, with session/run provenance. Does not mark the event complete.","inputSchema":object(json!({"nodeId":node,"mutationId":mutation,"text":string}),&["nodeId","mutationId","text"]),"annotations":{"destructiveHint":false,"idempotentHint":true}},
        {"name":"northstar_update_node","description":"Propose updated node content. Read the node first; expectedBody must exactly equal its previous body. Concurrent user edits are retained and the proposal goes into history.","inputSchema":object(json!({"nodeId":node,"mutationId":mutation,"expectedBody":string,"body":string,"text":string}),&["nodeId","mutationId","expectedBody","body","text"]),"annotations":{"destructiveHint":false,"idempotentHint":true}},
        {"name":"northstar_keep_artifact","description":"Preserve a worthwhile result as a child artifact of an existing node. Use only for an explicitly requested or useful durable result, not for each chat reply.","inputSchema":object(json!({"nodeId":node,"mutationId":mutation,"title":string,"body":string}),&["nodeId","mutationId","title","body"]),"annotations":{"destructiveHint":false,"idempotentHint":true}}
    ])
}
fn string<'a>(args: &'a Value, key: &str, limit: usize) -> Result<&'a str> {args[key].as_str().filter(|s|s.len()<=limit && !s.contains('\0')).ok_or_else(||format!("参数 {key} 无效"))}
fn scope(store: &Store, session: &str) -> Result<Value> {
    let db=Connection::open_with_flags(store.root.join("agents/agent-sessions.sqlite3"),OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;db.busy_timeout(std::time::Duration::from_secs(5)).map_err(error)?;
    let raw:String=db.query_row("SELECT data FROM agent_sessions WHERE id=?1",[session],|row|row.get(0)).map_err(error)?;let value:Value=serde_json::from_str(&raw).map_err(error)?;
    if !value["runs"].as_array().and_then(|runs|runs.last()).is_some_and(|run|["running","needs_input"].contains(&run["state"].as_str().unwrap_or("")) && run["cancelRequested"]!=true) {return Err("此会话没有正在执行的任务，工具权限已收回".into());}
    Ok(value)
}
pub fn call(store: &Store, session_id: &str, name: &str, args: &Value) -> Result<Value> {
    let session=scope(store,session_id)?;let workspace=session["workspaceId"].as_str().ok_or("会话工作区无效")?;let space=resources::space(store,workspace)?;
    if name=="northstar_workspace_read" {return Ok(json!({"workspaceId":workspace,"name":space["name"],"sessionNodeId":session["nodeId"],"nodes":space["nodes"].as_array().into_iter().flatten().map(|n|json!({"id":n["id"],"parentId":n["parentId"],"title":n["title"],"kind":n["kind"],"progress":n["progress"]})).collect::<Vec<_>>()}));}
    let node=string(args,"nodeId",100)?;let source=space["nodes"].as_array().into_iter().flatten().find(|n|n["id"]==node).ok_or("节点不属于当前会话工作区")?;
    if name=="northstar_node_read" {return Ok(source.clone());}
    if name=="northstar_material_read" {return serde_json::to_value(resources::read_material(store,workspace,node,string(args,"materialId",100)?)?).map_err(error);}
    let kind=match name {"northstar_progress"=>"progress","northstar_update_node"=>"update","northstar_keep_artifact"=>"artifact",_=>return Err("未知工作区工具".into())};
    let mutation=string(args,"mutationId",100)?;if mutation.is_empty() || !mutation.bytes().all(|b|b.is_ascii_alphanumeric() || [b'-',b'_'].contains(&b)) {return Err("变更标识仅支持字母、数字、下划线和连字符".into());}
    if kind=="progress" || kind=="update" {if string(args,"text",6000)?.trim().is_empty() {return Err("进展说明不能为空".into());}}
    if kind=="update" || kind=="artifact" {string(args,"body",60000)?;}
    if kind=="update" {string(args,"expectedBody",60000)?;}
    if kind=="artifact" {let title=string(args,"title",480)?;if title.trim().is_empty()||title.encode_utf16().count()>120 {return Err("产物名称需要 1 至 120 个字符".into());}}
    let op=Operation{seq:0,id:format!("{session_id}-{mutation}"),workspace_id:workspace.into(),node_id:node.into(),session_id:session_id.into(),run_id:session["runs"].as_array().unwrap().last().unwrap()["id"].as_str().ok_or("执行标识无效")?.into(),kind:kind.into(),payload:args.clone(),at:chrono::Utc::now().timestamp_millis() as u64};
    let op=map_ops::append(store,op)?;Ok(json!({"recorded":true,"operationId":op.id,"sequence":op.seq,"message":"操作已记录；前台若有同时编辑，保留用户内容并把 AI 内容写入建议记录。事件进度与验收状态保持独立。"}))
}
fn dispatch(store: &Store, session: &str, method: &str, params: &Value) -> Result<Value> {
    match method {
        "initialize"=>Ok(json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"northstar-workspace","version":"1.0.0"}})),
        "ping"=>Ok(json!({})),"tools/list"=>Ok(json!({"tools":definitions()})),
        "tools/call"=>Ok(match call(store,session,params["name"].as_str().ok_or("工具名称无效")?,&params["arguments"]) {Ok(value)=>json!({"content":[{"type":"text","text":serde_json::to_string(&value).map_err(error)?}],"isError":false}),Err(error)=>json!({"content":[{"type":"text","text":error}],"isError":true})}),
        _=>Err("未知 MCP 方法".into())
    }
}
pub fn serve(root: &Path, session: &str) -> Result<()> {
    let store=Store::open(root.into())?;let input=std::io::stdin();let mut reader=input.lock();let output=std::io::stdout();let mut writer=output.lock();let mut line=String::new();
    loop {line.clear();if reader.by_ref().take(1_000_001).read_line(&mut line).map_err(error)?==0 {break;}if line.len()>1_000_000 {return Err("MCP 请求过大".into());}let value:Value=match serde_json::from_str(&line) {Ok(value)=>value,Err(_)=>{continue;}};let Some(id)=value.get("id") else{continue;};
        let response=match dispatch(&store,session,value["method"].as_str().unwrap_or(""),&value["params"]) {Ok(result)=>json!({"jsonrpc":"2.0","id":id,"result":result}),Err(error)=>json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":error}})};
        serde_json::to_writer(&mut writer,&response).map_err(error)?;writer.write_all(b"\n").and_then(|_|writer.flush()).map_err(error)?;
    }Ok(())
}
pub fn cli() -> bool {
    let args:Vec<_>=std::env::args_os().collect();if args.get(1).is_none_or(|arg|arg!="--northstar-mcp") {return false;}
    if let (Some(root),Some(session))=(args.get(2),args.get(3)) {if let Err(error)=serve(&PathBuf::from(root),&session.to_string_lossy()) {eprintln!("{error}");std::process::exit(1);}}else{eprintln!("缺少工作区工具参数");std::process::exit(2);}true
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_calls_are_bound_to_active_session_and_record_idempotent_source() {
        let root=std::env::temp_dir().join(format!("northstar-tool-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();std::fs::create_dir(root.join("agents")).unwrap();let agents=Connection::open(root.join("agents/agent-sessions.sqlite3")).unwrap();agents.execute_batch("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,data TEXT);").unwrap();let mut session=json!({"workspaceId":"w","nodeId":"n","runs":[{"id":"r","state":"running"}]});agents.execute("INSERT INTO agent_sessions VALUES('s',?1)",[session.to_string()]).unwrap();
        crate::workspace_state::save(&store,&json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"n","body":"Original","progress":20}],"dock":{}},{"id":"other","name":"Other","nodes":[{"id":"outside"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]})).unwrap();
        let args=json!({"nodeId":"n","mutationId":"m","text":"Progress"});assert_eq!(call(&store,"s","northstar_progress",&args).unwrap()["sequence"],1);assert_eq!(call(&store,"s","northstar_progress",&args).unwrap()["sequence"],1);assert!(call(&store,"s","northstar_node_read",&json!({"nodeId":"outside"})).is_err());
        assert!(call(&store,"s","northstar_keep_artifact",&json!({"nodeId":"n","mutationId":"long-title","title":"x".repeat(121),"body":"Result"})).is_err());
        let db=store.db.lock().unwrap();let ops=map_ops::changes(&db,0).unwrap();assert_eq!(ops[0].session_id,"s");assert_eq!(ops[0].run_id,"r");drop(db);
        session["runs"][0]["state"]=json!("cancelled");agents.execute("UPDATE agent_sessions SET data=?1 WHERE id='s'",[session.to_string()]).unwrap();assert!(call(&store,"s","northstar_progress",&json!({"nodeId":"n","mutationId":"later","text":"After stop"})).is_err());
    }
}
