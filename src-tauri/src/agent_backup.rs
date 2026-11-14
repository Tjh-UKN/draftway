use crate::{native_agents::AgentSession,resources,store::{Store,Result,error}};
use rusqlite::{Connection,DatabaseName,OpenFlags};
use serde_json::Value;
use std::{fs::{self,File},io::{Read,Write},path::{Path,PathBuf}};
use zip::{ZipWriter,write::SimpleFileOptions};
fn snapshot(source:&Path,target:&Path)->Result<()> {let db=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;db.busy_timeout(std::time::Duration::from_secs(5)).map_err(error)?;db.backup(DatabaseName::Main,target,None).map_err(error)?;Connection::open(target).map_err(error)?.execute_batch("PRAGMA journal_mode=DELETE;").map_err(error)?;Ok(())}
pub fn safe_path(path:&Path)->bool {path.components().all(|part|{let std::path::Component::Normal(part)=part else{return false;};let value=part.to_string_lossy();let stem=value.split('.').next().unwrap_or("").to_ascii_uppercase();!value.is_empty()&&!value.ends_with(['.',' '])&&!value.chars().any(|c|c<' '||"<>:\"|?*".contains(c))&&!matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL")&&!(stem.len()==4&&(stem.starts_with("COM")||stem.starts_with("LPT"))&&stem.ends_with(['1','2','3','4','5','6','7','8','9']))})}
fn collect(root:&Path,relative:&Path,files:&mut Vec<PathBuf>)->Result<()> {
    let path=root.join(relative);if !path.exists(){return Ok(());}
    let meta=fs::symlink_metadata(&path).map_err(error)?;
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err(format!("工作目录包含链接，请备份其实际目录：{}",path.display()));}}
    if meta.file_type().is_symlink(){return Err("工作目录包含符号链接，请单独备份目标目录".into());}
    if meta.is_dir(){for entry in fs::read_dir(path).map_err(error)?{let entry=entry.map_err(error)?;if ["node_modules",".venv","__pycache__"].contains(&entry.file_name().to_string_lossy().as_ref()){continue;}collect(root,&relative.join(entry.file_name()),files)?;}}
    else if meta.is_file(){if !safe_path(relative){return Err("工作目录包含无法在 Windows 恢复的路径".into());}files.push(relative.into());if files.len()>9000{return Err("工作目录文件超过备份数量限制，请把大型项目放到独立目录并单独备份。".into());}}
    Ok(())
}
pub fn write_bundle(store:&Store,stage:&Path,zip:&mut ZipWriter<File>,options:SimpleFileOptions)->Result<bool> {
    let source=store.root.join("agents/agent-sessions.sqlite3");if !source.is_file(){return Ok(false);}
    let target=stage.join("agent-sessions.sqlite3");if !target.is_file(){snapshot(&source,&target)?;}
    zip.start_file("agents/agent-sessions.sqlite3",options).map_err(error)?;std::io::copy(&mut File::open(target).map_err(error)?,zip).map_err(error)?;
    let agent_root=store.root.join("agents");let mut files=Vec::new();collect(&agent_root,Path::new("workspaces"),&mut files)?;
    let sessions=agent_root.join("provider-sessions");if sessions.is_dir(){for file in fs::read_dir(sessions).map_err(error)?{let file=file.map_err(error)?;if file.path().extension().is_some_and(|e|e=="jsonl") {let relative=Path::new("provider-sessions").join(file.file_name());if !safe_path(&relative)||fs::symlink_metadata(file.path()).map_err(error)?.file_type().is_symlink(){return Err("会话文件路径无效".into());}files.push(relative);}}}
    let mut total=0u64;for relative in files {let path=agent_root.join(&relative);let size=fs::metadata(&path).map_err(error)?.len();total=total.checked_add(size).ok_or("工作目录大小无效")?;if size>512_000_000||total>1_500_000_000{return Err("工作目录超过完整备份容量，请单独备份大型项目。".into());}zip.start_file(format!("agents/{}",relative.to_string_lossy().replace('\\',"/")),options).map_err(error)?;
        if relative.starts_with("provider-sessions"){let mut bytes=Vec::new();File::open(path).map_err(error)?.take(size).read_to_end(&mut bytes).map_err(error)?;if let Some(end)=bytes.iter().rposition(|b|*b==b'\n'){zip.write_all(&bytes[..=end]).map_err(error)?;}else if !bytes.is_empty(){return Err("会话文件还没有完整记录，请稍后重试备份。".into());}}
        else{std::io::copy(&mut File::open(path).map_err(error)?.take(size),zip).map_err(error)?;}
    }Ok(true)
}
pub fn validate_bundle(stage:&Path,manifest:&Value,destination:&Path)->Result<bool> {
    let enabled=manifest["agentBundle"]==true;let path=stage.join("agents/agent-sessions.sqlite3");if !enabled {if path.exists(){return Err("备份缺少会话组件声明".into());}return Ok(false);}
    let db=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(error)?;let integrity:String=db.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(error)?;if integrity!="ok"{return Err("会话数据库不完整".into());}
    let mut query=db.prepare("SELECT id,data FROM agent_sessions").map_err(error)?;let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(error)?;let mut sessions=Vec::new();
    for row in rows {let (id,raw)=row.map_err(error)?;let session:AgentSession=serde_json::from_str(&raw).map_err(error)?;if session.id!=id||!["codex","claude","pi"].contains(&session.backend.as_str()){return Err("会话记录标识或后端无效".into());}sessions.push(session);}drop(query);
    let previous=manifest["sourceDataRoot"].as_str().map(PathBuf::from);let owned=previous.as_ref().map(|root|root.join("agents/workspaces"));
    for mut session in sessions {
        if let Some(relative)=owned.as_ref().and_then(|owned|Path::new(&session.cwd).strip_prefix(owned).ok()) {session.cwd=resources::display_path(&destination.join("agents/workspaces").join(relative));}
        if session.backend=="pi" {if let Some(source)=session.source_id.as_ref(){let file=source.rsplit(['\\','/']).next().unwrap_or("");if safe_path(Path::new(file)) && stage.join("agents/provider-sessions").join(file).is_file(){session.source_id=Some(resources::display_path(&destination.join("agents/provider-sessions").join(file)));}else{session.source_id=None;session.error=Some("备份不含此来源会话文件。历史已保留，下次发送会建立新的来源。".into());}}}
        db.execute("UPDATE agent_sessions SET data=?1 WHERE id=?2",rusqlite::params![serde_json::to_string(&session).map_err(error)?,session.id]).map_err(error)?;
    }Ok(true)
}
pub fn restore_database(root:&Path,source:&Path)->Result<()> {fs::create_dir_all(root.join("agents")).map_err(error)?;let mut db=Connection::open(root.join("agents/agent-sessions.sqlite3")).map_err(error)?;db.busy_timeout(std::time::Duration::from_secs(5)).map_err(error)?;db.restore(DatabaseName::Main,source,None::<fn(rusqlite::backup::Progress)>).map_err(error)}
pub fn save_current_database(root:&Path,target:&Path)->Result<bool>{let source=root.join("agents/agent-sessions.sqlite3");if !source.is_file(){return Ok(false);}snapshot(&source,target)?;Ok(true)}
pub fn finish_owned_dirs(root:&Path)->Result<()> {let db=Connection::open(root.join("agents/agent-sessions.sqlite3")).map_err(error)?;let mut query=db.prepare("SELECT data FROM agent_sessions").map_err(error)?;let rows=query.query_map([],|r|r.get::<_,String>(0)).map_err(error)?;let owned=root.join("agents/workspaces");for row in rows{let session:AgentSession=serde_json::from_str(&row.map_err(error)?).map_err(error)?;let cwd=PathBuf::from(session.cwd);if cwd.starts_with(&owned){fs::create_dir_all(cwd).map_err(error)?;}}Ok(())}
pub fn remap_shell(value:&mut Value,manifest:&Value,destination:&Path) {
    let Some(previous)=manifest["sourceDataRoot"].as_str().map(PathBuf::from)else{return;};
    fn path(value:&str,previous:&Path,destination:&Path)->Option<String>{Path::new(value).strip_prefix(previous).ok().map(|suffix|resources::display_path(&destination.join(suffix)))}
    fn target(value:&str,previous:&Path,destination:&Path)->Option<String>{if let Some(new)=path(value,previous,destination){return Some(new);}let mut url=url::Url::parse(value).ok()?;if url.scheme()=="file"{let new=path(&url.to_file_path().ok()?.to_string_lossy(),previous,destination)?;return url::Url::from_file_path(new).ok().map(|url|url.to_string());}if url.scheme()=="obsidian"{let pairs:Vec<_>=url.query_pairs().into_owned().collect();let old=pairs.iter().find(|(key,_)|key=="path")?;let new=path(&old.1,previous,destination)?;url.query_pairs_mut().clear().extend_pairs(pairs.iter().map(|(key,value)|(key.as_str(),if key=="path"{new.as_str()}else{value.as_str()})));return Some(url.to_string());}None}
    fn walk(value:&mut Value,previous:&Path,destination:&Path){match value{Value::Object(fields)=>for (key,value)in fields{if ["cwd","path","target","reference"].contains(&key.as_str()){if let Some(raw)=value.as_str(){if let Some(new)=target(raw,previous,destination){*value=Value::String(new);}}}else{walk(value,previous,destination);}},Value::Array(values)=>for value in values{walk(value,previous,destination);},_=>{}}}
    walk(value,&previous,destination);
}
