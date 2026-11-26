use super::{AgentSession, Message, Run};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    ops::RangeInclusive,
    path::{Path, PathBuf},
};

struct Candidate {
    position: usize,
    block: usize,
    timestamp: u64,
    window: RangeInclusive<u64>,
    source_matches: u32,
    matching_timestamp: bool,
}

fn pair(position: usize, partial: &Message, final_message: &Message, runs: &HashMap<&str, &Run>) -> Option<Candidate> {
    if partial.role != "assistant" || final_message.role != "assistant" ||
        partial.text.is_empty() || partial.text != final_message.text
    {
        return None;
    }
    let (run_id, partial_suffix) = partial.id.rsplit_once("-assistant")?;
    let (final_run_id, final_suffix) = final_message.id.rsplit_once("-assistant")?;
    if run_id != final_run_id {
        return None;
    }
    let run = runs.get(run_id)?;
    if !matches!(run.state.as_str(), "succeeded" | "failed" | "cancelled") {
        return None;
    }
    let window = run.started_at..=run.finished_at?;
    let block = if partial_suffix.is_empty() {
        0
    } else {
        partial_suffix.strip_prefix('-')?.parse::<usize>().ok()?
    };
    let (timestamp, final_block) = final_suffix.strip_prefix('-')?.split_once('-')?;
    let timestamp = timestamp.parse::<u64>().ok()?;
    if final_block.parse::<usize>().ok()? != block || final_message.at != timestamp ||
        partial.at < timestamp || !window.contains(&partial.at) || !window.contains(&timestamp)
    {
        return None;
    }
    Some(Candidate {
        position,
        block,
        timestamp,
        window,
        source_matches: 0,
        matching_timestamp: false,
    })
}

