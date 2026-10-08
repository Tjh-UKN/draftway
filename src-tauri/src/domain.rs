use chrono::{DateTime, Datelike, Local, Months, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub user_name: String,
    pub theme: String,
    pub layout: String,
    pub close_to_tray: bool,
    pub auto_start: bool,
    pub notifications: bool,
    pub daily_backup: bool,
}
impl Default for Settings {
    fn default() -> Self { Self { user_name:"同学".into(), theme:"dark".into(), layout:"overview".into(), close_to_tray:true, auto_start:false, notifications:true, daily_backup:true } }
}
pub fn now() -> String { Utc::now().to_rfc3339() }
pub fn external_url(value:&str)->Result<String,String>{
    let parsed=url::Url::parse(value).map_err(|_|"链接地址无效")?;
    if !parsed.username().is_empty()||parsed.password().is_some(){return Err("链接地址包含不支持的登录信息".into());}
    match parsed.scheme(){"http"|"https" if parsed.host_str().is_some()=>Ok(parsed.to_string()),"mailto" if !parsed.path().is_empty()=>Ok(parsed.to_string()),_=>Err("仅支持网页和邮件链接".into())}
}
pub fn reminder_token(id:&str,at:&str)->Result<String,String>{let time=DateTime::parse_from_rfc3339(at).map_err(|_|"提醒时间无效")?;Ok(format!("{id}:{}",time.timestamp_millis()))}
pub fn text<'a>(record: &'a Value, field: &str) -> &'a str { record.get(field).and_then(Value::as_str).unwrap_or("") }
pub fn optional_id<'a>(record: &'a Value, field: &str) -> Option<&'a str> { record.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()) }
pub fn valid_id(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok() }
pub fn normalize(record:&mut Value){
    if text(record,"kind")=="note"{
        if record.get("taskId").is_none(){record["taskId"]=Value::Null;}
        if record.get("noteType").is_none(){record["noteType"]=serde_json::json!("note");}
        if record.get("occurredOn").is_none(){let day=DateTime::parse_from_rfc3339(text(record,"createdAt")).map(|d|d.with_timezone(&Local).format("%Y-%m-%d").to_string()).unwrap_or(Local::now().format("%Y-%m-%d").to_string());record["occurredOn"]=serde_json::json!(day);}
    }
}
pub fn validate(record: &Value) -> Result<(), String> {
    if !record.is_object() { return Err("记录格式无效".into()); }
    if !valid_id(text(record,"id")) { return Err("记录 ID 无效".into()); }
    if text(record,"title").trim().is_empty() || text(record,"title").chars().count()>120 { return Err("标题需要 1–120 个字符".into()); }
    if record.get("archived").and_then(Value::as_bool).is_none() || record.get("version").and_then(Value::as_u64).is_none() { return Err("记录状态无效".into()); }
    for field in ["createdAt","updatedAt"] { DateTime::parse_from_rfc3339(text(record,field)).map_err(|_|"记录时间无效")?; }
    for field in ["projectId","goalId","taskId"] { if let Some(id)=optional_id(record,field) { if !valid_id(id) { return Err("关联 ID 无效".into()); } } }
    for field in ["projectId","goalId","taskId","dueAt","remindAt","completedAt","resolvedAt","date","targetDate","occurredOn","startDate"] {
        if record.get(field).is_some_and(|v|!v.is_null()&&!v.is_string()) {return Err(format!("{field} 字段类型无效"));}
    }
    if ["goal","project","task","habit"].contains(&text(record,"kind")) && record.get("description").and_then(Value::as_str).is_none_or(|s|s.len()>100_000) {return Err("说明字段无效或过长".into());}
    if text(record,"kind")=="note" && record.get("body").and_then(Value::as_str).is_none(){return Err("笔记正文格式无效".into());}
    if ["task","note"].contains(&text(record,"kind")) && record.get("tags").is_none(){return Err("标签字段缺失".into());}
    for field in ["dueAt","remindAt","completedAt","resolvedAt"] { if let Some(v)=record.get(field).and_then(Value::as_str) { DateTime::parse_from_rfc3339(v).map_err(|_|format!("{field} 时间无效"))?; } }
    for field in ["date","targetDate","occurredOn","startDate"] { if let Some(v)=record.get(field).and_then(Value::as_str) { chrono::NaiveDate::parse_from_str(v,"%Y-%m-%d").map_err(|_|"日期无效")?; } }
    match text(record,"kind") {
        "goal" => if !["year","quarter","life"].contains(&text(record,"horizon")) { return Err("目标类型无效".into()); },
        "project" => if !["active","completed"].contains(&text(record,"status")) { return Err("项目状态无效".into()); },
        "task" => {
            if !["todo","doing","done"].contains(&text(record,"status")) || !["low","normal","high"].contains(&text(record,"priority")) || !["none","daily","weekly","monthly"].contains(&text(record,"repeat")) { return Err("任务状态无效".into()); }
            if text(record,"repeat")!="none" && optional_id(record,"dueAt").is_none() { return Err("重复任务需要截止时间".into()); }
        },
        "milestone" => { if text(record,"date").is_empty() || !["personal","work","finance"].contains(&text(record,"category")) { return Err("节点日期或分类无效".into()); } },
        "note" => {
            if text(record,"body").len()>1_000_000 { return Err("笔记超过 1 MB".into()); }
            if record.get("noteType").is_some()&&! ["note","progress","review"].contains(&text(record,"noteType")){return Err("笔记类型无效".into());}
        },
        "issue" => {
            if !["triage","investigating","verifying","resolved"].contains(&text(record,"status"))||!["low","normal","high"].contains(&text(record,"severity")){return Err("问题状态无效".into());}
            for field in ["phenomenon","expected","reproduction","attempts","cause","solution"]{if record.get(field).and_then(Value::as_str).is_none_or(|s|s.len()>100_000){return Err(format!("{field} 内容无效或过长"));}}
            if text(record,"status")=="resolved"&&text(record,"solution").trim().is_empty(){return Err("解决问题前请填写解决方法".into());}
        },
        "journal" => {
            if text(record,"date").is_empty(){return Err("工作记录需要日期".into());}
            for field in ["body","discoveries","blockers","nextSteps"]{if record.get(field).and_then(Value::as_str).is_none_or(|s|s.len()>1_000_000){return Err("工作记录内容无效或过长".into());}}
            for field in ["taskIds","issueIds"]{if record.get(field).and_then(Value::as_array).is_none_or(|ids|ids.len()>10000||ids.iter().any(|id|id.as_str().is_none_or(|id|!valid_id(id)))){return Err("工作记录关联无效".into());}}
        },
        "habit"=>{
            let start=chrono::NaiveDate::parse_from_str(text(record,"startDate"),"%Y-%m-%d").map_err(|_|"习惯开始日期无效")?;
            if start.format("%Y-%m-%d").to_string()!=text(record,"startDate")||start>Local::now().date_naive(){return Err("习惯开始日期无效或晚于今天".into());}
            if !["active","paused"].contains(&text(record,"status")){return Err("习惯状态无效".into());}
            let checks=record["checkIns"].as_object().ok_or("签到记录格式无效")?;
            if checks.len()>50000{return Err("签到记录超过限制".into());}
            for (day,at) in checks{let date=chrono::NaiveDate::parse_from_str(day,"%Y-%m-%d").map_err(|_|"签到日期无效")?;if date.format("%Y-%m-%d").to_string()!=*day||date<start||date>Local::now().date_naive(){return Err("签到日期必须在开始日期和今天之间".into());}DateTime::parse_from_rfc3339(at.as_str().ok_or("签到时间无效")?).map_err(|_|"签到时间无效")?;}
        },
        "sleep"|"weight"=>{
            let date=chrono::NaiveDate::parse_from_str(text(record,"date"),"%Y-%m-%d").map_err(|_|"健康记录日期无效")?;
            if date.format("%Y-%m-%d").to_string()!=text(record,"date")||date>Local::now().date_naive(){return Err("健康记录日期不能晚于今天".into());}
            if record.get("note").and_then(Value::as_str).is_none_or(|s|s.len()>100_000){return Err("健康记录备注无效或过长".into());}
            if text(record,"kind")=="weight"{let kg=record["kilograms"].as_f64().ok_or("体重必须是数字")?;if !kg.is_finite()||kg<=0.0||kg>1000.0{return Err("体重应大于 0、不超过 1000 公斤".into());}}
            else{
                let bed=DateTime::parse_from_rfc3339(text(record,"bedtime")).map_err(|_|"入睡时间无效")?;let wake=DateTime::parse_from_rfc3339(text(record,"wakeTime")).map_err(|_|"起床时间无效")?;
                let minutes=(wake-bed).num_seconds() as f64/60.0;
                if minutes<=0.0||minutes>1440.0||wake.with_timezone(&Local).date_naive()!=date{return Err("睡眠时间顺序、时长或起床日期无效".into());}
                let awake=record["awakeMinutes"].as_u64().ok_or("清醒分钟数需要非负整数")?;if awake as f64>=minutes{return Err("清醒时长不能达到总时长".into());}
                if !["unset","good","normal","poor"].contains(&text(record,"quality")){return Err("睡眠感受无效".into());}
            }
        },
        _ => return Err("不支持的记录类型".into()),
    }
    if let Some(tags)=record.get("tags") { if tags.as_array().is_none_or(|items|items.len()>20 || items.iter().any(|t|t.as_str().is_none_or(|s|s.chars().count()>40))) { return Err("标签格式无效".into()); } }
    Ok(())
}
pub fn next_occurrence(value: &str, repeat: &str, anchor_day: u32) -> Result<String, String> {
    let original=DateTime::parse_from_rfc3339(value).map_err(|_|"重复时间无效")?.with_timezone(&Local);
    let next=match repeat {
        "daily" => original.checked_add_days(chrono::Days::new(1)),
        "weekly" => original.checked_add_days(chrono::Days::new(7)),
        "monthly" => original.with_day(1).and_then(|d|d.checked_add_months(Months::new(1))).and_then(|first| {
            let last=first.checked_add_months(Months::new(1))?.checked_sub_days(chrono::Days::new(1))?.day();
            first.with_day(anchor_day.clamp(1,last))
        }),
        _=>Some(original),
    }.ok_or("无法计算下一次时间")?;
    Ok(next.with_timezone(&Utc).to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn markdown_links_open_only_web_or_mail_urls(){
        assert_eq!(external_url("https://example.com/docs?q=markdown").unwrap(),"https://example.com/docs?q=markdown");
        assert!(external_url("mailto:reader@example.com").is_ok());
        for value in ["javascript:alert(1)","file:///C:/Windows/System32/cmd.exe","data:text/html,test","shell:AppsFolder","https://user:password@example.com"]{assert!(external_url(value).is_err());}
    }
    #[test] fn reminder_deduplication_uses_the_instant_not_time_format() {
        assert_eq!(reminder_token("task","2026-10-02T09:00:00+08:00").unwrap(),reminder_token("task","2026-10-02T01:00:00.000Z").unwrap());
        assert_ne!(reminder_token("task","2026-10-02T01:00:00Z").unwrap(),reminder_token("task","2026-10-02T01:00:01Z").unwrap());
    }
    #[test] fn monthly_clamps_then_keeps_anchor() {
        let feb=next_occurrence("2026-01-31T01:00:00+08:00","monthly",31).unwrap();
        assert_eq!(DateTime::parse_from_rfc3339(&feb).unwrap().with_timezone(&Local).day(),28);
        let mar=next_occurrence(&feb,"monthly",31).unwrap();
        assert_eq!(DateTime::parse_from_rfc3339(&mar).unwrap().with_timezone(&Local).day(),31);
    }
}
