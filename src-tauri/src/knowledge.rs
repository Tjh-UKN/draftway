use crate::{domain,store::{Store,Result,error}};
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::HashMap;

fn candidates(snapshot:&Value)->Vec<Value> {
    let mut result=Vec::new();
    for space in snapshot["spaces"].as_array().into_iter().flatten() {
        let source=|kind:&str,id:&str,category:&str|json!({"kind":kind,"id":id,"category":category,"workspaceId":space["id"],"workspaceName":space["name"]});
        for node in space["nodes"].as_array().into_iter().flatten() {
            let kind=domain::text(node,"kind");let body=domain::text(node,"body");
            if !body.trim().is_empty()&&(kind=="artifact"||kind=="document"||!domain::text(node,"sourceArtifactId").is_empty()) {result.push(json!({"title":node["title"],"body":body,"source":source("node",domain::text(node,"id"),if kind=="document"{"document"}else{"artifact"})}));}
        }
        let notes=space["surfaces"].as_array().into_iter().flatten().filter(|surface|surface["integrationId"]=="note"&&!domain::text(surface,"text").trim().is_empty()).collect::<Vec<_>>();
        for note in &notes {let title=domain::text(note,"title");result.push(json!({"title":if title.is_empty(){format!("{} · 随记",domain::text(space,"name"))}else{title.into()},"body":note["text"],"source":source("note",domain::text(note,"id"),"note")}));}
        let body=domain::text(space,"notes");
        if !body.trim().is_empty()&&!notes.iter().any(|note|domain::text(note,"text")==body) {result.push(json!({"title":format!("{} · 随记",domain::text(space,"name")),"body":body,"source":source("note","workspace-notes","note")}));}
    }
    result
}
fn source_key(source:&Value)->String {format!("personal-knowledge-source:{}",json!([source["workspaceId"],source["kind"],source["id"]]))}
pub fn collect(store:&Store)->Result<usize> {
    let mut db=store.write_db()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;
    let raw:Option<String>=tx.query_row("SELECT value FROM metadata WHERE key='workbench-shell-v2'",[],|row|row.get(0)).optional().map_err(error)?;
    let Some(raw)=raw else{return Ok(0)};let snapshot:Value=serde_json::from_str(&raw).map_err(error)?;crate::workspace_state::validate(&snapshot)?;
    let mut existing=HashMap::new();
    {let mut query=tx.prepare("SELECT data,archived FROM entities WHERE kind='note'").map_err(error)?;
    for row in query.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,bool>(1)?))).map_err(error)? {let (raw,archived)=row.map_err(error)?;let mut note:Value=serde_json::from_str(&raw).map_err(error)?;note["archived"]=json!(archived);if note["knowledgeSource"].is_object(){existing.insert(source_key(&note["knowledgeSource"]),note);}}}
    let mut count=0;
    for candidate in candidates(&snapshot) {
        let key=source_key(&candidate["source"]);
        if let Some(note)=existing.get_mut(&key) {
            tx.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES(?1,?2)",params![key,domain::text(note,"id")]).map_err(error)?;
            if note["archived"]==true||note["knowledgeSource"]["autoUpdate"]==false||(note["knowledgeSource"]["autoUpdate"].is_null()&&note["version"].as_u64().unwrap_or(0)>1) {continue;}
            let title=domain::text(&candidate,"title").trim().chars().take(120).collect::<String>();let title=if title.is_empty(){"未命名知识".into()}else{title};
            if note["title"]==title&&note["body"]==candidate["body"]&&note["knowledgeSource"]["workspaceName"]==candidate["source"]["workspaceName"] {continue;}
            note["title"]=json!(title);note["body"]=candidate["body"].clone();note["knowledgeSource"]=candidate["source"].clone();note["knowledgeSource"]["autoUpdate"]=json!(true);note["updatedAt"]=json!(domain::now());note["version"]=json!(note["version"].as_u64().unwrap_or(0)+1);domain::validate(note)?;
            tx.execute("UPDATE entities SET data=?1,version=?2 WHERE id=?3",params![serde_json::to_string(note).map_err(error)?,note["version"].as_u64().unwrap(),domain::text(note,"id")]).map_err(error)?;count+=1;continue;
        }
        let collected:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key=?1)",[&key],|row|row.get(0)).map_err(error)?;
        if collected {continue;}
        let id=uuid::Uuid::new_v4().to_string();let now=domain::now();
        let title=domain::text(&candidate,"title").trim().chars().take(120).collect::<String>();
        let mut note=json!({"id":id,"kind":"note","title":if title.is_empty(){"未命名知识"}else{&title},"body":candidate["body"],"projectId":null,"taskId":null,"noteType":"note","occurredOn":chrono::Local::now().format("%Y-%m-%d").to_string(),"tags":[],"createdAt":now,"updatedAt":now,"version":1,"archived":false,"knowledgeSource":candidate["source"]});note["knowledgeSource"]["autoUpdate"]=json!(true);
        domain::validate(&note)?;
        tx.execute("INSERT INTO entities(id,kind,data,version,archived) VALUES(?1,'note',?2,1,0)",params![id,serde_json::to_string(&note).map_err(error)?]).map_err(error)?;
        tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2)",params![key,id]).map_err(error)?;existing.insert(key,note);count+=1;
    }
    tx.commit().map_err(error)?;Ok(count)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup()->Store {
        let store=Store::open(std::env::temp_dir().join(format!("northstar-knowledge-{}",uuid::Uuid::new_v4()))).unwrap();
        crate::workspace_state::save(&store,&json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"idea","kind":"idea","body":"Do not collect this"},{"id":"a","kind":"artifact","title":"Saved result","body":"Original artifact"},{"id":"d","kind":"document","title":"Document","body":"Original document"}],"notes":"Workspace note","surfaces":[{"id":"n","integrationId":"note","text":"Workspace note","title":"Note"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]})).unwrap();
        store
    }
    #[test]
    fn imports_once_preserves_edits_and_does_not_resurrect_archived_or_deleted_notes(){
        let store=setup();assert_eq!(collect(&store).unwrap(),3);assert_eq!(collect(&store).unwrap(),0);
        let records=store.load().unwrap().records;assert_eq!(records.len(),3);assert!(records.iter().all(|note|note["knowledgeSource"]["workspaceId"]=="w"));
        let mut note=records.iter().find(|note|note["title"]=="Saved result").unwrap().clone();note["body"]=json!("My edited knowledge");let edited=store.save(note).unwrap();
        assert_eq!(collect(&store).unwrap(),0);assert_eq!(store.load().unwrap().records.iter().find(|note|note["id"]==edited["id"]).unwrap()["body"],"My edited knowledge");
        let id=domain::text(&edited,"id");store.db.lock().unwrap().execute("UPDATE entities SET archived=1 WHERE id=?1",[id]).unwrap();assert_eq!(collect(&store).unwrap(),0);
        store.db.lock().unwrap().execute("DELETE FROM entities WHERE id=?1",[id]).unwrap();assert_eq!(collect(&store).unwrap(),0);
    }
    #[test]
    fn collected_notes_survive_workspace_removal_and_store_restart(){
        let store=setup();collect(&store).unwrap();let root=store.root.clone();
        let mut snapshot=crate::workspace_state::load(&store).unwrap().unwrap();snapshot["spaces"][0]["nodes"]=json!([{"id":"replacement"}]);snapshot["spaces"][0]["notes"]=json!("");snapshot["spaces"][0]["surfaces"]=json!([]);
        crate::workspace_state::save(&store,&snapshot).unwrap();drop(store);
        let restored=Store::open(root).unwrap();assert_eq!(restored.load().unwrap().records.len(),3);assert_eq!(collect(&restored).unwrap(),0);
    }
    #[test]
    fn source_edits_refresh_automatic_notes_until_the_person_curates_them(){
        let store=setup();collect(&store).unwrap();let mut snapshot=crate::workspace_state::load(&store).unwrap().unwrap();
        snapshot["spaces"][0]["nodes"][1]["body"]=json!("Finished artifact");crate::workspace_state::save(&store,&snapshot).unwrap();assert_eq!(collect(&store).unwrap(),1);
        let mut note=store.load().unwrap().records.into_iter().find(|note|note["title"]=="Saved result").unwrap();assert_eq!(note["body"],"Finished artifact");assert_eq!(note["version"],2);
        snapshot["spaces"][0]["nodes"][1]["body"]=json!("Updated again");crate::workspace_state::save(&store,&snapshot).unwrap();assert_eq!(collect(&store).unwrap(),1);
        note=store.load().unwrap().records.into_iter().find(|note|note["title"]=="Saved result").unwrap();note["body"]=json!("My curation");store.save(note).unwrap();
        snapshot["spaces"][0]["nodes"][1]["body"]=json!("New source edit");crate::workspace_state::save(&store,&snapshot).unwrap();assert_eq!(collect(&store).unwrap(),0);
        assert_eq!(store.load().unwrap().records.iter().find(|note|note["title"]=="Saved result").unwrap()["body"],"My curation");
    }
    #[test]
    fn failed_collection_rolls_back_without_changing_the_workspace(){
        let store=setup();let mut snapshot=crate::workspace_state::load(&store).unwrap().unwrap();snapshot["spaces"][0]["nodes"][2]["body"]=json!("x".repeat(1_000_001));
        crate::workspace_state::save(&store,&snapshot).unwrap();assert!(collect(&store).is_err());assert!(store.load().unwrap().records.is_empty());assert_eq!(crate::workspace_state::load(&store).unwrap().unwrap(),snapshot);
    }
}
