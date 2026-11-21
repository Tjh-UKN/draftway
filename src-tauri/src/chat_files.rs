use super::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashSet, VecDeque}, fs::{self, File}, io::Read, path::Path};

const FILE_LIMIT: usize = 10;
const TEXT_LIMIT: usize = 256 * 1024;
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const IMAGE_TOTAL_LIMIT: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Reference,
    Attachment,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatFile {
    kind: FileKind,
    path: String,
    pub(super) name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSuggestion {
    path: String,
    name: String,
    relative_path: String,
}

struct Image {
    path: String,
    mime: &'static str,
    bytes: Vec<u8>,
}

pub struct PreparedMessage {
    pub files: Vec<ChatFile>,
    pub text: String,
    images: Vec<Image>,
}

impl PreparedMessage {
    pub fn codex_input(&self) -> Vec<Value> {
        let mut input = Vec::new();
        if !self.text.trim().is_empty() {input.push(json!({"type":"text","text":self.text}));}
        input.extend(self.images.iter().map(|image| json!({"type":"localImage","path":image.path})));
        input
    }

    pub fn claude_content(&self) -> Value {
        if self.images.is_empty() {return json!(self.text);}
        let mut content = Vec::new();
        if !self.text.trim().is_empty() {content.push(json!({"type":"text","text":self.text}));}
        content.extend(self.images.iter().map(|image| json!({"type":"image","source":{
            "type":"base64","media_type":image.mime,"data":STANDARD.encode(&image.bytes)
        }})));
        json!(content)
    }

    pub fn pi_prompt(&self) -> Value {
        let mut prompt = json!({"message":self.text});
        if !self.images.is_empty() {
            prompt["images"] = json!(self.images.iter().map(|image|
                json!({"type":"image","mimeType":image.mime,"data":STANDARD.encode(&image.bytes)})
            ).collect::<Vec<_>>());
        }
        prompt
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {Some("image/png")}
    else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {Some("image/jpeg")}
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {Some("image/gif")}
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {Some("image/webp")}
    else {None}
}

pub fn prepare(cwd: &Path, text: &str, selected: Vec<ChatFile>) -> Result<PreparedMessage> {
    if selected.len() > FILE_LIMIT {return Err("单条消息最多可带 10 个文件".into());}
    let mut message = PreparedMessage {files: Vec::new(), text: text.into(), images: Vec::new()};
    let mut references = Vec::new();
    let mut text_total = 0;
    let mut image_total = 0;
    let mut seen = HashSet::new();
    let root = if selected.iter().any(|file| file.kind == FileKind::Reference) {
        Some(cwd.canonicalize().map_err(|_| "会话工作目录已不可用")?)
    } else {None};
    for file in selected {
        let path = Path::new(&file.path);
        if !path.is_absolute() || file.path.chars().count() > 32767 {
            return Err("文件路径无效，请重新选择".into());
        }
        let path = path.canonicalize().map_err(|_| format!("文件已移动或无法读取：{}", file.name))?;
        if !path.is_file() {return Err("请选择普通文件".into());}
        if !seen.insert((file.kind, path.clone())) {continue;}
        let name = path.file_name().and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty() && !name.chars().any(char::is_control))
            .ok_or("文件名无法读取")?.to_owned();
        match file.kind {
            FileKind::Reference => {
                let relative = path.strip_prefix(root.as_ref().ok_or("会话没有工作目录")?)
                    .map_err(|_| "引用文件必须位于当前会话的工作目录中")?;
                references.push(relative.to_string_lossy().replace('\\', "/"));
            }
            FileKind::Attachment => {
                let mut reader = File::open(&path).map_err(|_| format!("无法读取附件：{name}"))?;
                let mut header = [0_u8; 12];
                let count = reader.read(&mut header).map_err(|_| format!("无法读取附件：{name}"))?;
                let mime = image_mime(&header[..count]);
                let limit = if mime.is_some() {IMAGE_LIMIT.min(IMAGE_TOTAL_LIMIT - image_total)} else {TEXT_LIMIT - text_total};
                let mut bytes = header[..count].to_vec();
                if bytes.len() <= limit {
                    reader.take((limit + 1 - bytes.len()) as u64).read_to_end(&mut bytes)
                        .map_err(|_| format!("无法读取附件：{name}"))?;
                }
                if bytes.len() > limit {return Err(format!("附件超过大小限制：{name}")); }
                if let Some(mime) = mime {
                    image_total += bytes.len();
                    message.images.push(Image {path: crate::resources::display_path(&path), mime, bytes});
                } else {
                    let body = std::str::from_utf8(&bytes).ok().filter(|text| !text.contains('\0'))
                        .ok_or_else(|| format!("附件仅支持 UTF-8 文本或 PNG、JPEG、GIF、WebP 图片：{name}"))?;
                    text_total += bytes.len();
                    message.text.push_str("\n\n[File attachment (UTF-8)]\n");
                    message.text.push_str(&json!({"name":name,"text":body.trim_start_matches('\u{feff}')}).to_string());
                }
            }
        }
        message.files.push(ChatFile {kind: file.kind, path: crate::resources::display_path(&path), name});
    }
    if !references.is_empty() {
        message.text.push_str("\n\n[Referenced files relative to the working directory]\n");
        message.text.push_str(&json!(references).to_string());
    }
    Ok(message)
}

fn ignored_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name.to_ascii_lowercase().as_str(),
        "node_modules" | "target" | "dist" | "build" | "__pycache__" | "vendor")
}

