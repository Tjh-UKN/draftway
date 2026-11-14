use serde_json::Value;
use std::collections::HashSet;

fn text(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= limit)
}

fn valid_board(board: &Value) -> bool {
    if !board["id"].as_str().is_some_and(crate::domain::valid_id)
        || !text(&board["name"], 60)
        || !board["zoom"].as_u64().is_some_and(|zoom| (60..=140).contains(&zoom)) {
        return false;
    }
    if let Some(url) = board.get("url") {
        if !url.as_str().is_some_and(|url| crate::domain::edge_workspace_url(url).is_ok()) {return false;}
    }
    let Some(widgets) = board["widgets"].as_array().filter(|widgets| widgets.len() <= 40) else {return false;};
    let mut ids = HashSet::new();
    widgets.iter().all(|widget| {
        let Some(id) = widget["id"].as_str().filter(|id| crate::domain::valid_id(id)) else {return false;};
        if !ids.insert(id) {return false;}
        let Some(config) = widget["config"].as_object().filter(|config| config.len() <= 32) else {return false;};
        widget["type"].as_str().is_some_and(|kind| !kind.is_empty() && kind.len() <= 80 && kind.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
            && widget["version"].as_u64().is_some_and(|version| (1..=1000).contains(&version))
            && text(&widget["title"], 80)
            && widget["columns"].as_u64().is_some_and(|columns| [4,6,8,10,12].contains(&columns))
            && widget["height"].as_u64().is_some_and(|height| (240..=1200).contains(&height))
            && widget.get("window").is_none_or(|rect| rect.is_object()
                && ["x","y"].iter().all(|key| rect[*key].as_u64().is_some_and(|value| value<=100_000))
                && ["width","height"].iter().all(|key| rect[*key].as_u64().is_some_and(|value| (160..=4096).contains(&value))))
            && config.iter().all(|(key, value)| key.encode_utf16().count() <= 80 && value.as_str().is_some_and(|value| value.encode_utf16().count() <= 2000))
    })
}

pub fn validate(layout: &Value) -> Result<(), String> {
    if layout["version"].as_u64() != Some(1) {return Err("工作区布局版本不受支持".into());}
    if serde_json::to_vec(layout).map_err(|error| error.to_string())?.len() > 512_000 {return Err("工作区布局过大".into());}
    for (key, minimum) in [("workspaces", 1), ("templates", 0)] {
        let boards = layout[key].as_array().ok_or("工作区列表格式无效")?;
        let mut ids = HashSet::new();
        if boards.len() < minimum || boards.len() > 32 || !boards.iter().all(|board| valid_board(board) && ids.insert(board["id"].as_str().unwrap())) {
            return Err("工作区布局格式无效".into());
        }
    }
    if !layout["workspaces"].as_array().unwrap().iter().any(|board| board["id"] == layout["activeId"]) {
        return Err("当前工作区不存在".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    pub fn sample() -> Value {
        let id = uuid::Uuid::new_v4().to_string();
        json!({"version":1,"activeId":id,"workspaces":[{"id":id,"name":"我的工作区","zoom":80,"widgets":[{"id":uuid::Uuid::new_v4().to_string(),"type":"future.pr","version":2,"title":"PR 管理","columns":6,"height":400,"config":{"repository":"example/project"}}]}],"templates":[]})
    }
    #[test] fn unknown_modules_are_preserved_but_invalid_layouts_are_rejected() {
        let original = sample();
        assert!(validate(&original).is_ok());
        let mut window = original.clone(); window["workspaces"][0]["widgets"][0]["window"] = json!({"x":20,"y":50,"width":640,"height":480});
        assert!(validate(&window).is_ok());
        for value in [json!({"x":-1,"y":50,"width":640,"height":480}),json!({"x":20,"y":50,"width":9000,"height":480}),json!(null)] {
            window["workspaces"][0]["widgets"][0]["window"] = value; assert!(validate(&window).is_err());
        }
        for (field, value) in [("zoom", json!(0)), ("zoom", json!(1.5)), ("name", json!(""))] {
            let mut layout = original.clone(); layout["workspaces"][0][field] = value; assert!(validate(&layout).is_err());
        }
        for (field, value) in [("columns",json!(5)), ("height",json!(100000)), ("config",json!({"nested":{}})), ("version",json!(0)), ("type",json!("../bad"))] {
            let mut layout = original.clone(); layout["workspaces"][0]["widgets"][0][field] = value; assert!(validate(&layout).is_err());
        }
        let mut duplicate = original.clone();
        duplicate["workspaces"].as_array_mut().unwrap().push(original["workspaces"][0].clone());
        assert!(validate(&duplicate).is_err());
        let mut duplicate_widget = original.clone();
        duplicate_widget["workspaces"][0]["widgets"].as_array_mut().unwrap().push(original["workspaces"][0]["widgets"][0].clone());
        assert!(validate(&duplicate_widget).is_err());
        let mut missing = original.clone(); missing["activeId"] = json!(uuid::Uuid::new_v4().to_string()); assert!(validate(&missing).is_err());
        let mut future = original.clone(); future["version"] = json!(2); assert!(validate(&future).is_err());
        let mut empty = original; empty["workspaces"] = json!([]); assert!(validate(&empty).is_err());
    }
    #[test] fn edge_workspaces_allow_only_web_urls_and_survive_layout_serialization() {
        assert_eq!(crate::domain::edge_workspace_url("http://127.0.0.1:8765/").unwrap(),"microsoft-edge:http://127.0.0.1:8765/");
        assert_eq!(crate::domain::edge_workspace_url("https://example.com/?a=1&b=2").unwrap(),"microsoft-edge:https://example.com/?a=1&b=2");
        let original=sample();
        for url in ["javascript:alert(1)","file:///C:/data","data:text/html,test","mailto:a@b.com","microsoft-edge:https://example.com","https://user:password@example.com",""] {
            assert!(crate::domain::edge_workspace_url(url).is_err());
            let mut layout=original.clone();layout["workspaces"][0]["url"]=json!(url);assert!(validate(&layout).is_err());
        }
        let mut web=original;web["workspaces"][0]["url"]=json!("http://127.0.0.1:8765/");web["workspaces"][0]["widgets"]=json!([]);
        assert!(validate(&serde_json::from_str::<Value>(&serde_json::to_string(&web).unwrap()).unwrap()).is_ok());
    }
}
