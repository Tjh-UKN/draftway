use crate::domain::{self, Settings};
use chrono::{DateTime, Datelike, Local};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::{Mutex,MutexGuard,atomic::{AtomicBool,AtomicU64,Ordering}}};

pub struct Store { pub db: Mutex<Connection>, pub root: PathBuf, pub maintenance:AtomicBool, pub restore_epoch:AtomicU64 }
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
pub struct Attachment { pub id:String, pub name:String, pub size:u64, pub stored_name:String, pub entity_id:Option<String>, pub created_at:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct WorkbenchData { pub records:Vec<Value>, pub attachments:Vec<Attachment>, pub settings:Settings, pub data_path:String, pub workspace_layout:Option<Value> }
pub type Result<T> = std::result::Result<T, String>;
pub fn error(e:impl std::fmt::Display)->String {e.to_string()}

impl Store {
    pub fn open(root:PathBuf)->Result<Self> {
        fs::create_dir_all(root.join("attachments")).map_err(error)?;
        fs::create_dir_all(root.join("backups")).map_err(error)?;
        let db=Connection::open(root.join("northstar.sqlite3")).map_err(error)?;
        let version:i64=db.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
        if version>5 {return Err("数据来自更新版本的 Draftway，请使用相应版本打开".into());}
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(error)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archive_root TEXT);
          CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind,archived);
          CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)));
          CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
          CREATE TABLE IF NOT EXISTS repeat_links(task_id TEXT PRIMARY KEY, next_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS reminders(token TEXT PRIMARY KEY, delivered_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(error)?;
        db.execute("INSERT OR IGNORE INTO settings(id,data) VALUES(1,?1)",[serde_json::to_string(&Settings::default()).map_err(error)?]).map_err(error)?;
        let store=Self{db:Mutex::new(db),root,maintenance:AtomicBool::new(false),restore_epoch:AtomicU64::new(0)};
        if (1..5).contains(&version){crate::backup::create(&store,"before-upgrade-v0.5")?;}
        {let mut connection=store.db.lock().map_err(error)?;migrate_connection(&mut connection)?;}
        Ok(store)
    }
    pub fn seed_if_new(&self)->Result<()> {
        let mut db=self.db.lock().map_err(error)?;let tx=db.transaction().map_err(error)?;
        let initialized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='initialized')",[],|r|r.get(0)).map_err(error)?;
        if initialized{return Ok(());}
        if records(&tx)?.is_empty(){
            let goal=uuid::Uuid::new_v4().to_string();let project=uuid::Uuid::new_v4().to_string();let now=domain::now();
            let mut entries=vec![
              json!({"kind":"goal","title":"让行动靠近长期方向","description":"从一项你真正关心的目标开始，建立每周复盘的习惯。","horizon":"year","targetDate":null,"id":goal}),
              json!({"kind":"project","title":"我的第一个项目","description":"你可以编辑这里的内容，或者新建自己的项目。","goalId":goal,"targetDate":null,"status":"active","id":project}),
              json!({"kind":"task","title":"写下今天最重要的一件事","description":"","projectId":project,"status":"todo","priority":"high","dueAt":null,"remindAt":null,"repeat":"none","completedAt":null,"tags":[],"id":uuid::Uuid::new_v4().to_string()}),
              json!({"kind":"task","title":"为第一个项目设置一个里程碑","description":"","projectId":project,"status":"todo","priority":"normal","dueAt":null,"remindAt":null,"repeat":"none","completedAt":null,"tags":[],"id":uuid::Uuid::new_v4().to_string()}),
              json!({"kind":"note","title":"欢迎来到 Draftway","projectId":project,"body":"从左侧导航开始，或者按 Ctrl + N 快速新建。\n\n你的目标、项目、任务、节点和笔记可以互相关联。按 Ctrl + K 搜索全部内容。\n\n数据保存在当前用户的 AppData 目录。备份同时包含数据库与附件。关闭窗口默认进入托盘；需要完全退出时，请使用托盘菜单。\n\n这些入门记录可以编辑或归档。","tags":["入门"],"id":uuid::Uuid::new_v4().to_string()})
            ];
            for r in &mut entries {r["createdAt"]=json!(now);r["updatedAt"]=json!(now);r["version"]=json!(1);r["archived"]=json!(false);domain::normalize(r);domain::validate(r)?;write(&tx,r,None)?;}
        }
        tx.execute("INSERT INTO metadata(key,value) VALUES('initialized','true')",[]).map_err(error)?;tx.commit().map_err(error)
    }
    pub fn write_db(&self)->Result<MutexGuard<'_,Connection>> {let db=self.db.lock().map_err(error)?;if self.maintenance.load(Ordering::SeqCst){return Err("正在恢复数据，请稍后重试".into());}Ok(db)}
    pub fn load(&self)->Result<WorkbenchData> {
        let db=self.db.lock().map_err(error)?;
        let layout:Option<String>=db.query_row("SELECT value FROM metadata WHERE key='workspace_layout'",[],|row|row.get(0)).optional().map_err(error)?;
        Ok(WorkbenchData{records:records(&db)?,attachments:attachments(&db)?,settings:settings(&db)?,data_path:self.root.to_string_lossy().into(),workspace_layout:layout.map(|layout|serde_json::from_str(&layout).map_err(error)).transpose()?})
    }
    pub fn put_workspace_layout(&self,layout:&Value)->Result<()> {
        crate::workspaces::validate(layout)?;
        let db=self.write_db()?;
        db.execute("INSERT INTO metadata(key,value) VALUES('workspace_layout',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(layout).map_err(error)?]).map_err(error)?;
        Ok(())
    }
    pub fn save(&self,mut record:Value)->Result<Value> {
        domain::normalize(&mut record);
        domain::validate(&record)?;
        let mut db=self.write_db()?;
        let tx=db.transaction().map_err(error)?;
        let id=domain::text(&record,"id").to_owned();
        let kind=domain::text(&record,"kind").to_owned();
        let incoming=record["version"].as_u64().unwrap();
        let previous=get(&tx,&id)?;
        if kind=="note" {if let Some(old)=previous.as_ref().filter(|old|old["knowledgeSource"].is_object()) {record["knowledgeSource"]=old["knowledgeSource"].clone();if old["title"]!=record["title"]||old["body"]!=record["body"]||old["format"]!=record["format"]{record["knowledgeSource"]["autoUpdate"]=json!(false);}}}
        if let Some(ref old)=previous {
            if old["version"].as_u64()!=Some(incoming) {return Err("这条记录已更新，请重新打开后再保存".into());}
            if domain::text(old,"kind")!=kind {return Err("不能改变已有记录的类型".into());}
            if old["archived"].as_bool()==Some(true) {return Err("请先恢复归档记录，再进行编辑".into());}
            record["createdAt"]=old["createdAt"].clone();
        } else if incoming!=0 {return Err("记录不存在".into());}
        if record["archived"].as_bool()==Some(true) {return Err("请使用归档操作".into());}
        if ["note","drawing"].contains(&kind.as_str()) {
            let mut parent=domain::optional_id(&record,"knowledgeParentId").map(String::from);let mut seen=std::collections::HashSet::from([id.clone()]);
            while let Some(parent_id)=parent {if parent_id.starts_with("source:"){break;}if !seen.insert(parent_id.clone()){return Err("不能把知识移到自己的下级".into());}let entry=get(&tx,&parent_id)?.ok_or("上级知识不存在")?;if !["note","drawing"].contains(&domain::text(&entry,"kind"))||entry["archived"]==true{return Err("上级知识不存在或已归档".into());}parent=domain::optional_id(&entry,"knowledgeParentId").map(String::from);}
        }
        if kind=="habit"{
            if let Some(ref old)=previous{if old["checkIns"]!=record["checkIns"]{return Err("请通过签到入口调整签到记录".into());}}
            else if record["checkIns"].as_object().is_some_and(|checks|!checks.is_empty()){return Err("创建习惯时不能直接写入签到记录".into());}
        }
        for (field,expected) in [("projectId","project"),("goalId","goal"),("taskId","task")] {
            if let Some(parent)=domain::optional_id(&record,field) {
                let p=get(&tx,parent)?.ok_or("关联的目标或项目不存在")?;
                if domain::text(&p,"kind")!=expected || p["archived"].as_bool()==Some(true) {return Err("不能关联已归档或类型不符的记录".into());}
                if field=="taskId"&&record["projectId"]!=p["projectId"]{return Err("问题或笔记必须属于关联任务的同一项目".into());}
            }
        }
        if kind=="journal"{
            for (field,expected) in [("taskIds","task"),("issueIds","issue")]{for id in record[field].as_array().ok_or("工作记录关联无效")?{let r=get(&tx,id.as_str().ok_or("关联 ID 无效")?)?.ok_or("工作记录引用的内容不存在")?;if domain::text(&r,"kind")!=expected{return Err("工作记录引用的类型不符".into());}}}
            let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities WHERE kind='journal' AND archived=0 AND json_extract(data,'$.date')=?1 AND id<>?2)",params![domain::text(&record,"date"),id],|r|r.get(0)).map_err(error)?;
            if duplicate{return Err("这一天已有工作记录，请编辑已有记录".into());}
        }
        if kind=="sleep"||kind=="weight"{
            let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities WHERE kind=?1 AND archived=0 AND json_extract(data,'$.date')=?2 AND id<>?3)",params![kind,domain::text(&record,"date"),id],|r|r.get(0)).map_err(error)?;
            if duplicate{return Err("该日期已有同类健康记录，请编辑已有记录".into());}
        }
        record["title"]=json!(domain::text(&record,"title").trim());
        record["updatedAt"]=json!(domain::now());
        record["version"]=json!(incoming+1);
        if kind=="task" {
            let done=domain::text(&record,"status")=="done";
            if done && record["completedAt"].is_null() {record["completedAt"]=json!(domain::now());}
            if !done {record["completedAt"]=Value::Null;}
        }
        if kind=="issue"{
            if domain::text(&record,"status")=="resolved"{if record["resolvedAt"].is_null(){record["resolvedAt"]=json!(domain::now());}}
            else{record["resolvedAt"]=Value::Null;}
        }
        write(&tx,&record,None)?;
        if kind=="task"&&previous.as_ref().is_some_and(|old|old["projectId"]!=record["projectId"]){
            for mut child in records(&tx)?.into_iter().filter(|r|domain::text(r,"taskId")==id){child["projectId"]=record["projectId"].clone();child["updatedAt"]=json!(domain::now());child["version"]=json!(child["version"].as_u64().unwrap_or(0)+1);tx.execute("UPDATE entities SET data=?1,version=?2 WHERE id=?3",params![serde_json::to_string(&child).map_err(error)?,child["version"].as_u64(),domain::text(&child,"id")]).map_err(error)?;}
        }
        if kind=="task" && domain::text(&record,"status")=="done" && domain::text(&record,"repeat")!="none" && previous.as_ref().is_none_or(|r|domain::text(r,"status")!="done") {
            let exists=tx.query_row("SELECT next_id FROM repeat_links WHERE task_id=?1",[&id],|r|r.get::<_,String>(0)).optional().map_err(error)?;
            if exists.is_none() {
                let mut next=record.clone();
                let new_id=uuid::Uuid::new_v4().to_string();
                let due=domain::text(&record,"dueAt");
                let repeat=domain::text(&record,"repeat");
                let anchor=record["repeatAnchorDay"].as_u64().map(|n|n as u32).unwrap_or(DateTime::parse_from_rfc3339(due).map_err(error)?.with_timezone(&Local).day());
                let next_due=domain::next_occurrence(due,repeat,anchor)?;
                next["id"]=json!(new_id);next["status"]=json!("todo");next["completedAt"]=Value::Null;
                next["createdAt"]=json!(domain::now());next["updatedAt"]=json!(domain::now());next["version"]=json!(1);
                next["dueAt"]=json!(next_due);next["repeatAnchorDay"]=json!(anchor);
                if let Some(remind)=record["remindAt"].as_str() {
                    let delta=DateTime::parse_from_rfc3339(due).map_err(error)?-DateTime::parse_from_rfc3339(remind).map_err(error)?;
                    let new_remind=DateTime::parse_from_rfc3339(domain::text(&next,"dueAt")).map_err(error)?-delta;
                    next["remindAt"]=json!(new_remind.to_rfc3339());
                }
                write(&tx,&next,None)?;
                tx.execute("INSERT INTO repeat_links(task_id,next_id) VALUES(?1,?2)",params![id,new_id]).map_err(error)?;
            }
        }
        tx.commit().map_err(error)?;
        Ok(record)
    }
    pub fn check_habit(&self,id:&str,day:&str,checked:bool)->Result<Value>{
        let date=chrono::NaiveDate::parse_from_str(day,"%Y-%m-%d").map_err(|_|"签到日期无效")?;
        if date.format("%Y-%m-%d").to_string()!=day||date>Local::now().date_naive(){return Err("不能对未来日期签到".into());}
        let mut db=self.write_db()?;let tx=db.transaction().map_err(error)?;let mut record=get(&tx,id)?.ok_or("习惯不存在")?;
        if domain::text(&record,"kind")!="habit"||record["archived"]==true{return Err("请先恢复或选择有效习惯".into());}
        if day<domain::text(&record,"startDate"){return Err("不能对习惯开始之前的日期签到".into());}
        let exists=record["checkIns"].as_object().ok_or("签到记录格式无效")?.contains_key(day);
        if exists==checked{return Ok(record);}
        if checked&&domain::text(&record,"status")!="active"{return Err("请先恢复进行中的习惯，再签到".into());}
        let checks=record["checkIns"].as_object_mut().ok_or("签到记录格式无效")?;
        if checked{checks.insert(day.to_owned(),json!(domain::now()));}else{checks.remove(day);}
        record["version"]=json!(record["version"].as_u64().unwrap_or(0)+1);record["updatedAt"]=json!(domain::now());domain::validate(&record)?;
        write(&tx,&record,None)?;tx.commit().map_err(error)?;Ok(record)
    }
    pub fn archive(&self,id:&str,restore:bool)->Result<()> {
        let mut db=self.write_db()?;
        let tx=db.transaction().map_err(error)?;
        let all=records(&tx)?;
        let target=all.iter().find(|r|domain::text(r,"id")==id).ok_or("记录不存在")?;
        let mut affected=vec![id.to_owned()];
        if !restore {
            let mut changed=true;
            while changed{changed=false;for r in &all{let child=domain::text(r,"id");if !affected.iter().any(|id|id==child)&&["goalId","projectId","taskId"].iter().any(|field|domain::optional_id(r,field).is_some_and(|parent|affected.iter().any(|id|id==parent))){affected.push(child.to_owned());changed=true;}}}
        } else {
            if ["sleep","weight"].contains(&domain::text(target,"kind")){let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities WHERE kind=?1 AND archived=0 AND json_extract(data,'$.date')=?2 AND id<>?3)",params![domain::text(target,"kind"),domain::text(target,"date"),id],|r|r.get(0)).map_err(error)?;if exists{return Err("该日期已有同类健康记录，不能重复恢复".into());}}
            for field in ["projectId","goalId","taskId"] {if let Some(parent)=domain::optional_id(target,field) {if get(&tx,parent)?.is_some_and(|r|r["archived"].as_bool()==Some(true)) {return Err("请先恢复所属的目标、项目或任务".into());}}}
            let mut stmt=tx.prepare("SELECT id FROM entities WHERE archive_root=?1").map_err(error)?;
            let ids=stmt.query_map([id],|r|r.get::<_,String>(0)).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
            affected.extend(ids);
        }
        for mut r in all.into_iter().filter(|r|affected.contains(&domain::text(r,"id").to_owned())) {
            if !restore && r["archived"].as_bool()==Some(true) {continue;}
            r["archived"]=json!(!restore);r["version"]=json!(r["version"].as_u64().unwrap_or(0)+1);r["updatedAt"]=json!(domain::now());
            write(&tx,&r,if restore {None} else {Some(id)})?;
        }
        tx.commit().map_err(error)
    }
    pub fn delete(&self,id:&str)->Result<()> {
        let mut db=self.write_db()?;
        let tx=db.transaction().map_err(error)?;
        let item=get(&tx,id)?.ok_or("记录不存在")?;
        if item["archived"].as_bool()!=Some(true) {return Err("只有归档记录可以永久删除".into());}
        if records(&tx)?.iter().any(|r|domain::text(r,"projectId")==id||domain::text(r,"goalId")==id||domain::text(r,"taskId")==id||["taskIds","issueIds"].iter().any(|field|r[*field].as_array().is_some_and(|ids|ids.iter().any(|value|value.as_str()==Some(id))))) {return Err("请先解除相关工作记录的引用或删除子记录，也可以保留归档".into());}
        if attachments(&tx)?.iter().any(|a|a.entity_id.as_deref()==Some(id)) {return Err("请先移除该记录的附件".into());}
        tx.execute("DELETE FROM entities WHERE id=?1",[id]).map_err(error)?;
        tx.execute("DELETE FROM repeat_links WHERE task_id=?1 OR next_id=?1",[id]).map_err(error)?;
        tx.commit().map_err(error)
    }
    pub fn put_settings(&self,s:&Settings)->Result<()> {
        if s.user_name.chars().count()>30 || !["dark","light"].contains(&s.theme.as_str()) || !["overview","focus"].contains(&s.layout.as_str()) {return Err("设置值无效".into());}
        let db=self.write_db()?;
        db.execute("UPDATE settings SET data=?1 WHERE id=1",[serde_json::to_string(s).map_err(error)?]).map_err(error)?;Ok(())
    }
}
pub fn migrate_connection(db:&mut Connection)->Result<()> {
    let version:i64=db.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
    if version>5{return Err("数据版本不受支持".into());}
    if version<5{
        let tx=db.transaction().map_err(error)?;
        for mut r in records(&tx)?{domain::normalize(&mut r);tx.execute("UPDATE entities SET data=?1 WHERE id=?2",params![serde_json::to_string(&r).map_err(error)?,domain::text(&r,"id")]).map_err(error)?;}
        tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS journal_date ON entities(json_extract(data,'$.date')) WHERE kind='journal' AND archived=0; CREATE UNIQUE INDEX IF NOT EXISTS health_date ON entities(kind,json_extract(data,'$.date')) WHERE kind IN ('sleep','weight') AND archived=0; PRAGMA user_version=5;").map_err(error)?;
        tx.commit().map_err(error)?;
    }
    Ok(())
}
pub fn records(db:&Connection)->Result<Vec<Value>> {
    let mut stmt=db.prepare("SELECT data FROM entities ORDER BY rowid").map_err(error)?;
    let rows=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
    rows.iter().map(|s|serde_json::from_str(s).map_err(error)).collect()
}
pub fn get(db:&Connection,id:&str)->Result<Option<Value>> {
    db.query_row("SELECT data FROM entities WHERE id=?1",[id],|r|r.get::<_,String>(0)).optional().map_err(error)?.map(|s|serde_json::from_str(&s).map_err(error)).transpose()
}
pub fn write(db:&Connection,r:&Value,archive_root:Option<&str>)->Result<()> {
    db.execute("INSERT INTO entities(id,kind,data,version,archived,archive_root) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,archived=excluded.archived,archive_root=excluded.archive_root",
      params![domain::text(r,"id"),domain::text(r,"kind"),serde_json::to_string(r).map_err(error)?,r["version"].as_u64().unwrap_or(0),r["archived"].as_bool().unwrap_or(false),archive_root]).map_err(error)?;Ok(())
}
pub fn settings(db:&Connection)->Result<Settings> {let data:String=db.query_row("SELECT data FROM settings WHERE id=1",[],|r|r.get(0)).map_err(error)?;serde_json::from_str(&data).map_err(error)}
pub fn attachments(db:&Connection)->Result<Vec<Attachment>> {
    let mut stmt=db.prepare("SELECT data FROM attachments ORDER BY rowid DESC").map_err(error)?;
    let rows=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
    rows.iter().map(|s|serde_json::from_str(s).map_err(error)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn workspace_layout_survives_restart_and_backup_without_changing_business_records() {
        let root=std::env::temp_dir().join(format!("northstar-layout-{}",uuid::Uuid::new_v4()));
        let store=Store::open(root.clone()).unwrap();
        let task=store.save(record("task")).unwrap();
        assert!(store.load().unwrap().workspace_layout.is_none());
        let id=uuid::Uuid::new_v4().to_string();
        let layout=json!({"version":1,"activeId":id,"workspaces":[{"id":id,"name":"我的布局","zoom":80,"widgets":[]}],"templates":[]});
        store.put_workspace_layout(&layout).unwrap();
        let mut invalid=layout.clone();invalid["version"]=json!(2);
        assert!(store.put_workspace_layout(&invalid).is_err());
        assert_eq!(store.load().unwrap().workspace_layout,Some(layout.clone()));
        let backup=crate::backup::create(&store,"layout-test").unwrap();
        let mut changed=layout.clone();changed["workspaces"][0]["name"]=json!("新布局");
        store.put_workspace_layout(&changed).unwrap();
        assert_eq!(store.load().unwrap().records,vec![task.clone()]);
        crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();
        drop(store);
        let store=Store::open(root.clone()).unwrap();
        assert_eq!(store.load().unwrap().workspace_layout,Some(layout));
        assert_eq!(store.load().unwrap().records,vec![task]);
        assert_eq!(store.load().unwrap().settings.user_name,Settings::default().user_name);
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    fn record(kind:&str)->Value {json!({"id":uuid::Uuid::new_v4().to_string(),"kind":kind,"title":"test","createdAt":domain::now(),"updatedAt":domain::now(),"version":0,"archived":false,"description":"","status":"todo","priority":"normal","repeat":"none","projectId":null,"dueAt":null,"remindAt":null,"completedAt":null,"tags":[]})}
    #[test] fn conflicts_and_repeat_are_atomic() {
        let root=std::env::temp_dir().join(format!("northstar-test-{}",uuid::Uuid::new_v4()));
        let store=Store::open(root.clone()).unwrap();
        let mut t=record("task");t["repeat"]=json!("monthly");t["dueAt"]=json!("2026-01-31T09:00:00+08:00");
        let stale=store.save(t).unwrap();let mut done=stale.clone();done["status"]=json!("done");
        let completed=store.save(done).unwrap();assert_eq!(store.load().unwrap().records.len(),2);
        assert!(store.save(stale).is_err());
        let mut reopen=completed;reopen["status"]=json!("todo");let reopened=store.save(reopen).unwrap();
        let mut again=reopened;again["status"]=json!("done");store.save(again).unwrap();assert_eq!(store.load().unwrap().records.len(),2);
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn knowledge_formats_hierarchy_survive_backup_and_reject_cycles() {
        let root=std::env::temp_dir().join(format!("northstar-knowledge-graph-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let mut folder=record("note");folder["body"]=json!("");folder["format"]=json!("folder");let folder=store.save(folder).unwrap();
        let mut html=record("note");html["body"]=json!("<!doctype html><h1>HTML 原文</h1>");html["format"]=json!("html");html["knowledgeParentId"]=folder["id"].clone();let html=store.save(html).unwrap();
        let mut map=record("note");map["format"]=json!("mindmap");map["knowledgeParentId"]=html["id"].clone();map["body"]=json!(serde_json::to_string(&json!([{"id":"center","parentId":null,"kind":"root","title":"中心","side":1,"body":"保留正文","progress":0,"due":""}])).unwrap());let map=store.save(map).unwrap();
        let mut cyclic=folder.clone();cyclic["knowledgeParentId"]=map["id"].clone();assert!(store.save(cyclic).unwrap_err().contains("下级"));
        let backup=crate::backup::create(&store,"knowledge-graph").unwrap();let mut changed=html.clone();changed["body"]=json!("changed");store.save(changed).unwrap();crate::backup::restore(&store,&store.root.join("backups").join(backup.name)).unwrap();drop(store);
        let restored=Store::open(root.clone()).unwrap().load().unwrap();assert!(restored.records.contains(&html));assert!(restored.records.contains(&map));assert!(restored.records.contains(&folder));std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn drawings_survive_upgrade_restart_backup_and_archive() {
        let root=std::env::temp_dir().join(format!("northstar-drawings-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let old=store.save(record("task")).unwrap();store.db.lock().unwrap().execute_batch("PRAGMA user_version=4;").unwrap();drop(store);
        let store=Store::open(root.clone()).unwrap();assert_eq!(store.load().unwrap().records[0],old);assert!(crate::backup::list(&store).unwrap().iter().any(|b|b.name.contains("before-upgrade-v0.5")));
        let mut p=record("project");p["status"]=json!("active");let p=store.save(p).unwrap();
        let mut drawing=record("drawing");drawing["projectId"]=p["id"].clone();drawing["scene"]=json!(serde_json::to_string(&json!({"type":"excalidraw","version":2,"elements":[{"id":"text1","type":"text","text":"图纸 · 中文文字"}],"appState":{"viewBackgroundColor":"#ffffff"},"files":{"image1":{"id":"image1","mimeType":"image/png","dataURL":"data:image/png;base64,aGVsbG8="}}})).unwrap());
        let drawing=store.save(drawing).unwrap();let mut bad=drawing.clone();bad["scene"]=json!("{}");assert!(store.save(bad).is_err());
        let backup=crate::backup::create(&store,"drawing-test").unwrap();store.archive(domain::text(&p,"id"),false).unwrap();assert!(store.load().unwrap().records.iter().find(|r|r["id"]==drawing["id"]).unwrap()["archived"]==true);
        crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();drop(store);
        let store=Store::open(root.clone()).unwrap();assert_eq!(store.load().unwrap().records.iter().find(|r|r["id"]==drawing["id"]).unwrap(),&drawing);drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn archive_preserves_individually_archived_children() {
        let root=std::env::temp_dir().join(format!("northstar-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let mut p=record("project");p["status"]=json!("active");p["goalId"]=Value::Null;let p=store.save(p).unwrap();
        let mut t=record("task");t["projectId"]=p["id"].clone();let t=store.save(t).unwrap();
        store.archive(domain::text(&t,"id"),false).unwrap();store.archive(domain::text(&p,"id"),false).unwrap();store.archive(domain::text(&p,"id"),true).unwrap();
        assert!(store.load().unwrap().records.iter().find(|r|r["id"]==t["id"]).unwrap()["archived"].as_bool().unwrap());
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn issue_workflow_move_and_journal_uniqueness_preserve_relationships(){
        let root=std::env::temp_dir().join(format!("northstar-workflow-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let mut p=record("project");p["status"]=json!("active");let p=store.save(p).unwrap();let p2=store.save({let mut p=record("project");p["status"]=json!("active");p}).unwrap();
        let mut t=record("task");t["projectId"]=p["id"].clone();let t=store.save(t).unwrap();
        let mut issue=record("issue");issue["projectId"]=p["id"].clone();issue["taskId"]=t["id"].clone();issue["status"]=json!("triage");issue["severity"]=json!("high");for field in ["phenomenon","expected","reproduction","attempts","cause","solution"]{issue[field]=json!("");}issue["phenomenon"]=json!("小窗口遮挡");issue["resolvedAt"]=Value::Null;
        let issue=store.save(issue).unwrap();let mut resolved=issue.clone();resolved["status"]=json!("resolved");assert!(store.save(resolved.clone()).is_err());resolved["solution"]=json!("调整最小宽度，并验证布局");let resolved=store.save(resolved).unwrap();assert!(resolved["resolvedAt"].is_string());
        let mut note=record("note");note["body"]=json!("完成了布局测试");note["taskId"]=t["id"].clone();note["projectId"]=p["id"].clone();note["noteType"]=json!("progress");let note=store.save(note).unwrap();
        let mut moved=t.clone();moved["projectId"]=p2["id"].clone();let moved=store.save(moved).unwrap();let loaded=store.load().unwrap();for child in [&issue,&note]{assert_eq!(loaded.records.iter().find(|r|r["id"]==child["id"]).unwrap()["projectId"],p2["id"]);}
        let mut journal=record("journal");journal["date"]=json!("2026-10-03");journal["body"]=json!("当时保存的汇总");for field in ["discoveries","blockers","nextSteps"]{journal[field]=json!("");}journal["taskIds"]=json!([t["id"]]);journal["issueIds"]=json!([issue["id"]]);let journal=store.save(journal).unwrap();let mut duplicate=journal.clone();duplicate["id"]=json!(uuid::Uuid::new_v4().to_string());duplicate["version"]=json!(0);assert!(store.save(duplicate).is_err());
        store.archive(domain::text(&moved,"id"),false).unwrap();let loaded=store.load().unwrap();assert!(loaded.records.iter().find(|r|r["id"]==issue["id"]).unwrap()["archived"]==true);assert!(loaded.records.iter().find(|r|r["id"]==journal["id"]).unwrap()["archived"]==false);
        store.archive(domain::text(&moved,"id"),true).unwrap();assert_eq!(store.load().unwrap().records.iter().find(|r|r["id"]==journal["id"]).unwrap()["body"],"当时保存的汇总");
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn legacy_upgrade_and_legacy_backup_restore_keep_user_notes(){
        let root=std::env::temp_dir().join(format!("northstar-upgrade-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let mut note=record("note");note["body"]=json!("原来的记录不能丢失");let note=store.save(note).unwrap();store.archive(domain::text(&note,"id"),false).unwrap();
        let mut legacy=store.load().unwrap().records[0].clone();let original_version=legacy["version"].clone();let original_time=legacy["updatedAt"].clone();for field in ["taskId","noteType","occurredOn"]{legacy.as_object_mut().unwrap().remove(field);}
        {let db=store.db.lock().unwrap();db.execute("UPDATE entities SET data=?1 WHERE id=?2",params![serde_json::to_string(&legacy).unwrap(),domain::text(&legacy,"id")]).unwrap();db.execute_batch("DROP INDEX journal_date; PRAGMA user_version=1;").unwrap();}
        drop(store);let store=Store::open(root.clone()).unwrap();let upgraded=store.load().unwrap().records[0].clone();assert_eq!(upgraded["id"],legacy["id"]);assert_eq!(upgraded["body"],legacy["body"]);assert_eq!(upgraded["version"],original_version);assert_eq!(upgraded["updatedAt"],original_time);assert_eq!(upgraded["noteType"],"note");assert_eq!(upgraded["archived"],true);
        let backup=crate::backup::list(&store).unwrap().into_iter().find(|b|b.name.contains("before-upgrade-v0.5")).unwrap();crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();assert_eq!(store.load().unwrap().records[0]["body"],legacy["body"]);assert_eq!(store.db.lock().unwrap().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),5);
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn habit_checkins_are_idempotent_guarded_and_backed_up(){
        let root=std::env::temp_dir().join(format!("northstar-habits-{}",uuid::Uuid::new_v4()));let store=std::sync::Arc::new(Store::open(root.clone()).unwrap());
        let today=Local::now().date_naive();let day=today.format("%Y-%m-%d").to_string();let yesterday=(today-chrono::Days::new(1)).format("%Y-%m-%d").to_string();let start=(today-chrono::Days::new(7)).format("%Y-%m-%d").to_string();
        let mut h=record("habit");h["status"]=json!("active");h["startDate"]=json!(start);h["checkIns"]=json!({});let h=store.save(h).unwrap();let id=domain::text(&h,"id").to_owned();
        let a={let store=store.clone();let id=id.clone();let day=day.clone();std::thread::spawn(move||store.check_habit(&id,&day,true).unwrap())};let b={let store=store.clone();let id=id.clone();let day=day.clone();std::thread::spawn(move||store.check_habit(&id,&day,true).unwrap())};a.join().unwrap();b.join().unwrap();
        let checked=store.load().unwrap().records[0].clone();assert_eq!(checked["checkIns"].as_object().unwrap().len(),1);assert_eq!(checked["version"],2);let repeat=store.check_habit(&id,&day,true).unwrap();assert_eq!(repeat["version"],checked["version"]);
        assert!(store.check_habit(&id,&(today+chrono::Days::new(1)).to_string(),true).is_err());assert!(store.check_habit(&id,&(today-chrono::Days::new(8)).to_string(),true).is_err());assert!(store.save(h.clone()).is_err());
        let filled=store.check_habit(&id,&yesterday,true).unwrap();let backup=crate::backup::create(&store,"test").unwrap();store.check_habit(&id,&day,false).unwrap();crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();assert_eq!(store.load().unwrap().records[0]["checkIns"],filled["checkIns"]);
        let mut paused=store.load().unwrap().records[0].clone();paused["status"]=json!("paused");let paused=store.save(paused).unwrap();assert!(store.check_habit(&id,&(today-chrono::Days::new(2)).to_string(),true).is_err());store.check_habit(&id,&day,false).unwrap();
        let mut edited=store.load().unwrap().records[0].clone();edited["checkIns"][&day]=json!(domain::now());assert!(store.save(edited).is_err());store.archive(&id,false).unwrap();assert!(store.check_habit(&id,&yesterday,false).is_err());store.archive(&id,true).unwrap();assert_eq!(store.load().unwrap().records[0]["status"],paused["status"]);
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn schema_two_upgrade_preserves_habitless_workspace(){
        let root=std::env::temp_dir().join(format!("northstar-schema-two-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();let old=store.save(record("task")).unwrap();store.db.lock().unwrap().execute_batch("PRAGMA user_version=2;").unwrap();drop(store);
        let store=Store::open(root.clone()).unwrap();assert_eq!(store.load().unwrap().records[0],old);let backup=crate::backup::list(&store).unwrap().into_iter().find(|b|b.name.contains("before-upgrade-v0.5")).unwrap();crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();assert_eq!(store.load().unwrap().records[0],old);assert_eq!(store.db.lock().unwrap().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),5);drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn health_records_validate_dates_values_duplicates_and_restore(){
        use chrono::TimeZone;
        let root=std::env::temp_dir().join(format!("northstar-health-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();let date=Local::now().date_naive();let day=date.to_string();let wake=Local.from_local_datetime(&date.and_hms_opt(8,0,0).unwrap()).single().unwrap();let bed=wake-chrono::Duration::hours(8);
        let mut sleep=record("sleep");sleep["date"]=json!(day);sleep["bedtime"]=json!(bed.to_rfc3339());sleep["wakeTime"]=json!(wake.to_rfc3339());sleep["awakeMinutes"]=json!(30);sleep["quality"]=json!("normal");sleep["note"]=json!("跨日睡眠测试");let saved=store.save(sleep.clone()).unwrap();
        let mut duplicate=sleep.clone();duplicate["id"]=json!(uuid::Uuid::new_v4().to_string());assert!(store.save(duplicate.clone()).is_err());let mut invalid=saved.clone();invalid["wakeTime"]=saved["bedtime"].clone();assert!(store.save(invalid).is_err());let mut invalid=saved.clone();invalid["awakeMinutes"]=json!(480);assert!(store.save(invalid).is_err());
        let mut weight=record("weight");weight["date"]=json!(day);weight["kilograms"]=json!(68.55);weight["note"]=json!("晨起称重");let weight=store.save(weight).unwrap();let mut invalid=weight.clone();invalid["kilograms"]=json!(-1);assert!(store.save(invalid).is_err());let mut invalid=weight.clone();invalid["date"]=json!((date+chrono::Days::new(1)).to_string());assert!(store.save(invalid).is_err());
        let backup=crate::backup::create(&store,"test").unwrap();let mut changed=weight.clone();changed["kilograms"]=json!(69);store.save(changed).unwrap();crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();assert_eq!(store.load().unwrap().records.iter().find(|r|r["id"]==weight["id"]).unwrap()["kilograms"],68.55);
        store.archive(domain::text(&saved,"id"),false).unwrap();let new=store.save(duplicate).unwrap();assert!(store.archive(domain::text(&saved,"id"),true).is_err());store.archive(domain::text(&new,"id"),false).unwrap();store.archive(domain::text(&saved,"id"),true).unwrap();assert_eq!(store.load().unwrap().records.iter().find(|r|r["id"]==saved["id"]).unwrap()["note"],"跨日睡眠测试");drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn schema_three_upgrade_preserves_old_records_and_old_backups(){
        let root=std::env::temp_dir().join(format!("northstar-schema-three-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();let old=store.save(record("task")).unwrap();store.db.lock().unwrap().execute_batch("DROP INDEX health_date; PRAGMA user_version=3;").unwrap();drop(store);
        let store=Store::open(root.clone()).unwrap();assert_eq!(store.load().unwrap().records[0],old);let backup=crate::backup::list(&store).unwrap().into_iter().find(|b|b.name.contains("before-upgrade-v0.5")).unwrap();crate::backup::restore(&store,&crate::backup::resolve_backup(&store,&backup.name).unwrap()).unwrap();assert_eq!(store.load().unwrap().records[0],old);assert_eq!(store.db.lock().unwrap().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),5);drop(store);fs::remove_dir_all(root).unwrap();
    }
}
