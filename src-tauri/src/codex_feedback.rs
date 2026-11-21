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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(default, rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
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

const OUTPUT_LIMIT: usize = 1600;

fn output_tail(text: &str) -> String {
    let mut tail: Vec<_> = text.chars().rev()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .take(OUTPUT_LIMIT + 1).collect();
    let truncated = tail.len() > OUTPUT_LIMIT;
    tail.truncate(OUTPUT_LIMIT);
    let mut output = if truncated {"…\n".to_owned()} else {String::new()};
    output.extend(tail.into_iter().rev());
    output
}

fn tool_result(result: &Value) -> Option<String> {
    let text = result["content"].as_array()?.iter().rev()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str()).take(5)
        .map(output_tail).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    (!text.is_empty()).then(|| output_tail(&text))
}

fn target(args: &Value, keys: &[&str], limit: usize) -> String {
    keys.iter().filter_map(|key| args[*key].as_str())
        .map(|value| bounded(value, limit)).find(|value| !value.is_empty()).unwrap_or_default()
}

fn web_action(item: &Value) -> (&'static str, String) {
    let action = &item["action"];
    let (title, detail) = match action["type"].as_str() {
        Some("openPage") => ("打开网页", target(action, &["url"], 400)),
        Some("findInPage") => ("在网页中查找", [target(action, &["url"], 320), target(action, &["pattern"], 120)]
            .into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join("\n")),
        _ => {
            let queries = action["queries"].as_array().into_iter().flatten().filter_map(Value::as_str)
                .take(5).map(|query| bounded(query, 180)).collect::<Vec<_>>().join("\n");
            ("搜索网页", if queries.is_empty() {target(action, &["query"], 400)} else {queries})
        }
    };
    (title, if detail.is_empty() {target(item, &["query"], 400)} else {detail})
}

