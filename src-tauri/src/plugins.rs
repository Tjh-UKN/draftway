use crate::store::{Store,Result,error};
use rusqlite::OptionalExtension;
use serde_json::{json,Value};
use std::collections::HashSet;

const KEY:&str="plugins-v1";
fn token(value:&str)->bool{!value.is_empty()&&value.len()<=80&&value.as_bytes()[0].is_ascii_lowercase()&&value.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'.'||b==b'-')&&!matches!(value,"constructor"|"prototype")}
fn path(value:&str)->bool{
    !value.is_empty()&&value.len()<=180&&value.split('/').all(|part|{
        let stem=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        !part.is_empty()&&!matches!(part,"."|"..")&&!part.ends_with('.')&&part.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'.'|b'-'))&&!["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"].contains(&stem.as_str())
    })
}
fn text<'a>(value:&'a Value,key:&str)->&'a str{value[key].as_str().unwrap_or("")}
fn version(value:&str)->bool{let (core,suffix)=value.split_once('-').map_or((value,None),|(core,suffix)|(core,Some(suffix)));let parts=core.split('.').collect::<Vec<_>>();parts.len()==3&&parts.iter().all(|part|!part.is_empty()&&part.bytes().all(|b|b.is_ascii_digit()))&&suffix.is_none_or(|suffix|!suffix.is_empty()&&suffix.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'.'||b==b'-'))}
fn package(value:&Value)->Result<()>{
    let manifest=&value["manifest"];let files=value["files"].as_object().ok_or("插件文件无效")?;
    if serde_json::to_vec(value).map_err(error)?.len()>800_000||!value["enabled"].is_boolean()||manifest["manifestVersion"]!=1||manifest["execution"]!="sandboxed-ui"||!token(text(manifest,"id"))||text(manifest,"name").trim().is_empty()||text(manifest,"name").chars().count()>80||!version(text(manifest,"version"))||text(manifest,"version").len()>80||files.len()>32||manifest.get("description").is_some_and(|value|value.as_str().is_none_or(|text|text.chars().count()>500)){return Err("插件声明无效".into());}
    let caps=manifest["capabilities"].as_array().ok_or("插件能力无效")?;let mut unique=HashSet::new();
    if caps.len()>3||caps.iter().any(|cap|!matches!(cap.as_str(),Some("note.read"|"note.edit"|"storage.own"))||!unique.insert(cap.as_str().unwrap())){return Err("插件能力不受支持".into());}
    for (name,body) in files{if !path(name)||!body.is_string()||!name.rsplit('.').next().is_some_and(|ext|["js","html","css","json"].contains(&ext.to_ascii_lowercase().as_str())){return Err("插件文件路径无效".into());}}
    let contributions=manifest["contributes"].as_object().ok_or("插件贡献点无效")?;
    if contributions.keys().any(|key|!matches!(key.as_str(),"commands"|"panels")){return Err("插件贡献点不受支持".into());}
    let empty=vec![];let commands=if let Some(commands)=contributions.get("commands"){commands.as_array().ok_or("插件命令无效")?}else{&empty};
    let panels=if let Some(panels)=contributions.get("panels"){panels.as_array().ok_or("插件面板无效")?}else{&empty};
    if commands.len()>32||panels.len()>8||commands.is_empty()&&panels.is_empty(){return Err("插件贡献点数量无效".into());}
    let mut ids=HashSet::new();for contribution in commands.iter().chain(panels.iter()){
        let id=text(contribution,"id");if !token(id)||!ids.insert(id)||text(contribution,"title").trim().is_empty()||text(contribution,"title").chars().count()>80{return Err("插件贡献点无效或重名".into());}
    }
    if !commands.is_empty()||manifest.get("main").is_some(){let main=text(manifest,"main");if !path(main)||!main.ends_with(".js")||!files.contains_key(main){return Err("插件命令入口无效".into());}}
    for panel in panels{let entry=text(panel,"entry");if !path(entry)||!entry.ends_with(".html")||!files.contains_key(entry){return Err("插件面板入口无效".into());}}
    Ok(())
}
fn validate(value:&Value)->Result<()>{
    let plugins=value["plugins"].as_array().ok_or("插件列表无效")?;let data=value["data"].as_object().ok_or("插件数据无效")?;
    if value["format"]!=1||value["revision"].as_u64().is_none()||plugins.len()>12||serde_json::to_vec(value).map_err(error)?.len()>12_000_000{return Err("插件存储无效或超出容量".into());}
    let mut ids=HashSet::new();for plugin in plugins{package(plugin)?;if !ids.insert(text(&plugin["manifest"],"id")){return Err("插件标识重复".into());}}
    for (id,entry) in data{if !token(id)||!entry.is_object()||serde_json::to_vec(entry).map_err(error)?.len()>64_000{return Err("插件私有数据无效或超过 64 KB".into());}}
    Ok(())
}
fn decode(raw:Option<String>)->Result<Value>{let value=raw.map(|raw|serde_json::from_str(&raw).map_err(error)).transpose()?.unwrap_or_else(||json!({"format":1,"revision":0,"plugins":[],"data":{}}));validate(&value)?;Ok(value)}
pub fn load(store:&Store)->Result<Value>{let raw=store.db.lock().map_err(error)?.query_row("SELECT value FROM metadata WHERE key=?1",[KEY],|row|row.get::<_,String>(0)).optional().map_err(error)?;decode(raw)}
fn apply(mut value:Value,operation:&Value)->Result<Value>{
    let id=text(operation,"id");
    match text(operation,"kind"){
        "install"=>{let mut plugin=operation["plugin"].clone();package(&plugin)?;plugin["enabled"]=json!(false);let id=text(&plugin["manifest"],"id").to_owned();let plugins=value["plugins"].as_array_mut().unwrap();plugins.retain(|old|text(&old["manifest"],"id")!=id);plugins.push(plugin);},
        "enable"=>{let plugin=value["plugins"].as_array_mut().unwrap().iter_mut().find(|plugin|text(&plugin["manifest"],"id")==id).ok_or("插件不存在")?;plugin["enabled"]=json!(operation["enabled"].as_bool().ok_or("插件启用状态无效")?);},
        "uninstall"=>value["plugins"].as_array_mut().unwrap().retain(|plugin|text(&plugin["manifest"],"id")!=id),
        "storage.set"=>{
            let plugin=value["plugins"].as_array().unwrap().iter().find(|plugin|text(&plugin["manifest"],"id")==id&&plugin["enabled"]==true).ok_or("插件未启用")?;
            if !plugin["manifest"]["capabilities"].as_array().unwrap().iter().any(|cap|cap=="storage.own"){return Err("插件没有存储权限".into());}
            let key=text(operation,"key");if !token(key)||operation.get("value").is_none(){return Err("插件存储参数无效".into());}
            let data=value["data"].as_object_mut().unwrap().entry(id).or_insert_with(||json!({}));data[key]=operation["value"].clone();
        },
        _=>return Err("插件操作无效".into())
    }
    value["revision"]=json!(value["revision"].as_u64().unwrap()+1);validate(&value)?;Ok(value)
}
pub fn change(store:&Store,operation:&Value)->Result<Value>{
    let mut db=store.write_db()?;let transaction=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;
    let raw=transaction.query_row("SELECT value FROM metadata WHERE key=?1",[KEY],|row|row.get::<_,String>(0)).optional().map_err(error)?;let value=apply(decode(raw)?,operation)?;
    transaction.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![KEY,serde_json::to_string(&value).map_err(error)?]).map_err(error)?;transaction.commit().map_err(error)?;Ok(value)
}
#[cfg(test)]mod tests{
    use super::*;
    fn sample()->Value{json!({"manifest":{"manifestVersion":1,"execution":"sandboxed-ui","id":"local.tools","name":"Tools","version":"1.0.0","capabilities":["note.read","note.edit","storage.own"],"main":"main.js","contributes":{"commands":[{"id":"tidy","title":"Tidy"}],"panels":[]}},"files":{"main.js":"northstar.commands.register('tidy',()=>{});"},"enabled":true})}
    #[test]fn install_grants_no_execution_and_updates_revoke_it(){let base=decode(None).unwrap();let registry=apply(base,&json!({"kind":"install","plugin":sample()})).unwrap();assert_eq!(registry["plugins"][0]["enabled"],false);let enabled=apply(registry,&json!({"kind":"enable","id":"local.tools","enabled":true})).unwrap();let stored=apply(enabled,&json!({"kind":"storage.set","id":"local.tools","key":"draft","value":"keep"})).unwrap();let updated=apply(stored,&json!({"kind":"install","plugin":sample()})).unwrap();assert_eq!(updated["plugins"][0]["enabled"],false);assert_eq!(updated["data"]["local.tools"]["draft"],"keep");assert!(apply(updated,&json!({"kind":"storage.set","id":"local.tools","key":"draft","value":"overwrite"})).is_err());}
    #[test]fn rejects_paths_permissions_and_missing_entry(){let mut plugin=sample();plugin["manifest"]["capabilities"]=json!(["filesystem.read"]);assert!(package(&plugin).is_err());for name in ["../main.js","C:/main.js","CON.js","assets/../main.js"]{let mut plugin=sample();plugin["manifest"]["main"]=json!(name);assert!(package(&plugin).is_err());}let mut plugin=sample();plugin["files"]=json!({});assert!(package(&plugin).is_err());}
    #[test]fn registry_persists_and_does_not_modify_notes(){let root=std::env::temp_dir().join(format!("northstar-plugins-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();store.seed_if_new().unwrap();let notes=store.load().unwrap().records;change(&store,&json!({"kind":"install","plugin":sample()})).unwrap();assert_eq!(store.load().unwrap().records,notes);drop(store);let reopened=Store::open(root).unwrap();assert_eq!(load(&reopened).unwrap()["plugins"].as_array().unwrap().len(),1);}
}
