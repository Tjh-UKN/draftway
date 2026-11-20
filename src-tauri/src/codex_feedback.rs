use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunPhase {
    Connecting,
    Submitting,
    Executing,
    Responding,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ActivityKind {
    Command,
    Files,
    Search,
    Tool,
    Thinking,
    Plan,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ActivityStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Activity {
    id: String,
    kind: ActivityKind,
    title: String,
    status: ActivityStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, rename = "afterMessageId", skip_serializing_if = "Option::is_none")]
    pub(super) after_message_id: Option<String>,
}

fn bounded(text: &str, max: usize) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

pub fn item(item: &Value, completed: bool) -> Option<Activity> {
    let id = item["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 128)?;
    let (kind, title, detail) = match item["type"].as_str()? {
        "commandExecution" => {
            let command = bounded(item["command"].as_str().unwrap_or_default(), 500);
            let output = if completed {
                bounded(item["aggregatedOutput"].as_str().unwrap_or_default(), 1000)
            } else {String::new()};
            let exit = item["exitCode"].as_i64().filter(|_| completed).map(|code| format!("退出码 {code}")).unwrap_or_default();
            (ActivityKind::Command, "执行命令".into(), [command, output, exit].into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join("\n"))
        }
        "fileChange" => {
            let paths = item["changes"].as_array().into_iter().flatten()
                .filter_map(|change| change["path"].as_str()).take(8)
                .map(|path| bounded(path, 180)).collect::<Vec<_>>().join("\n");
            (ActivityKind::Files, "修改文件".into(), paths)
        }
        "webSearch" => (ActivityKind::Search, "搜索网页".into(), bounded(item["query"].as_str().unwrap_or_default(), 400)),
        "mcpToolCall" | "dynamicToolCall" | "collabToolCall" => {
            let title = bounded(item["tool"].as_str().unwrap_or_default(), 100);
            let error = if completed {bounded(item["error"]["message"].as_str().unwrap_or_default(), 500)} else {String::new()};
            (ActivityKind::Tool, if title.is_empty() {"调用工具".into()} else {title}, error)
        }
        "reasoning" => (ActivityKind::Thinking, "思考".into(), String::new()),
        _ => return None,
    };
    let status = if !completed {
        ActivityStatus::Running
    } else {
        match item["status"].as_str() {
            Some("declined" | "cancelled" | "interrupted") => ActivityStatus::Cancelled,
            Some("failed") => ActivityStatus::Failed,
            _ if item["exitCode"].as_i64().is_some_and(|code| code != 0) || item["success"] == false => ActivityStatus::Failed,
            _ => ActivityStatus::Completed,
        }
    };
    Some(Activity {id: id.into(), kind, title, status, detail: (!detail.is_empty()).then_some(detail), after_message_id: None})
}

pub fn plan(value: &Value) -> Option<Activity> {
    let steps = value["plan"].as_array().filter(|steps| !steps.is_empty())?;
    let detail = steps.iter().filter_map(|step| {
        let marker = match step["status"].as_str() {
            Some("completed") => "✓",
            Some("inProgress") => "→",
            _ => "•",
        };
        Some(format!("{marker} {}", bounded(step["step"].as_str()?, 120)))
    }).take(12).collect::<Vec<_>>().join("\n");
    let status = if steps.iter().all(|step| step["status"] == "completed") {ActivityStatus::Completed} else {ActivityStatus::Running};
    Some(Activity {id: "$turn-plan".into(), kind: ActivityKind::Plan, title: "计划".into(), status, detail: (!detail.is_empty()).then_some(detail), after_message_id: None})
}

pub fn pi_activity(event: &Value) -> Option<Activity> {
    let event_type = event["type"].as_str()?;
    let (id, kind, title, status) = match event_type {
        "message_update" => {
            let update = &event["assistantMessageEvent"];
            let status = match update["type"].as_str()? {
                "thinking_start" => ActivityStatus::Running,
                "thinking_end" => ActivityStatus::Completed,
                _ => return None,
            };
            let at = event["message"]["timestamp"].as_u64().or_else(|| update["partial"]["timestamp"].as_u64()).unwrap_or(0);
            let index = update["contentIndex"].as_u64().unwrap_or(0);
            (format!("pi-thinking-{at}-{index}"), ActivityKind::Thinking, "思考".into(), status)
        }
        "tool_execution_start" | "tool_execution_end" => {
            let id = event["toolCallId"].as_str().filter(|id| !id.is_empty() && id.len() <= 128)?;
            let status = if event_type == "tool_execution_start" {ActivityStatus::Running}
                else if event["isError"] == true {ActivityStatus::Failed} else {ActivityStatus::Completed};
            let name = bounded(event["toolName"].as_str().unwrap_or("调用工具"), 100);
            (id.to_owned(), ActivityKind::Tool, name, status)
        }
        "auto_retry_start" | "auto_retry_end" => {
            let attempt = event["attempt"].as_u64().unwrap_or(0);
            let status = if event_type == "auto_retry_start" {ActivityStatus::Running}
                else if event["success"] == true {ActivityStatus::Completed} else {ActivityStatus::Failed};
            (format!("pi-retry-{attempt}"), ActivityKind::Plan, "重试请求".into(), status)
        }
        "auto_compaction_start" | "auto_compaction_end" => {
            let status = if event_type == "auto_compaction_start" {ActivityStatus::Running}
                else if event["aborted"] == true {ActivityStatus::Cancelled} else {ActivityStatus::Completed};
            ("pi-compaction".into(), ActivityKind::Plan, "整理会话上下文".into(), status)
        }
        _ => return None,
    };
    Some(Activity {id, kind, title, status, detail: None, after_message_id: None})
}

pub fn upsert(rows: &mut Vec<Activity>, mut activity: Activity) {
    if let Some(previous) = rows.iter_mut().find(|row| row.id == activity.id && row.kind == activity.kind) {
        // Item completion is authoritative if a start notification arrives later.
        if activity.kind != ActivityKind::Plan && previous.status != ActivityStatus::Running && activity.status == ActivityStatus::Running {return;}
        if activity.detail.is_none() {activity.detail = previous.detail.take();}
        if previous.after_message_id.is_some() {activity.after_message_id = previous.after_message_id.take();}
        *previous = activity;
        return;
    }
    if rows.len() >= 48 {
        let oldest_finished = rows.iter().position(|row| row.status != ActivityStatus::Running).unwrap_or(0);
        rows.remove(oldest_finished);
    }
    rows.push(activity);
}

pub fn settle(rows: &mut [Activity], state: &str) {
    let status = match state {
        "succeeded" => ActivityStatus::Completed,
        "failed" => ActivityStatus::Failed,
        "cancelled" | "interrupted" => ActivityStatus::Cancelled,
        _ => return,
    };
    for row in rows.iter_mut().filter(|row| row.status == ActivityStatus::Running) {
        row.status = status;
    }
}
