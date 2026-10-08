use crate::{domain, store::{self, Store, Result, error}};
use chrono::Local;
use rusqlite::{Connection, DatabaseName};
use serde::Serialize;
use serde_json::json;
use std::{fs::{self, File}, io::{Read, Write}, path::{Path, PathBuf}};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct BackupInfo {pub name:String,pub created_at:String,pub size:u64}
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
    let db=store.db.lock().map_err(error)?;
    let schema_version:i64=db.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
    let name=format!("northstar-{}-{}-{}.zip",Local::now().format("%Y%m%d-%H%M%S"),label,&uuid::Uuid::new_v4().to_string()[..8]);
    let temp=store.root.join("backups").join(format!("stage-{}",uuid::Uuid::new_v4()));
    fs::create_dir(&temp).map_err(error)?;
    let target=store.root.join("backups").join(&name);
    let result=(||->Result<()> {
        db.backup(DatabaseName::Main,temp.join("northstar.sqlite3"),None).map_err(error)?;
        let snapshot=Connection::open(temp.join("northstar.sqlite3")).map_err(error)?;
        snapshot.execute_batch("PRAGMA journal_mode=DELETE;").map_err(error)?;
        let mut zip=ZipWriter::new(File::create(&target).map_err(error)?);
        let options=SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut missing=vec![];
        for mut attachment in store::attachments(&db)? {
            let path=attachment_path(store,&attachment.stored_name)?;
            if !path.is_file() {
                if !label.starts_with("before-") {return Err(format!("附件 {} 丢失，备份已中止；可以从已有备份恢复",attachment.name));}
                snapshot.execute("DELETE FROM attachments WHERE id=?1",[&attachment.id]).map_err(error)?;
                missing.push(attachment);continue;
            }
            zip.start_file(format!("attachments/{}",attachment.stored_name),options).map_err(error)?;
            attachment.size=std::io::copy(&mut File::open(path).map_err(error)?,&mut zip).map_err(error)?;
            snapshot.execute("UPDATE attachments SET data=?1 WHERE id=?2",rusqlite::params![serde_json::to_string(&attachment).map_err(error)?,attachment.id]).map_err(error)?;
        }
        drop(snapshot);
        zip.start_file("northstar.sqlite3",options).map_err(error)?;
        std::io::copy(&mut File::open(temp.join("northstar.sqlite3")).map_err(error)?,&mut zip).map_err(error)?;
        zip.start_file("manifest.json",options).map_err(error)?;
        zip.write_all(serde_json::to_string(&json!({"format":"northstar","version":schema_version.max(1),"createdAt":domain::now(),"missingAttachments":missing})).map_err(error)?.as_bytes()).map_err(error)?;
        zip.finish().map_err(error)?;Ok(())
    })();
    let _=fs::remove_dir_all(&temp);
    if let Err(e)=result {let _=fs::remove_file(&target);return Err(e);}
    let meta=fs::metadata(target).map_err(error)?;
    Ok(BackupInfo{name,created_at:domain::now(),size:meta.len()})
}
pub fn attachment_path(store:&Store,name:&str)->Result<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) || name=="." || name==".." {return Err("附件路径无效".into());}
    Ok(store.root.join("attachments").join(name))
}
pub fn resolve_backup(store:&Store,name:&str)->Result<PathBuf> {
    if name.contains(['/', '\\']) || !name.ends_with(".zip") {return Err("备份名称无效".into());}
    Ok(store.root.join("backups").join(name))
}
pub fn restore(store:&Store,source:&Path)->Result<()> {
    let stage=store.root.join(format!("restore-{}",uuid::Uuid::new_v4()));
    fs::create_dir_all(stage.join("attachments")).map_err(error)?;
    let result=(||->Result<()> {
        let mut zip=ZipArchive::new(File::open(source).map_err(error)?).map_err(error)?;
        if zip.len()>10000 {return Err("备份包含过多文件".into());}
        let mut total=0u64;
        for i in 0..zip.len() {
            let mut file=zip.by_index(i).map_err(error)?;
            total=total.checked_add(file.size()).ok_or("备份大小无效")?;
            if total>2_000_000_000 || file.size()>512_000_000 {return Err("备份超过恢复容量限制".into());}
            let enclosed=file.enclosed_name().ok_or("备份包含不安全的路径")?.to_owned();
            let name=enclosed.to_string_lossy().replace('\\',"/");
            let valid=name=="manifest.json" || name=="northstar.sqlite3" || (name.starts_with("attachments/") && enclosed.components().count()==2 && !file.is_dir());
            if !valid {return Err("备份包含不支持的文件".into());}
            let target=stage.join(enclosed);std::io::copy(&mut file,&mut File::create(target).map_err(error)?).map_err(error)?;
        }
        let mut manifest=String::new();File::open(stage.join("manifest.json")).map_err(error)?.read_to_string(&mut manifest).map_err(error)?;
        let manifest:serde_json::Value=serde_json::from_str(&manifest).map_err(error)?;
        if manifest["format"]!="northstar" || ![1,2,3,4].contains(&manifest["version"].as_i64().unwrap_or(0)) {return Err("备份格式或版本不受支持".into());}
        let mut check=Connection::open(stage.join("northstar.sqlite3")).map_err(error)?;
        let integrity:String=check.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(error)?;
        let version:i64=check.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(error)?;
        if integrity!="ok" || ![1,2,3,4].contains(&version) {return Err("备份数据库无效".into());}
        store::migrate_connection(&mut check)?;
        let all=store::records(&check)?;
        for item in &all {domain::validate(item)?;for (field,kind) in [("projectId","project"),("goalId","goal"),("taskId","task")] {if let Some(id)=domain::optional_id(item,field){if !all.iter().any(|r|domain::text(r,"id")==id&&domain::text(r,"kind")==kind){return Err("备份记录关联不完整".into());}}}
          for (field,kind) in [("taskIds","task"),("issueIds","issue")]{if let Some(ids)=item[field].as_array(){for id in ids{if !all.iter().any(|r|r["id"]==*id&&domain::text(r,"kind")==kind){return Err("备份工作记录的关联不完整".into());}}}}
        }
        store::settings(&check)?;
        for a in store::attachments(&check)? {
            attachment_path(store,&a.stored_name)?;
            let p=stage.join("attachments").join(&a.stored_name);
            if !p.is_file() || fs::metadata(p).map_err(error)?.len()!=a.size {return Err("备份附件不完整".into());}
        }
        drop(check);
        create(store,"before-restore")?;
        let mut db=store.db.lock().map_err(error)?;
        let old=store.root.join(format!("attachments-before-restore-{}",uuid::Uuid::new_v4()));
        fs::rename(store.root.join("attachments"),&old).map_err(error)?;
        if let Err(e)=fs::rename(stage.join("attachments"),store.root.join("attachments")) {let _=fs::rename(&old,store.root.join("attachments"));return Err(error(e));}
        if let Err(e)=db.restore(DatabaseName::Main,stage.join("northstar.sqlite3"),None::<fn(rusqlite::backup::Progress)>) {
            let _=fs::rename(store.root.join("attachments"),stage.join("attachments"));let _=fs::rename(&old,store.root.join("attachments"));return Err(error(e));
        }
        let _=fs::remove_dir_all(old);Ok(())
    })();
    let _=fs::remove_dir_all(stage);result
}

#[cfg(test)]
mod tests {
 use super::*;
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
