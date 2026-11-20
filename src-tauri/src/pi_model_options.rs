use super::options::{string, ModelOption, ModelOptions, ReasoningEffort};
use super::{Result, Rpc};
use serde_json::{json, Value};
use std::time::Instant;

const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

fn model_key(model: &Value) -> Option<String> {
    let provider = model["provider"].as_str().filter(|name| {
        !name.is_empty() && *name != "unknown" && !name.contains('/')
    })?;
    let id = model["id"].as_str().filter(|id| !id.is_empty())?;
    Some(format!("{provider}/{id}"))
}

pub fn effective(state: &Value) -> (Option<String>, Option<String>) {
    let model = model_key(&state["model"]);
    let effort = model.as_ref().and_then(|_| string(state, "thinkingLevel"));
    (model, effort)
}

fn catalog(state: &Value, inventory: &Value) -> Result<ModelOptions> {
    let (model, effort) = effective(state);
    let models = inventory["models"].as_array().ok_or("Pi 返回的模型列表无效")?;
    let models = models.iter().filter_map(|entry| {
        let id = model_key(entry)?;
        let display_name = string(entry, "name").unwrap_or_else(|| id.clone());
        let mut supported_reasoning_efforts = Vec::new();
        if entry["reasoning"] == true {
            let map = entry.get("thinkingLevelMap");
            for level in LEVELS {
                let mapped = map.and_then(|map| map.get(level));
                if mapped.is_some_and(Value::is_null)
                    || (matches!(level, "xhigh" | "max") && !mapped.is_some_and(Value::is_string))
                {
                    continue;
                }
                supported_reasoning_efforts.push(ReasoningEffort {
                    reasoning_effort: level.into(),
                    description: String::new(),
                });
            }
        }
        let is_default = model.as_deref() == Some(id.as_str());
        Some(ModelOption {
            model: id.clone(),
            id,
            display_name,
            default_reasoning_effort: if is_default { effort.clone().unwrap_or_default() } else { String::new() },
            supported_reasoning_efforts,
            is_default,
            hidden: false,
        })
    }).collect::<Vec<_>>();
    if models.is_empty() { return Err("Pi 暂无可用模型，请检查供应商配置".into()); }
    Ok(ModelOptions { models, model, effort, picker_scope: Vec::new() })
}

pub fn read(rpc: &Rpc, deadline: Instant, scope: impl FnOnce(&Value) -> Option<Vec<String>>) -> Result<ModelOptions> {
    let request = |method| rpc.request_with_timeout(
        method, json!({}), deadline.saturating_duration_since(Instant::now()),
    );
    let state = request("get_state")?;
    let inventory = request("get_available_models")?;
    let mut catalog = catalog(&state, &inventory)?;
    catalog.picker_scope = scope(&inventory["models"]).unwrap_or_default();
    Ok(catalog)
}

pub fn apply(rpc: &Rpc, model: Option<&str>, effort: Option<&str>) -> Result<(Option<String>, Option<String>)> {
    apply_with(model, effort, |method, params| rpc.request(method, params))
}

fn apply_with(
    model: Option<&str>,
    effort: Option<&str>,
    mut request: impl FnMut(&str, Value) -> Result<Value>,
) -> Result<(Option<String>, Option<String>)> {
    let model_identity = model.map(|key| {
        key.split_once('/')
            .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
            .ok_or("Pi 模型需要供应商和模型标识")
    }).transpose()?;
    if effort.is_some_and(|value| !LEVELS.contains(&value)) {
        return Err("Pi 推理强度无效".into());
    }
    // Pi's setters update its defaults as well as the session. Skip unchanged writes.
    let current = effective(&request("get_state", json!({}))?);
    let mut changed = false;
    if let Some((provider, model_id)) = model_identity.filter(|_| model != current.0.as_deref()) {
        request("set_model", json!({"provider": provider, "modelId": model_id}))?;
        changed = true;
    }
    if let Some(level) = effort.filter(|level| changed || Some(*level) != current.1.as_deref()) {
        request("set_thinking_level", json!({"level": level}))?;
        changed = true;
    }
    if changed { Ok(effective(&request("get_state", json!({}))?)) } else { Ok(current) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_preserves_provider_identity_and_actual_supported_levels() {
        let reasoning_model = json!({"provider":"local","id":"nested/alpha","name":"Alpha","reasoning":true,
            "thinkingLevelMap":{"minimal":null,"xhigh":"max"}});
        let state = json!({"model":reasoning_model,"thinkingLevel":"high"});
        let catalog = catalog(&state, &json!({"models":[reasoning_model,
            {"provider":"other","id":"nested/alpha","reasoning":false}]})).unwrap();
        assert_eq!(catalog.model.as_deref(), Some("local/nested/alpha"));
        assert_eq!(catalog.effort.as_deref(), Some("high"));
        let levels = catalog.models[0].supported_reasoning_efforts.iter().map(|option| {
            option.reasoning_effort.as_str()
        }).collect::<Vec<_>>();
        assert_eq!(levels, ["off", "low", "medium", "high", "xhigh"]);
        assert_eq!(catalog.models[1].model, "other/nested/alpha");
        assert!(catalog.models[1].supported_reasoning_efforts.is_empty());
    }

    #[test]
    fn changes_model_before_effort_and_reports_provider_effective_state() {
        let expected = ["get_state", "set_model", "set_thinking_level", "get_state"];
        let mut index = 0;
        let result = apply_with(Some("other/nested/alpha"), Some("max"), |method, params| {
            assert_eq!(method, expected[index]);
            index += 1;
            Ok(match method {
                "get_state" if index == 1 => json!({"model":{"provider":"local","id":"beta"},"thinkingLevel":"medium"}),
                "get_state" => json!({"model":{"provider":"other","id":"nested/alpha"},"thinkingLevel":"high"}),
                "set_model" => {
                    assert_eq!(params, json!({"provider":"other","modelId":"nested/alpha"}));
                    Value::Null
                }
                _ => {
                    assert_eq!(params, json!({"level":"max"}));
                    Value::Null
                }
            })
        }).unwrap();
        assert_eq!(index, expected.len());
        assert_eq!(result, (Some("other/nested/alpha".into()), Some("high".into())));
    }
}
