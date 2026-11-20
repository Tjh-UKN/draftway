use crate::{domain, store::{self, Store, Result, error}};
use chrono::Local;
use rusqlite::{Connection, DatabaseName, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use std::{fs::{self, File}, io::{Read, Write}, path::{Path, PathBuf}};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct BackupInfo {pub name:String,pub created_at:String,pub size:u64}
fn cleanup(root:&Path,path:&Path){if let (Ok(root),Ok(target))=(root.canonicalize(),path.canonicalize()){if target!=root&&target.starts_with(root){let _=fs::remove_dir_all(path);}}}
#[cfg(test)]thread_local!{static FAIL_RESTORE_AFTER_AGENTS:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}
pub fn list(store:&Store)->Result<Vec<BackupInfo>> {
    let mut entries=vec![];
    for entry in fs::read_dir(store.root.join("backups")).map_err(error)? {
        let e=entry.map_err(error)?;let path=e.path();if path.extension().and_then(|s|s.to_str())!=Some("zip") {continue;}
        let meta=e.metadata().map_err(error)?;
        let time:chrono::DateTime<chrono::Utc>=meta.modified().map_err(error)?.into();
        entries.push(BackupInfo{name:e.file_name().to_string_lossy().into(),created_at:time.to_rfc3339(),size:meta.len()});
    }
    entries.sort_by(|a,b|b.created_at.cmp(&a.created_at));Ok(entries)
}
pub fn create(store:&Store,label:&str)->Result<BackupInfo> {
    if label.is_empty()||label.len()>48||!label.bytes().all(|b|b.is_ascii_alphanumeric()||[b'-',b'_',b'.'].contains(&b)){return Err("备份类别无效".into());}
    let db=store.db.lock().map_err(error)?;
    let epoch=store.restore_epoch.load(std::sync::atomic::Ordering::SeqCst);
    let schema_version:i64=db.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
    let name=format!("northstar-{}-{}-{}.zip",Local::now().format("%Y%m%d-%H%M%S"),label,&uuid::Uuid::new_v4().to_string()[..8]);
    let temp=store.root.join("backups").join(format!("stage-{}",uuid::Uuid::new_v4()));fs::create_dir_all(temp.join("attachments")).map_err(error)?;
    let target=store.root.join("backups").join(&name);let pending=store.root.join("backups").join(format!("{name}.partial"));
    let result=(||->Result<()> {
        db.backup(DatabaseName::Main,temp.join("northstar.sqlite3"),None).map_err(error)?;
        let snapshot=Connection::open(temp.join("northstar.sqlite3")).map_err(error)?;snapshot.execute_batch("PRAGMA journal_mode=DELETE;").map_err(error)?;
        let mut missing=vec![];
        for mut attachment in store::attachments(&db)? {
            let path=attachment_path(store,&attachment.stored_name)?;
            if !path.is_file() {if !label.starts_with("before-"){return Err(format!("附件 {} 丢失，备份已中止；可以从已有备份恢复",attachment.name));}snapshot.execute("DELETE FROM attachments WHERE id=?1",[&attachment.id]).map_err(error)?;missing.push(attachment);continue;}
            if !crate::agent_backup::safe_path(Path::new(&attachment.stored_name)){return Err("附件路径无效".into());}
            if fs::metadata(&path).map_err(error)?.len()>512_000_000{return Err("附件超过备份容量限制".into());}
            attachment.size=fs::copy(&path,temp.join("attachments").join(&attachment.stored_name)).map_err(error)?;
            snapshot.execute("UPDATE attachments SET data=?1 WHERE id=?2",rusqlite::params![serde_json::to_string(&attachment).map_err(error)?,attachment.id]).map_err(error)?;
        }
        crate::agent_backup::save_current_database(&store.root,&temp.join("agent-sessions.sqlite3"))?;
        drop(db);
        let mut zip=ZipWriter::new(File::create(&pending).map_err(error)?);let options=SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for attachment in store::attachments(&snapshot)? {zip.start_file(format!("attachments/{}",attachment.stored_name),options).map_err(error)?;std::io::copy(&mut File::open(temp.join("attachments").join(attachment.stored_name)).map_err(error)?,&mut zip).map_err(error)?;}
        drop(snapshot);
        let agent_bundle=crate::agent_backup::write_bundle(store,&temp,&mut zip,options)?;
        zip.start_file("northstar.sqlite3",options).map_err(error)?;std::io::copy(&mut File::open(temp.join("northstar.sqlite3")).map_err(error)?,&mut zip).map_err(error)?;
        zip.start_file("manifest.json",options).map_err(error)?;zip.write_all(serde_json::to_string(&json!({"format":"northstar","version":schema_version.max(1),"createdAt":domain::now(),"missingAttachments":missing,"agentBundle":agent_bundle,"sourceDataRoot":crate::resources::display_path(&store.root)})).map_err(error)?.as_bytes()).map_err(error)?;let archive=zip.finish().map_err(error)?;archive.sync_all().map_err(error)?;drop(archive);
        let mut check=ZipArchive::new(File::open(&pending).map_err(error)?).map_err(error)?;if check.len()>10000{return Err("备份文件数量超过恢复限制".into());}let mut total=0u64;let mut paths=std::collections::HashSet::new();for i in 0..check.len(){let file=check.by_index(i).map_err(error)?;if !paths.insert(file.name().replace('\\',"/").to_ascii_lowercase()){return Err("备份文件在 Windows 路径下重名，请单独备份该项目。".into());}total=total.checked_add(file.size()).ok_or("备份大小无效")?;if file.size()>512_000_000||total>2_000_000_000{return Err("备份内容超过恢复容量，请把大型项目单独备份。".into());}}drop(check);if store.restore_epoch.load(std::sync::atomic::Ordering::SeqCst)!=epoch{return Err("备份期间发生数据恢复，本次备份已中止，请重新创建。".into());}fs::rename(&pending,&target).map_err(error)?;Ok(())
    })();
    cleanup(&store.root,&temp);if let Err(e)=result{let _=fs::remove_file(&pending);return Err(e);}let meta=fs::metadata(target).map_err(error)?;Ok(BackupInfo{name,created_at:domain::now(),size:meta.len()})
}
pub fn attachment_path(store:&Store,name:&str)->Result<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) || !crate::agent_backup::safe_path(Path::new(name)) {return Err("附件路径无效".into());}
    Ok(store.root.join("attachments").join(name))
}
pub fn resolve_backup(store:&Store,name:&str)->Result<PathBuf> {
    if name.contains(['/', '\\']) || !crate::agent_backup::safe_path(Path::new(name)) || !name.ends_with(".zip") {return Err("备份名称无效".into());}
    Ok(store.root.join("backups").join(name))
}
fn restore_marker(store:&Store)->PathBuf{store.root.join("restore-in-progress.json")}
fn mark_restore(store:&Store,name:&str)->Result<()> {let temporary=store.root.join(format!("restore-marker-{}.tmp",uuid::Uuid::new_v4()));let mut file=File::create(&temporary).map_err(error)?;file.write_all(serde_json::to_string(&json!({"version":1,"backup":name})).map_err(error)?.as_bytes()).map_err(error)?;file.sync_all().map_err(error)?;drop(file);fs::rename(temporary,restore_marker(store)).map_err(error)}
pub fn recover_interrupted(store:&Store)->Result<bool>{let marker=restore_marker(store);if !marker.is_file(){return Ok(false);}let value:serde_json::Value=serde_json::from_slice(&fs::read(marker).map_err(error)?).map_err(error)?;if value["version"]!=1{return Err("恢复保护记录版本不兼容，请保留数据目录中的备份。".into());}let backup=resolve_backup(store,value["backup"].as_str().ok_or("恢复保护记录无效，请保留数据目录中的备份")?)?;store.maintenance.store(true,std::sync::atomic::Ordering::SeqCst);restore_inner(store,&backup,true)?;store.maintenance.store(false,std::sync::atomic::Ordering::SeqCst);Ok(true)}
pub fn restore(store:&Store,source:&Path)->Result<()> {if restore_marker(store).exists(){return Err("上次恢复尚未结束，请重新打开 Draftway 完成保护恢复。".into());}restore_inner(store,source,false)}
fn restore_inner(store:&Store,source:&Path,recovering:bool)->Result<()> {
    let stage=store.root.join(format!("restore-{}",uuid::Uuid::new_v4()));
    fs::create_dir_all(stage.join("attachments")).map_err(error)?;
    fs::create_dir_all(stage.join("agents/provider-sessions")).map_err(error)?;fs::create_dir_all(stage.join("agents/workspaces")).map_err(error)?;
    let result=(||->Result<()> {
        let mut zip=ZipArchive::new(File::open(source).map_err(error)?).map_err(error)?;
        if zip.len()>10000 {return Err("备份包含过多文件".into());}
        let mut total=0u64;
        let mut names=std::collections::HashSet::new();
        for i in 0..zip.len() {
            let mut file=zip.by_index(i).map_err(error)?;
            total=total.checked_add(file.size()).ok_or("备份大小无效")?;
            if total>2_000_000_000 || file.size()>512_000_000 {return Err("备份超过恢复容量限制".into());}
            let enclosed=file.enclosed_name().ok_or("备份包含不安全的路径")?.to_owned();
            let name=enclosed.to_string_lossy().replace('\\',"/");
            if !crate::agent_backup::safe_path(&enclosed)||!names.insert(name.to_ascii_lowercase())||file.unix_mode().is_some_and(|mode|mode&0o170000==0o120000){return Err("备份包含不安全或重复路径".into());}
            let valid=name=="manifest.json" || name=="northstar.sqlite3" || name=="agents/agent-sessions.sqlite3" || (name.starts_with("attachments/") && enclosed.components().count()==2) || (name.starts_with("agents/provider-sessions/")&&enclosed.components().count()==3&&enclosed.extension().is_some_and(|e|e=="jsonl")) || (name.starts_with("agents/workspaces/")&&enclosed.components().count()>=3);
            let valid=valid&&!file.is_dir();
            if !valid {return Err("备份包含不支持的文件".into());}
            let target=stage.join(enclosed);fs::create_dir_all(target.parent().ok_or("备份路径无效")?).map_err(error)?;std::io::copy(&mut file,&mut File::create(target).map_err(error)?).map_err(error)?;
        }
        let mut manifest=String::new();File::open(stage.join("manifest.json")).map_err(error)?.read_to_string(&mut manifest).map_err(error)?;
        let manifest:serde_json::Value=serde_json::from_str(&manifest).map_err(error)?;
        if manifest["format"]!="northstar" || ![1,2,3,4,5].contains(&manifest["version"].as_i64().unwrap_or(0)) {return Err("备份格式或版本不受支持".into());}
        let agent_bundle=crate::agent_backup::validate_bundle(&stage,&manifest,&store.root)?;
        let mut check=Connection::open(stage.join("northstar.sqlite3")).map_err(error)?;
        let integrity:String=check.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(error)?;
        let version:i64=check.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
        if integrity!="ok" || ![1,2,3,4,5].contains(&version) {return Err("备份数据库无效".into());}
        store::migrate_connection(&mut check)?;
        let all=store::records(&check)?;
        for item in &all {domain::validate(item)?;for (field,kind) in [("projectId","project"),("goalId","goal"),("taskId","task")] {if let Some(id)=domain::optional_id(item,field){if !all.iter().any(|r|domain::text(r,"id")==id&&domain::text(r,"kind")==kind){return Err("备份记录关联不完整".into());}}}
          for (field,kind) in [("taskIds","task"),("issueIds","issue")]{if let Some(ids)=item[field].as_array(){for id in ids{if !all.iter().any(|r|r["id"]==*id&&domain::text(r,"kind")==kind){return Err("备份工作记录的关联不完整".into());}}}}
        }
        store::settings(&check)?;
        check.execute_batch("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(error)?;
        let shell:Option<String>=check.query_row("SELECT value FROM metadata WHERE key='workbench-shell-v2'",[],|row|row.get(0)).optional().map_err(error)?;
        if let Some(ref shell)=shell {let mut value=serde_json::from_str(shell).map_err(error)?;crate::workspace_state::validate(&value)?;crate::agent_backup::remap_shell(&mut value,&manifest,&store.root);check.execute("UPDATE metadata SET value=?1 WHERE key='workbench-shell-v2'",[serde_json::to_string(&value).map_err(error)?]).map_err(error)?;}
        for a in store::attachments(&check)? {
            attachment_path(store,&a.stored_name)?;
            let p=stage.join("attachments").join(&a.stored_name);
            if !p.is_file() || fs::metadata(p).map_err(error)?.len()!=a.size {return Err("备份附件不完整".into());}
        }
        if shell.is_none()&&!agent_bundle {let current=store.db.lock().map_err(error)?;for key in ["workbench-shell-v2","background-runtime-v1"]{let value:Option<String>=current.query_row("SELECT value FROM metadata WHERE key=?1",[key],|r|r.get(0)).optional().map_err(error)?;if let Some(value)=value{check.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES(?1,?2)",rusqlite::params![key,value]).map_err(error)?;}}
            let operations=crate::map_ops::changes(&current,0)?;if !operations.is_empty(){check.execute_batch("CREATE TABLE IF NOT EXISTS map_operations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));").map_err(error)?;for op in operations{check.execute("INSERT OR REPLACE INTO map_operations(seq,id,data) VALUES(?1,?2,?3)",rusqlite::params![op.seq,op.id,serde_json::to_string(&op).map_err(error)?]).map_err(error)?;}}}
        drop(check);
        let protection=if recovering{BackupInfo{name:source.file_name().ok_or("保护备份路径无效")?.to_string_lossy().into(),created_at:String::new(),size:0}}else{create(store,"before-restore")?};
        let mut db=store.db.lock().map_err(error)?;db.backup(DatabaseName::Main,stage.join("main-before.sqlite3"),None).map_err(error)?;
        let previous_agents=if agent_bundle{crate::agent_backup::save_current_database(&store.root,&stage.join("agents-before.sqlite3"))?}else{false};
        if !recovering{mark_restore(store,&protection.name)?;}store.restore_epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        let mut swapped:Vec<(PathBuf,PathBuf,PathBuf,bool)>=Vec::new();
        let restore=(||->Result<()>{let paths=if agent_bundle{vec!["attachments","agents/provider-sessions","agents/workspaces"]}else{vec!["attachments"]};
            for relative in paths{let target=store.root.join(relative);let previous=store.root.join(format!("tree-before-restore-{}",uuid::Uuid::new_v4()));let incoming=stage.join(relative);let existed=target.exists();fs::create_dir_all(target.parent().ok_or("恢复目录无效")?).map_err(error)?;if existed{fs::rename(&target,&previous).map_err(error)?;}if let Err(error)=fs::rename(&incoming,&target){if existed{let _=fs::rename(&previous,&target);}return Err(error.to_string());}swapped.push((target,previous,incoming,existed));}
            if agent_bundle{crate::agent_backup::restore_database(&store.root,&stage.join("agents/agent-sessions.sqlite3"))?;crate::agent_backup::finish_owned_dirs(&store.root)?;}
            #[cfg(test)]if FAIL_RESTORE_AFTER_AGENTS.with(|flag|flag.replace(false)){return Err("注入恢复失败".into());}
            db.restore(DatabaseName::Main,stage.join("northstar.sqlite3"),None::<fn(rusqlite::backup::Progress)>).map_err(error)?;Ok(())})();
        if let Err(cause)=restore{let mut failures=Vec::new();if let Err(e)=db.restore(DatabaseName::Main,stage.join("main-before.sqlite3"),None::<fn(rusqlite::backup::Progress)>){failures.push(e.to_string());}
            if agent_bundle{if previous_agents{if let Err(e)=crate::agent_backup::restore_database(&store.root,&stage.join("agents-before.sqlite3")){failures.push(e);}}else{for name in ["agent-sessions.sqlite3","agent-sessions.sqlite3-wal","agent-sessions.sqlite3-shm"]{let path=store.root.join("agents").join(name);if path.exists(){if let Err(e)=fs::remove_file(path){failures.push(e.to_string());}}}}}
            for (target,previous,incoming,existed)in swapped.iter().rev(){if let Err(e)=fs::rename(target,incoming){failures.push(e.to_string());}if *existed{if let Err(e)=fs::rename(previous,target){failures.push(e.to_string());}}}
            if !failures.is_empty(){return Err(format!("[recovery-required] 恢复未完成且自动回滚失败，已保留保护备份 {}：{}",protection.name,failures.join("；")));}if !recovering{fs::remove_file(restore_marker(store)).map_err(|e|format!("[recovery-required] 原数据已回滚，但恢复标记未能清理：{e}"))?;}return Err(format!("恢复失败，原数据已恢复：{cause}"));}
        fs::remove_file(restore_marker(store)).map_err(|e|format!("[recovery-required] 数据已写入，恢复标记未能清理，请重新启动完成保护恢复：{e}"))?;
        for (_,previous,_,existed)in swapped{if existed{cleanup(&store.root,&previous);}}Ok(())
    })();
    if !result.as_ref().is_err_and(|e|e.contains("[recovery-required]")){cleanup(&store.root,&stage);}result
}

#[cfg(test)]
mod tests {
 use super::*;
 fn fixture(tag:&str)->Store {
    let root=std::env::temp_dir().join(format!("northstar-full-backup-{tag}-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();let cwd=root.join("agents/workspaces/w");fs::create_dir_all(cwd.join("node_modules/cache")).unwrap();fs::create_dir_all(root.join("agents/provider-sessions")).unwrap();fs::write(cwd.join("note.md"),tag).unwrap();fs::write(cwd.join("node_modules/cache/ignored"),"cache").unwrap();fs::write(root.join("agents/provider-sessions/session.jsonl"),format!("{{\"fixture\":\"{tag}\"}}\n{{\"partial\":" )).unwrap();
    let db=Connection::open(root.join("agents/agent-sessions.sqlite3")).unwrap();db.execute_batch("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);").unwrap();let session=json!({"id":"s","workspaceId":"w","nodeId":"n","backend":"pi","title":tag,"cwd":cwd,"sourceId":root.join("agents/provider-sessions/session.jsonl"),"createdAt":0,"revision":1,"messages":[],"runs":[],"requests":[],"error":null});db.execute("INSERT INTO agent_sessions VALUES('s',?1)",[session.to_string()]).unwrap();drop(db);
    crate::workspace_state::save(&store,&json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":tag,"cwd":cwd,"materialRoots":[{"name":"Notes","path":cwd}],"nodes":[{"id":"n","body":"Original","progress":20,"materials":[{"id":"m","title":"Note","target":cwd.join("note.md")}]}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]})).unwrap();let mut settings=domain::Settings::default();settings.user_name=tag.into();store.put_settings(&settings).unwrap();store
 }
 #[test]fn complete_backup_restores_agents_owned_files_and_paths_in_a_new_directory(){
    let source=fixture("source");let b=create(&source,"test").unwrap();let destination=Store::open(std::env::temp_dir().join(format!("northstar-full-destination-{}",uuid::Uuid::new_v4()))).unwrap();restore(&destination,&resolve_backup(&source,&b.name).unwrap()).unwrap();
    let cwd=destination.root.join("agents/workspaces/w");assert_eq!(fs::read_to_string(cwd.join("note.md")).unwrap(),"source");assert!(!cwd.join("node_modules").exists());assert_eq!(fs::read_to_string(destination.root.join("agents/provider-sessions/session.jsonl")).unwrap(),"{\"fixture\":\"source\"}\n");
    let db=Connection::open(destination.root.join("agents/agent-sessions.sqlite3")).unwrap();let raw:String=db.query_row("SELECT data FROM agent_sessions WHERE id='s'",[],|r|r.get(0)).unwrap();let session:crate::native_agents::AgentSession=serde_json::from_str(&raw).unwrap();assert_eq!(PathBuf::from(session.cwd),cwd);assert!(session.source_id.unwrap().contains(destination.root.file_name().unwrap().to_str().unwrap()));let shell=crate::workspace_state::load(&destination).unwrap().unwrap();assert_eq!(PathBuf::from(shell["spaces"][0]["materialRoots"][0]["path"].as_str().unwrap()),cwd);
 }
 #[test]fn old_backups_preserve_new_workspace_components_they_cannot_represent(){
    let source=Store::open(std::env::temp_dir().join(format!("northstar-old-backup-{}",uuid::Uuid::new_v4()))).unwrap();let b=create(&source,"old").unwrap();let destination=fixture("current");let before=crate::workspace_state::load(&destination).unwrap();restore(&destination,&resolve_backup(&source,&b.name).unwrap()).unwrap();assert_eq!(crate::workspace_state::load(&destination).unwrap(),before);assert!(destination.root.join("agents/provider-sessions/session.jsonl").is_file());assert_eq!(destination.load().unwrap().settings.user_name,"同学");
 }
 #[test]fn failed_restore_rolls_back_both_databases_and_owned_file_trees(){
    let source=fixture("source");let b=create(&source,"test").unwrap();let destination=fixture("current");FAIL_RESTORE_AFTER_AGENTS.with(|flag|flag.set(true));let failure=restore(&destination,&resolve_backup(&source,&b.name).unwrap()).unwrap_err();assert!(failure.contains("原数据已恢复"));assert_eq!(destination.load().unwrap().settings.user_name,"current");assert_eq!(fs::read_to_string(destination.root.join("agents/workspaces/w/note.md")).unwrap(),"current");let db=Connection::open(destination.root.join("agents/agent-sessions.sqlite3")).unwrap();let raw:String=db.query_row("SELECT data FROM agent_sessions WHERE id='s'",[],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<serde_json::Value>(&raw).unwrap()["title"],"current");assert!(list(&destination).unwrap().iter().any(|b|b.name.contains("before-restore")));
 }
 #[test]fn unfinished_restore_is_recovered_from_the_original_protection_backup(){let store=fixture("current");let b=create(&store,"before-restore").unwrap();mark_restore(&store,&b.name).unwrap();let mut settings=store.load().unwrap().settings;settings.user_name="interrupted".into();store.put_settings(&settings).unwrap();assert!(recover_interrupted(&store).unwrap());assert_eq!(store.load().unwrap().settings.user_name,"current");assert!(!restore_marker(&store).exists());assert!(!store.maintenance.load(std::sync::atomic::Ordering::SeqCst));}
 #[test]fn executable_provider_extensions_and_duplicate_paths_are_rejected(){
    let store=fixture("protected");let source=store.root.join("unsafe.zip");let mut zip=ZipWriter::new(File::create(&source).unwrap());zip.start_file("agents/provider-sessions/unsafe.ts",SimpleFileOptions::default()).unwrap();zip.write_all(b"malicious extension").unwrap();zip.finish().unwrap();assert!(restore(&store,&source).unwrap_err().contains("不支持的文件"));assert_eq!(store.load().unwrap().settings.user_name,"protected");assert!(!store.root.join("agents/provider-sessions/unsafe.ts").exists());assert!(resolve_backup(&store,"C:escape.zip").is_err());let duplicate=store.root.join("duplicate.zip");let mut zip=ZipWriter::new(File::create(&duplicate).unwrap());for name in ["agents/workspaces/w/file.txt","agents/workspaces/w/FILE.txt"]{zip.start_file(name,SimpleFileOptions::default()).unwrap();zip.write_all(b"fixture").unwrap();}zip.finish().unwrap();assert!(restore(&store,&duplicate).unwrap_err().contains("重复路径"));
 }
 #[test] fn backup_roundtrip_restores_database_and_attachment() {
    let root=std::env::temp_dir().join(format!("northstar-backup-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
    let id=uuid::Uuid::new_v4().to_string();let attachment=store::Attachment{id:id.clone(),name:"test.txt".into(),size:5,stored_name:format!("{id}.txt"),entity_id:None,created_at:domain::now()};
    fs::write(attachment_path(&store,&attachment.stored_name).unwrap(),b"hello").unwrap();
    store.db.lock().unwrap().execute("INSERT INTO attachments(id,data) VALUES(?1,?2)",rusqlite::params![id,serde_json::to_string(&attachment).unwrap()]).unwrap();
    let mut settings=domain::Settings::default();settings.user_name="备份时的名称".into();store.put_settings(&settings).unwrap();
    let b=create(&store,"test").unwrap();fs::write(attachment_path(&store,&attachment.stored_name).unwrap(),b"changed").unwrap();
    settings.user_name="备份后的名称".into();store.put_settings(&settings).unwrap();
    restore(&store,&resolve_backup(&store,&b.name).unwrap()).unwrap();assert_eq!(fs::read(attachment_path(&store,&attachment.stored_name).unwrap()).unwrap(),b"hello");
    assert_eq!(store.load().unwrap().settings.user_name,"备份时的名称");
    let protection=list(&store).unwrap().into_iter().find(|b|b.name.contains("before-restore")).unwrap();
    restore(&store,&resolve_backup(&store,&protection.name).unwrap()).unwrap();
    assert_eq!(fs::read(attachment_path(&store,&attachment.stored_name).unwrap()).unwrap(),b"changed");
    assert_eq!(store.load().unwrap().attachments[0].size,7);
    fs::remove_file(attachment_path(&store,&attachment.stored_name).unwrap()).unwrap();
    restore(&store,&resolve_backup(&store,&b.name).unwrap()).unwrap();
    assert_eq!(fs::read(attachment_path(&store,&attachment.stored_name).unwrap()).unwrap(),b"hello");
    assert!(attachment_path(&store,"../escape.txt").is_err());drop(store);fs::remove_dir_all(root).unwrap();
 }
 #[test] fn unsafe_backup_is_rejected_before_changing_data() {
    let root=std::env::temp_dir().join(format!("northstar-unsafe-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
    let source=root.join("malformed.zip");let mut zip=ZipWriter::new(File::create(&source).unwrap());zip.start_file("../escape.txt",SimpleFileOptions::default()).unwrap();zip.write_all(b"invalid").unwrap();zip.finish().unwrap();
    assert!(restore(&store,&source).is_err());assert_eq!(store.load().unwrap().settings.user_name,"同学");assert!(!root.join("escape.txt").exists());
    drop(store);fs::remove_dir_all(root).unwrap();
 }
}
