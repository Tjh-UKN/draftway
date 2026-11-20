use super::options::{string, ModelOption, ModelOptions, ReasoningEffort};
use super::{Result, Rpc};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn effective(settings: &Value) -> (Option<String>, Option<String>) {
    let applied = &settings["applied"];
    let legacy = &settings["effective"];
    let model = string(applied, "model").or_else(|| string(legacy, "model"));
    let effort = match applied.get("effort") {
        Some(_) => string(applied, "effort"),
        None => string(legacy, "effortLevel"),
    };
    (model, effort)
}

fn model_options(listing: &Value, settings: &Value) -> Result<ModelOptions> {
    let rows = listing["models"]
        .as_array()
        .ok_or("Claude 未返回可用模型")?;
    let default = rows
        .iter()
        .find(|row| row["value"] == "default" && row["disabled"] != true)
        .map(|row| string(row, "resolvedModel").unwrap_or_else(|| "default".into()));
    let mut models: Vec<ModelOption> = Vec::new();
    // Prefer a named catalog row for the label and capabilities of a resolved model.
    for row in rows
        .iter()
        .filter(|row| row["value"] != "default")
        .chain(rows.iter().filter(|row| row["value"] == "default"))
        .filter(|row| row["disabled"] != true)
    {
        let Some(value) = string(row, "value") else {
            continue;
        };
        let model = string(row, "resolvedModel").unwrap_or_else(|| value.clone());
        if models.iter().any(|option| option.model == model) {
            continue;
        }
        let supported_reasoning_efforts = row["supportedEffortLevels"]
            .as_array()
            .filter(|_| row["supportsEffort"] != false)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|level| ReasoningEffort {
                reasoning_effort: level.into(),
                description: String::new(),
            })
            .collect();
        let display_name = match string(row, "displayName") {
            Some(label) if value != "default" && model != value && label != model => {
                format!("{label} · {model}")
            }
            Some(label) if value != "default" || model == value => label,
            _ => model.clone(),
        };
        models.push(ModelOption {
            id: model.clone(),
            display_name,
            is_default: default.as_ref() == Some(&model),
            model,
            default_reasoning_effort: String::new(),
            supported_reasoning_efforts,
            hidden: false,
        });
    }
    if models.is_empty() {
        return Err("Claude 没有返回可选模型".into());
    }
    let (reported_model, effort) = effective(settings);
    let model = match reported_model.as_deref() {
        Some("default") | None => default.or(reported_model),
        Some(report) => rows.iter().find(|row| row["value"] == report)
            .and_then(|row| string(row, "resolvedModel")).or(reported_model),
    };
    Ok(ModelOptions { models, model, effort, picker_scope: Vec::new() })
}

pub fn read(rpc: &Rpc, deadline: Instant) -> Result<ModelOptions> {
    let request = |method, params| {
        rpc.request_with_timeout(method, params, deadline.saturating_duration_since(Instant::now()))
    };
    let listing = match request("list_models", json!({})) {
        Ok(listing) => listing,
        Err(_) => request("initialize", json!({"hooks":{}}))?,
    };
    let settings = request("get_settings", json!({})).unwrap_or(Value::Null);
    model_options(&listing, &settings)
}

pub fn apply(rpc: &Rpc, model: Option<&str>, effort: Option<&str>) -> Result<()> {
    let timeout = Duration::from_secs(5);
    if let Some(model) = model {
        rpc.request_with_timeout("set_model", json!({"model": model}), timeout)?;
    }
    if let Some(effort) = effort {
        rpc.request_with_timeout("apply_flag_settings", json!({"settings":{"effortLevel":effort}}), timeout)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_catalog_models_and_observed_settings_are_distinct() {
        let listing = json!({"models":[
            {"value":"default","resolvedModel":"relay[1m]","displayName":"Default","supportsEffort":true,"supportedEffortLevels":["low","high"]},
            {"value":"sonnet","resolvedModel":"relay","displayName":"Relay","supportsEffort":true,"supportedEffortLevels":["low","high"]},
            {"value":"haiku","resolvedModel":"relay"},
            {"value":"disabled-model","disabled":true}
        ]});
        let settings = json!({"applied":{"model":"sonnet","effort":"high"},"effective":{"effortLevel":"low"}});
        let options = model_options(&listing, &settings).unwrap();
        assert_eq!(options.models.len(), 2);
        assert_eq!(options.model.as_deref(), Some("relay"));
        assert_eq!(options.effort.as_deref(), Some("high"));
        assert_eq!(options.models[0].supported_reasoning_efforts.len(), 2);
        let default = options.models.iter().find(|model| model.is_default).unwrap();
        assert_eq!(default.model, "relay[1m]");
        assert_eq!(default.display_name, "relay[1m]");
        assert_eq!(effective(&json!({"applied":{"effort":null},"effective":{"effortLevel":"low"}})).1, None);
    }
}