fn owned_pi_source(source: &str, owned_sources: &Path) -> Option<PathBuf> {
    let filename = source.rsplit(['/', '\\']).next()?;
    uuid::Uuid::parse_str(filename.strip_suffix(".jsonl")?).ok()?;
    let directory = owned_sources.canonicalize().ok()?;
    let file = directory.join(filename).canonicalize().ok()?;
    if file.parent() != Some(directory.as_path()) || file.file_name()?.to_str()? != filename {
        return None;
    }
    let native = file.to_str()?;
    let native = native.strip_prefix(r"\\?\").unwrap_or(native);
    if source == native || (cfg!(windows) && source.eq_ignore_ascii_case(native)) {
        return Some(file);
    }
    // On macOS the temp and data directories can be reached through symlinks (/var -> /private/var).
    if cfg!(not(windows)) && Path::new(source).canonicalize().is_ok_and(|resolved| resolved == file) {
        return Some(file);
    }
    // Existing owned Windows sessions can carry the same file name in its WSL mount form.
    if cfg!(windows) {
        let (drive, relative) = native.split_once(":\\")?;
        let wsl = format!("/mnt/{}/{}", drive.to_ascii_lowercase(), relative.replace('\\', "/"));
        if source.eq_ignore_ascii_case(&wsl) {
            return Some(file);
        }
    }
    None
}

fn confirm_source(file: File, messages: &[Message], candidates: &mut [Candidate]) -> Option<()> {
    let mut wanted: HashMap<usize, HashMap<&str, Vec<&mut Candidate>>> = HashMap::new();
    for candidate in candidates {
        let text = messages[candidate.position].text.as_str();
        wanted.entry(candidate.block).or_default().entry(text).or_default().push(candidate);
    }
    let mut lines = BufReader::new(file).lines();
    let header = serde_json::from_str::<Value>(&lines.next()?.ok()?).ok()?;
    if header["type"] != "session" {
        return None;
    }
    for line in lines {
        let event = serde_json::from_str::<Value>(&line.ok()?).ok()?;
        let message = &event["message"];
        if event["type"] != "message" || message["role"] != "assistant" {
            continue;
        }
        for (index, block) in message["content"].as_array().into_iter().flatten().enumerate() {
            if block["type"] != "text" {
                continue;
            }
            let Some(text) = block["text"].as_str() else {continue;};
            let Some(matches) = wanted.get_mut(&index).and_then(|by_text| by_text.get_mut(text)) else {
                continue;
            };
            let timestamp = message["timestamp"].as_u64()?;
            for candidate in matches {
                if candidate.window.contains(&timestamp) {
                    candidate.source_matches = candidate.source_matches.saturating_add(1);
                    candidate.matching_timestamp |= timestamp == candidate.timestamp;
                }
            }
        }
    }
    Some(())
}

pub fn repair(session: &mut AgentSession, owned_sources: &Path) -> bool {
    if session.backend != "pi" {
        return false;
    }
    let runs = session.runs.iter().map(|run| (run.id.as_str(), run)).collect::<HashMap<_, _>>();
    let mut candidates = session.messages.windows(2).enumerate().filter_map(|(position, messages)| {
        pair(position, &messages[0], &messages[1], &runs)
    }).collect::<Vec<_>>();
    if candidates.is_empty() {
        return false;
    }
    let Some(file) = session.source_id.as_deref().and_then(|source| owned_pi_source(source, owned_sources))
        .and_then(|path| File::open(path).ok())
    else {
        return false;
    };
    if confirm_source(file, &session.messages, &mut candidates).is_none() {
        return false;
    }
    let mut remove = HashSet::new();
    let mut aliases = HashMap::new();
    for candidate in candidates {
        if candidate.source_matches == 1 && candidate.matching_timestamp {
            let position = candidate.position;
            remove.insert(position);
            aliases.insert(
                session.messages[position].id.clone(),
                session.messages[position + 1].id.clone(),
            );
        }
    }
    if remove.is_empty() {
        return false;
    }
    let mut index = 0;
    session.messages.retain(|_| {
        let keep = !remove.contains(&index);
        index += 1;
        keep
    });
    for activity in session.runs.iter_mut().flat_map(|run| &mut run.activity) {
        if let Some(canonical) = activity.after_message_id.as_ref().and_then(|id| aliases.get(id)) {
            activity.after_message_id = Some(canonical.clone());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn repair_requires_one_matching_source_message_and_moves_existing_activity_anchor() {
        let directory = std::env::temp_dir().join(format!("draftway-pi-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join(format!("{}.jsonl", uuid::Uuid::new_v4()));
        let mut file = File::create(&source).unwrap();
        writeln!(file, "{}", json!({"type":"session"})).unwrap();
        let entry = |timestamp| json!({"type":"message","message":{
            "role":"assistant","timestamp":timestamp,"content":[{"type":"thinking"},{"type":"text","text":"Same response"}]
        }});
        writeln!(file, "{}", entry(110)).unwrap();
        let mut fixture: AgentSession = serde_json::from_value(json!({
            "id":"s","workspaceId":"w","backend":"pi","title":"Pi","cwd":"",
            "sourceId":source.to_str(),"createdAt":0,"revision":1,"requests":[],
            "messages":[
                {"id":"r-user","role":"user","text":"Prompt","at":100},
                {"id":"r-assistant-1","role":"assistant","text":"Same response","at":130},
                {"id":"r-assistant-110-1","role":"assistant","text":"Same response","at":110}
            ],
            "runs":[{"id":"r","state":"succeeded","startedAt":100,"finishedAt":200,
                "activity":[{"id":"a","kind":"tool","title":"tool","status":"completed","afterMessageId":"r-assistant-1"}]
            }]
        })).unwrap();
        let mut exact = fixture.clone();
        assert!(repair(&mut exact, &directory));
        assert_eq!(exact.messages.len(), 2);
        assert_eq!(exact.messages[1].id, "r-assistant-110-1");
        assert_eq!(exact.runs[0].activity[0].after_message_id.as_deref(), Some("r-assistant-110-1"));
        assert!(!repair(&mut exact, &directory));

        writeln!(file, "{}", entry(150)).unwrap();
        assert!(!repair(&mut fixture, &directory));
        assert_eq!(fixture.messages.len(), 3);
        drop(file);
        std::fs::remove_file(&source).unwrap();
        assert!(!repair(&mut fixture, &directory));
        std::fs::remove_dir(&directory).unwrap();
    }
}
