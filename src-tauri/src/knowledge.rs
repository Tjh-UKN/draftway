use crate::{domain,store::{Store,Result,error}};
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::HashMap;

#[derive(Default)]
pub struct HtmlPreviews(std::sync::Mutex<std::collections::VecDeque<(String,String)>>);
impl HtmlPreviews {
    pub fn create(&self,body:String)->Result<String>{
        if body.len()>1_000_000{return Err("HTML 超过 1 MB".into());}
        let token=uuid::Uuid::new_v4().to_string();let mut entries=self.0.lock().map_err(error)?;
        entries.push_back((token.clone(),body));while entries.len()>16{entries.pop_front();}Ok(token)
    }
    pub fn remove(&self,token:&str){if let Ok(mut entries)=self.0.lock(){entries.retain(|(id,_)|id!=token);}}
    pub fn response(&self,token:&str)->tauri::http::Response<Vec<u8>> {
        let body=self.0.lock().ok().and_then(|entries|entries.iter().find(|(id,_)|id==token).map(|(_,body)|body.clone()));
        let status=if body.is_some(){200}else{404};
        tauri::http::Response::builder().status(status).header("Content-Type","text/html; charset=utf-8").header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff")
            .header("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts")
            .body(body.unwrap_or_else(||"HTML 预览已关闭".into()).into_bytes()).unwrap()
    }
}

pub fn validate_map(body:&str)->Result<()> {
    let value:Value=serde_json::from_str(body).map_err(|_|"思维导图 JSON 无效")?;
    let nodes=value.as_array().or_else(||value["nodes"].as_array()).ok_or("思维导图需要节点数组")?;
    if nodes.is_empty()||nodes.len()>250{return Err("思维导图需要 1–250 个节点".into());}
    let mut ids=std::collections::HashSet::new();let mut roots=0;
    for node in nodes {
        if node.get("parentId").is_none(){return Err("思维导图上级字段缺失".into());}
        let id=node["id"].as_str().ok_or("思维导图节点 ID 无效")?;
        if id.is_empty()||!ids.insert(id){return Err("思维导图节点重复".into());}
        if domain::text(node,"title").trim().is_empty()||domain::text(node,"title").chars().count()>120||!node["body"].is_string()||!node["due"].is_string()||![-1,1].contains(&node["side"].as_i64().unwrap_or(0))||node["progress"].as_f64().is_none_or(|v|!(0.0..=100.0).contains(&v))||!["root","idea","analysis","event","document","code","artifact"].contains(&domain::text(node,"kind")){return Err("思维导图节点内容无效".into());}
        if node["parentId"].is_null(){roots+=1;if node["kind"]!="root"{return Err("中心主题类型无效".into());}}else if !node["parentId"].is_string()||node["kind"]=="root"{return Err("思维导图层级无效".into());}
    }
    if roots!=1{return Err("思维导图需要一个中心主题".into());}
    for node in nodes {let mut seen=std::collections::HashSet::from([domain::text(node,"id")]);let mut parent=node["parentId"].as_str();while let Some(id)=parent {if !seen.insert(id){return Err("思维导图包含循环".into());}let entry=nodes.iter().find(|n|n["id"]==id).ok_or("思维导图上级不存在")?;parent=entry["parentId"].as_str();}}
    Ok(())
}

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
    fn html_preview_is_ephemeral_bounded_and_has_no_host_or_network_access(){
        let previews=HtmlPreviews::default();let first=previews.create("<button onclick=\"this.textContent=1\">0</button>".into()).unwrap();let response=previews.response(&first);assert_eq!(response.status(),200);let policy=response.headers()["Content-Security-Policy"].to_str().unwrap();assert!(policy.contains("sandbox allow-scripts"));assert!(policy.contains("connect-src 'none'"));assert!(policy.contains("frame-src 'none'"));assert_eq!(response.headers()["Cache-Control"],"no-store");
        for _ in 0..16{previews.create("next".into()).unwrap();}assert_eq!(previews.response(&first).status(),404);let token=previews.create("last".into()).unwrap();previews.remove(&token);assert_eq!(previews.response(&token).status(),404);assert!(previews.create("x".repeat(1_000_001)).is_err());
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
    fn moving_collected_knowledge_does_not_disable_source_updates(){
        let store=setup();collect(&store).unwrap();let mut note=store.load().unwrap().records.into_iter().find(|r|r["title"]=="Saved result").unwrap();note["knowledgeParentId"]=json!("source:other");let saved=store.save(note).unwrap();assert_eq!(saved["knowledgeSource"]["autoUpdate"],true);
        let mut snapshot=crate::workspace_state::load(&store).unwrap().unwrap();snapshot["spaces"][0]["nodes"][1]["body"]=json!("Updated after move");crate::workspace_state::save(&store,&snapshot).unwrap();assert_eq!(collect(&store).unwrap(),1);let entry=store.load().unwrap().records.into_iter().find(|r|r["title"]=="Saved result").unwrap();assert_eq!(entry["body"],"Updated after move");assert_eq!(entry["knowledgeParentId"],"source:other");
    }
    #[test]
    fn failed_collection_rolls_back_without_changing_the_workspace(){
        let store=setup();let mut snapshot=crate::workspace_state::load(&store).unwrap().unwrap();snapshot["spaces"][0]["nodes"][2]["body"]=json!("x".repeat(1_000_001));
        crate::workspace_state::save(&store,&snapshot).unwrap();assert!(collect(&store).is_err());assert!(store.load().unwrap().records.is_empty());assert_eq!(crate::workspace_state::load(&store).unwrap().unwrap(),snapshot);
    }
}