pub fn item(item: &Value, completed: bool) -> Option<Activity> {
    let id = item["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 128)?;
    let mut subject = None;
    let mut output = None;
    let mut exit_code = None;
    let (kind, title, detail) = match item["type"].as_str()? {
        "commandExecution" => {
            let command = bounded(item["command"].as_str().unwrap_or_default(), 500);
            let action = item["commandActions"].as_array().filter(|actions| actions.len() == 1)
                .and_then(|actions| actions.first());
            let title = match action.and_then(|action| action["type"].as_str()) {
                Some("read") => "读取文件",
                Some("listFiles") => "列出文件",
                Some("search") => "搜索文件内容",
                _ => "执行命令",
            };
            subject = action.map(|action| target(action, &["query", "path", "name"], 400))
                .filter(|label| !label.is_empty());
            if completed {
                output = item["aggregatedOutput"].as_str().filter(|text| !text.is_empty()).map(output_tail);
                exit_code = item["exitCode"].as_i64();
            }
            (ActivityKind::Command, title.into(), command)
        }
        "fileChange" => {
            let paths = item["changes"].as_array().into_iter().flatten()
                .filter_map(|change| change["path"].as_str()).take(8)
                .map(|path| bounded(path, 180)).collect::<Vec<_>>().join("\n");
            (ActivityKind::Files, "修改文件".into(), paths)
        }
        "webSearch" => {
            let (title, detail) = web_action(item);
            (ActivityKind::Search, title.into(), detail)
        }
        "mcpToolCall" | "dynamicToolCall" | "collabToolCall" => {
            let title = bounded(item["tool"].as_str().unwrap_or_default(), 100);
            if completed {
                output = item["error"]["message"].as_str().map(output_tail)
                    .or_else(|| tool_result(&item["result"]));
            }
            let detail = target(&item["arguments"], &["query", "url", "path", "file_path", "pattern", "command"], 400);
            (ActivityKind::Tool, if title.is_empty() {"调用工具".into()} else {title}, detail)
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
    Some(Activity {id: id.into(), kind, title, status, detail: (!detail.is_empty()).then_some(detail), subject, output, exit_code, after_message_id: None})
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
    Some(Activity {id: "$turn-plan".into(), kind: ActivityKind::Plan, title: "计划".into(), status, detail: (!detail.is_empty()).then_some(detail), subject: None, output: None, exit_code: None, after_message_id: None})
}

fn pi_tool(name: &str, args: &Value) -> (ActivityKind, String, String) {
    let (kind, title, keys): (_, _, &[_]) = match name {
        "bash" => (ActivityKind::Command, "执行命令", &["command"]),
        "read" => (ActivityKind::Files, "读取文件", &["path"]),
        "write" => (ActivityKind::Files, "写入文件", &["path"]),
        "edit" => (ActivityKind::Files, "修改文件", &["path"]),
        "ls" => (ActivityKind::Files, "列出目录", &["path"]),
        "find" => (ActivityKind::Files, "查找文件", &["pattern"]),
        "grep" => (ActivityKind::Files, "搜索文件内容", &["pattern"]),
        "web_search" | "webSearch" | "brave_search" => (ActivityKind::Search, "搜索网页", &["query", "q"]),
        "web_fetch" | "fetch_url" => (ActivityKind::Search, "打开网页", &["url"]),
        _ => (ActivityKind::Tool, name, &["query", "url", "path", "file_path", "pattern", "command"]),
    };
    let mut detail = target(args, keys, 500);
    if matches!(name, "grep" | "find") {
        let path = target(args, &["path"], 180);
        detail = [detail, path].into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join("\n");
    }
    (kind, title.to_owned(), detail)
}

pub fn pi_activity(event: &Value, assistant: Option<u32>) -> Option<Activity> {
    let event_type = event["type"].as_str()?;
    let mut detail = String::new();
    let mut output = None;
    let mut exit_code = None;
    let (id, kind, title, status) = match event_type {
        "message_update" => {
            let update = &event["assistantMessageEvent"];
            let status = match update["type"].as_str()? {
                "thinking_start" => ActivityStatus::Running,
                "thinking_end" => ActivityStatus::Completed,
                _ => return None,
            };
            let index = update["contentIndex"].as_u64().unwrap_or(0);
            (format!("pi-thinking-{}-{index}", assistant?), ActivityKind::Thinking, "思考".into(), status)
        }
        "tool_execution_start" | "tool_execution_end" => {
            let id = event["toolCallId"].as_str().filter(|id| !id.is_empty() && id.len() <= 128)?;
            let status = if event_type == "tool_execution_start" {ActivityStatus::Running}
                else if event["isError"] == true {ActivityStatus::Failed} else {ActivityStatus::Completed};
            let name = bounded(event["toolName"].as_str().unwrap_or("调用工具"), 100);
            let (kind, title, input) = pi_tool(&name, &event["args"]);
            detail = input;
            if event_type == "tool_execution_end" {
                output = tool_result(&event["result"]);
                exit_code = event["result"]["details"]["exitCode"].as_i64();
            }
            (id.to_owned(), kind, title, status)
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
    Some(Activity {id, kind, title, status, detail: (!detail.is_empty()).then_some(detail), subject: None, output, exit_code, after_message_id: None})
}

pub fn update_output(rows: &mut [Activity], id: &Value, output: &Value, append: bool) {
    let Some(id) = id.as_str() else {return;};
    let Some(row) = rows.iter_mut().find(|row| row.id == id && row.status == ActivityStatus::Running
        && matches!(row.kind, ActivityKind::Command | ActivityKind::Files | ActivityKind::Search | ActivityKind::Tool)) else {return;};
    let output = if append {
        output.as_str().map(|delta| output_tail(&format!("{}{delta}", row.output.as_deref().unwrap_or_default())))
    } else {tool_result(output)};
    if output.is_some() {row.output = output;}
}

pub fn live_output(rows: &[Activity]) -> impl Iterator<Item = &Activity> {
    rows.iter().filter(|row| row.status == ActivityStatus::Running && row.output.is_some())
}

pub fn upsert(rows: &mut Vec<Activity>, mut activity: Activity) {
    if let Some(previous) = rows.iter_mut().find(|row| row.id == activity.id) {
        // Item completion is authoritative if a start notification arrives later.
        if activity.kind != ActivityKind::Plan && previous.status != ActivityStatus::Running && activity.status == ActivityStatus::Running {return;}
        if activity.detail.is_none() {activity.detail = previous.detail.take();}
        if activity.subject.is_none() {
            activity.subject = previous.subject.take();
            if activity.subject.is_some() {activity.title = previous.title.clone();}
        }
        if activity.output.is_none() {activity.output = previous.output.take();}
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
