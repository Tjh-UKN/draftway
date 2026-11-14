use crate::store::{Store, Result, error};
use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Operation {pub seq: u64, pub id: String, pub workspace_id: String, pub node_id: String, pub session_id: String, pub run_id: String, pub kind: String, pub payload: Value, pub at: u64}
fn init(db: &Connection) -> Result<()> {db.execute_batch("CREATE TABLE IF NOT EXISTS map_operations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))); ").map_err(error)}
pub fn changes(db: &Connection, after: u64) -> Result<Vec<Operation>> {
    init(db)?;let mut query=db.prepare("SELECT seq,data FROM map_operations WHERE seq>?1 ORDER BY seq").map_err(error)?;
    let rows=query.query_map([after],|row|Ok((row.get::<_,u64>(0)?,row.get::<_,String>(1)?))).map_err(error)?;
    rows.map(|row| {let (seq,data)=row.map_err(error)?;let mut op:Operation=serde_json::from_str(&data).map_err(error)?;op.seq=seq;Ok(op)}).collect()
}
pub fn apply(snapshot: &mut Value, op: &Operation) {
    let Some(space)=snapshot["spaces"].as_array_mut().and_then(|spaces|spaces.iter_mut().find(|s|s["id"]==op.workspace_id)) else {return;};
    let Some(nodes)=space["nodes"].as_array_mut() else{return;};let Some(index)=nodes.iter().position(|n|n["id"]==op.node_id) else{return;};
    if nodes.iter().any(|n|n["updates"].as_array().is_some_and(|updates|updates.iter().any(|u|u["id"]==op.id))) {return;}
    let mut text=op.payload["text"].as_str().unwrap_or("").to_string();
    if op.kind=="update" {if nodes[index]["body"]==op.payload["expectedBody"] {nodes[index]["body"]=op.payload["body"].clone();}else{text=format!("AI 内容建议（原内容已变化，未覆盖）：\n{}",op.payload["body"].as_str().unwrap_or(""));}}
    if op.kind=="artifact" {
        let id=format!("artifact-{}",op.id);
        if nodes.len()>=250 {text="AI 产物未放入地图：节点数量已达上限。".into();}
        else {if !nodes.iter().any(|n|n["id"]==id) {let title=op.payload["title"].as_str().unwrap_or("AI 产物");nodes.push(json!({"id":id,"parentId":op.node_id,"side":nodes[index]["side"].as_i64().unwrap_or(1),"kind":"artifact","title":title,"body":op.payload["body"],"progress":0,"due":"","steps":[],"updates":[{"id":op.id,"text":"从 AI 执行保留产物","at":op.at,"sessionId":op.session_id}]}));}
        text=format!("保留产物：{}",op.payload["title"].as_str().unwrap_or("AI 产物"));}
    }
    if !nodes[index]["updates"].is_array() {nodes[index]["updates"]=json!([]);}
    nodes[index]["updates"].as_array_mut().unwrap().push(json!({"id":op.id,"text":text,"at":op.at,"sessionId":op.session_id}));
}
pub fn merge(db: &Connection, snapshot: &Value) -> Result<Value> {
    let cursor=snapshot["graphCursor"].as_u64().unwrap_or(0);let mut snapshot=snapshot.clone();let ops=changes(db,cursor)?;
    for op in ops {apply(&mut snapshot,&op);snapshot["graphCursor"]=json!(op.seq);}
    Ok(snapshot)
}
pub fn append(store: &Store, mut op: Operation) -> Result<Operation> {
    let mut db=store.db.lock().map_err(error)?;init(&db)?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;
    if let Some((seq,data))=tx.query_row("SELECT seq,data FROM map_operations WHERE id=?1",[&op.id],|row|Ok((row.get::<_,u64>(0)?,row.get::<_,String>(1)?))).optional().map_err(error)? {let mut old:Operation=serde_json::from_str(&data).map_err(error)?;old.seq=seq;if old.workspace_id!=op.workspace_id || old.session_id!=op.session_id || old.kind!=op.kind || old.payload!=op.payload || old.node_id!=op.node_id {return Err("重复标识对应的地图操作不一致".into());}return Ok(old);}
    let raw:String=tx.query_row("SELECT value FROM metadata WHERE key='workbench-shell-v2'",[],|r|r.get(0)).map_err(error)?;let mut snapshot:Value=serde_json::from_str(&raw).map_err(error)?;snapshot=merge(&tx,&snapshot)?;
    let space=snapshot["spaces"].as_array().and_then(|spaces|spaces.iter().find(|s|s["id"]==op.workspace_id)).ok_or("工作区不存在")?;
    if !space["nodes"].as_array().is_some_and(|nodes|nodes.iter().any(|n|n["id"]==op.node_id)) {return Err("目标节点不属于此会话工作区".into());}
    if op.kind=="artifact" && space["nodes"].as_array().unwrap().len()>=250 {return Err("地图节点数量已达上限".into());}
    tx.execute("INSERT INTO map_operations(id,data) VALUES(?1,?2)",rusqlite::params![op.id,serde_json::to_string(&op).map_err(error)?]).map_err(error)?;op.seq=tx.last_insert_rowid() as u64;apply(&mut snapshot,&op);snapshot["graphCursor"]=json!(op.seq);
    crate::workspace_state::validate(&snapshot)?;
    tx.execute("UPDATE metadata SET value=?1 WHERE key='workbench-shell-v2'",[serde_json::to_string(&snapshot).map_err(error)?]).map_err(error)?;tx.commit().map_err(error)?;Ok(op)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_ui_save_replays_operations_and_preserves_conflicting_user_content() {
        let root=std::env::temp_dir().join(format!("northstar-map-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root).unwrap();let shell=json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"n","body":"original","progress":20}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]});crate::workspace_state::save(&store,&shell).unwrap();
        let op=Operation{seq:0,id:"mutation".into(),workspace_id:"w".into(),node_id:"n".into(),session_id:"s".into(),run_id:"r".into(),kind:"update".into(),payload:json!({"expectedBody":"original","body":"AI content","text":"Updated"}),at:1};append(&store,op.clone()).unwrap();assert_eq!(append(&store,op.clone()).unwrap().seq,1);
        let mut newer=shell.clone();newer["spaces"][0]["nodes"][0]["body"]=json!("user edit");crate::workspace_state::save(&store,&newer).unwrap();let loaded=crate::workspace_state::load(&store).unwrap().unwrap();assert_eq!(loaded["spaces"][0]["nodes"][0]["body"],"user edit");assert!(loaded["spaces"][0]["nodes"][0]["updates"][0]["text"].as_str().unwrap().contains("AI content"));assert_eq!(loaded["spaces"][0]["nodes"][0]["progress"],20);
        let mut invalid=op;invalid.id="outside".into();invalid.node_id="outside".into();assert!(append(&store,invalid).is_err());
    }
}
