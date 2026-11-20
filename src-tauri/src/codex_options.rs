use super::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffort {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default, skip_serializing)]
    pub(super) hidden: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptions {
    pub models: Vec<ModelOption>,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(skip)]
    pub(super) picker_scope: Vec<String>,
}

pub fn string(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

impl ModelOptions {
    pub fn read(cwd: &str, mut request: impl FnMut(&str, Value) -> Result<Value>) -> Result<Self> {
        let config = request("config/read", json!({"cwd": cwd, "includeLayers": false}))
            .map(|result| result["config"].clone()).unwrap_or(Value::Null);
        let mut provider = string(&config, "model_provider");
        let mut models: Vec<ModelOption> = Vec::new();
        let mut cursor = None;
        for _ in 0..10 {
            let mut params = json!({"includeHidden": false, "limit": 100});
            if let Some(cursor) = &cursor {params["cursor"] = json!(cursor);}
            if let Some(provider) = &provider {params["modelProvider"] = json!(provider);}
            let result = match request("model/list", params.clone()) {
                Err(error) if provider.is_some() && error.contains("unknown field") && error.contains("modelProvider") => {
                    provider = None;
                    params.as_object_mut().unwrap().remove("modelProvider");
                    request("model/list", params)?
                }
                result => result?,
            };
            let data: Vec<ModelOption> = serde_json::from_value(result["data"].clone())
                .map_err(|_| "Codex 返回的模型列表无效")?;
            models.extend(data.into_iter().filter(|model| !model.hidden));
            let next = string(&result, "nextCursor");
            if next.is_none() {
                let model = string(&config, "model")
                    .or_else(|| models.iter().find(|item| item.is_default).map(|item| item.model.clone()));
                let configured_effort = string(&config, "model_reasoning_effort");
                let effort = model.as_deref().and_then(|model| {
                    models.iter().find(|item| item.model == model).and_then(|item| match configured_effort {
                        Some(effort) => item.supported_reasoning_efforts.iter()
                            .any(|value| value.reasoning_effort == effort).then_some(effort),
                        None => Some(item.default_reasoning_effort.clone()),
                    })
                });
                return Ok(Self { models, model, effort, picker_scope: Vec::new() });
            }
            if next == cursor {break;}
            cursor = next;
        }
        Err("Codex 模型列表分页未完成".into())
    }

    pub fn validate(&self, model: Option<&str>, effort: Option<&str>) -> Result<()> {
        let selected = model.or(self.model.as_deref());
        let option = match selected {
            Some(name) => self.models.iter().find(|item| item.model == name),
            None => self.models.iter().find(|item| item.is_default),
        };
        if model.is_some() && option.is_none() {
            return Err("所选模型不在当前执行器的模型目录中，请刷新后重选".into());
        }
        if let Some(effort) = effort {
            if !option.is_some_and(|item| item.supported_reasoning_efforts.iter().any(|value| value.reasoning_effort == effort)) {
                return Err("所选推理强度不适用于当前模型".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_configured_provider_models_and_validates_supported_effort() {
        let cwd = "D:\\project";
        let options = ModelOptions::read(cwd, |method, params| Ok(match method {
            "config/read" => {
                assert_eq!(params["cwd"], cwd);
                json!({"config":{"model":"custom","model_reasoning_effort":"high","model_provider":"local"}})
            }
            "model/list" => {
                assert_eq!(params["modelProvider"], "local");
                assert_eq!(params["includeHidden"], false);
                if params["cursor"] == "page2" {
                    json!({"data":[],"nextCursor":null})
                } else {
                    json!({"data":[{"id":"custom-picker","model":"custom","displayName":"Custom",
                        "defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"high","description":"Deep"}],"isDefault":true}],
                        "nextCursor":"page2"})
                }
            }
            _ => unreachable!(),
        })).unwrap();
        assert_eq!(options.model.as_deref(), Some("custom"));
        assert_eq!(options.effort.as_deref(), Some("high"));
        assert!(options.validate(Some("custom"), Some("high")).is_ok());
        assert!(options.validate(None, Some("high")).is_ok());
        assert!(options.validate(Some("unknown"), None).is_err());
        assert!(options.validate(None, Some("low")).is_err());
    }

    #[test]
    fn discovers_picker_default_and_clears_incompatible_configured_effort() {
        for (config, expected_effort) in [(json!({}), Some("medium")),
            (json!({"model_reasoning_effort":"high"}), None)] {
            let options = ModelOptions::read("D:\\project", |method, _| Ok(match method {
                "config/read" => json!({"config":config}),
                _ => json!({"data":[{"id":"pick","model":"recommended","displayName":"Recommended",
                    "defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Balanced"}],"isDefault":true}]}),
            })).unwrap();
            assert_eq!(options.model.as_deref(), Some("recommended"));
            assert_eq!(options.effort.as_deref(), expected_effort);
        }
    }
}