pub fn suggestions(cwd: &Path, query: &str) -> Result<Vec<FileSuggestion>> {
    if query.len() > 256 {return Ok(Vec::new());}
    let root = cwd.canonicalize().map_err(|_| "会话工作目录已不可用")?;
    let needle = query.trim().replace('\\', "/").to_lowercase();
    let mut pending = VecDeque::from([(root.clone(), 0)]);
    let mut found = Vec::new();
    let mut inspected = 0;
    'directories: while let Some((directory, depth)) = pending.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {continue;};
        for entry in entries.flatten() {
            inspected += 1;
            if inspected > 4000 {break 'directories;}
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored_name(&name) {continue;}
            let Ok(kind) = entry.file_type() else {continue;};
            if kind.is_symlink() {continue;}
            let path = entry.path();
            if kind.is_dir() && depth < 6 {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if entry.metadata().map_or(true, |metadata| metadata.file_attributes() & 0x400 != 0) {continue;}
                }
                pending.push_back((path, depth + 1));
            } else if kind.is_file() {
                let Ok(relative) = path.strip_prefix(&root) else {continue;};
                let relative_path = relative.to_string_lossy().replace('\\', "/");
                if relative_path.to_lowercase().contains(&needle) {
                    let rank = !name.to_lowercase().starts_with(&needle);
                    found.push((rank, FileSuggestion {path: crate::resources::display_path(&path), name, relative_path}));
                }
            }
        }
    }
    found.sort_by(|(a, left), (b, right)| (a, &left.relative_path).cmp(&(b, &right.relative_path)));
    Ok(found.into_iter().take(18).map(|(_, suggestion)| suggestion).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_scoped_references_and_provider_specific_attachments() {
        let root = std::env::temp_dir().join(format!("draftway-chat-files-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::create_dir_all(workspace.join("node_modules")).unwrap();
        let reference = workspace.join("src/main.rs");
        let attachment = root.join("external.txt");
        let image = root.join("sample.png");
        fs::write(&reference, "reference contents").unwrap();
        fs::write(workspace.join("node_modules/main.rs"), "ignored").unwrap();
        fs::write(&attachment, "attachment contents").unwrap();
        fs::write(&image, b"\x89PNG\r\n\x1a\nsynthetic").unwrap();
        let file = |kind, path: &Path| ChatFile {kind,path:path.to_string_lossy().into_owned(),name:"file".into()};
        let prepared = prepare(&workspace, "Review", vec![
            file(FileKind::Reference, &reference), file(FileKind::Attachment, &attachment),
            file(FileKind::Attachment, &image),
        ]).unwrap();
        assert!(prepared.text.contains("src/main.rs"));
        assert!(!prepared.text.contains("reference contents"));
        assert!(prepared.text.contains("attachment contents"));
        assert_eq!(prepared.codex_input()[1]["type"], "localImage");
        assert_eq!(prepared.claude_content()[1]["source"]["media_type"], "image/png");
        assert_eq!(prepared.pi_prompt()["images"][0]["mimeType"], "image/png");
        assert!(prepare(&workspace, "Review", vec![file(FileKind::Reference, &attachment)]).is_err());
        assert_eq!(suggestions(&workspace, "main").unwrap().len(), 1);
    }
}
