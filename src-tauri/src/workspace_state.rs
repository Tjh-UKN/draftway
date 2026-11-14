use crate::store::{Store, Result, error};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashSet;

pub fn validate(value: &Value) -> Result<()> {
    if value["version"] != 2 {return Err("工作区数据版本不兼容，原始内容已保留。".into());}
    let spaces = value["spaces"].as_array().filter(|items| !items.is_empty() && items.len() <= 20).ok_or("工作区列表无效")?;
    let mut ids = HashSet::new();
    for space in spaces {
        let id = space["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 100).ok_or("工作区标识无效")?;
        if !ids.insert(id) || space["name"].as_str().is_none() || space["nodes"].as_array().is_none_or(|nodes| nodes.is_empty() || nodes.len() > 250) || !space["dock"].is_object() {return Err("工作区内容无效".into());}
    }
    if !value["activeId"].as_str().is_some_and(|id| ids.contains(id)) || ["sessions", "runs", "artifacts", "notices"].iter().any(|key| !value[key].is_array()) {return Err("工作区状态无效".into());}
    if serde_json::to_vec(value).map_err(error)?.len() > 16_000_000 {return Err("工作区状态超过 16 MB，请把大段材料保存为文件关联。".into());}
    Ok(())
}
pub fn load(store: &Store) -> Result<Option<Value>> {
    let raw: Option<String> = store.db.lock().map_err(error)?.query_row("SELECT value FROM metadata WHERE key='workbench-shell-v2'", [], |row| row.get(0)).optional().map_err(error)?;
    raw.map(|raw| {let value = serde_json::from_str(&raw).map_err(error)?; validate(&value)?; Ok(value)}).transpose()
}
pub fn save(store: &Store, value: &Value) -> Result<()> {
    validate(value)?;
    let mut db=store.write_db()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;let value=crate::map_ops::merge(&tx,value)?;validate(&value)?;
    tx.execute("INSERT INTO metadata(key,value) VALUES('workbench-shell-v2',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&value).map_err(error)?]).map_err(error)?;tx.commit().map_err(error)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn snapshot_roundtrip_rejects_invalid_overwrites_and_does_not_touch_business_records() {
        let dir = std::env::temp_dir().join(format!("northstar-shell-test-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.clone()).unwrap(); store.seed_if_new().unwrap(); let count = store.load().unwrap().records.len();
        let value = json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"n"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]});
        save(&store, &value).unwrap(); let mut invalid = value.clone(); invalid["version"] = json!(99); assert!(save(&store, &invalid).is_err()); assert_eq!(load(&store).unwrap(),Some(value.clone()));
        assert_eq!(store.load().unwrap().records.len(),count); drop(store); assert_eq!(load(&Store::open(dir).unwrap()).unwrap(),Some(value));
    }
}
