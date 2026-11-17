use crate::{store::{Store, Result, error}, workspace_state};
use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct TextFile {pub path: String, pub name: String, pub text: String}
pub fn display_path(path: &Path) -> String {let value=path.to_string_lossy();if let Some(unc)=value.strip_prefix(r"\\?\UNC\") {format!(r"\\{unc}")}else{value.strip_prefix(r"\\?\").unwrap_or(&value).into()}}
pub fn space(store: &Store, id: &str) -> Result<Value> {
    let mut space=workspace_state::load(store)?.and_then(|value|value["spaces"].as_array()?.iter().find(|w|w["id"]==id).cloned()).ok_or("工作区不存在")?;
    space["_ownedRoot"]=Value::Null;
    if !id.is_empty()&&id.len()<=100&&id.bytes().all(|b|b.is_ascii_alphanumeric()||[b'-',b'_'].contains(&b)) {if let (Ok(root),Ok(owned))=(store.root.canonicalize(),store.root.join("agents/workspaces").join(id).canonicalize()){if owned.is_dir()&&owned.starts_with(root){space["_ownedRoot"]=serde_json::json!(display_path(&owned));}}}
    Ok(space)
}
fn roots(space: &Value) -> Vec<PathBuf> {
    space["cwd"].as_str().map(PathBuf::from).into_iter().chain(space["_ownedRoot"].as_str().map(PathBuf::from)).chain(space["materialRoots"].as_array().into_iter().flatten().filter_map(|root|root["path"].as_str().map(PathBuf::from))).filter_map(|path|path.canonicalize().ok()).filter(|path|path.is_dir()).collect()
}
pub fn scoped(space: &Value, path: &Path) -> Result<PathBuf> {
    let file=path.canonicalize().map_err(|e|format!("文件不可用：{e}"))?;
    if !roots(space).iter().any(|root|file.starts_with(root)) {return Err("材料不在工作目录或材料目录内，请在「自定工作区」添加它所在的目录。".into());}
    Ok(file)
}
pub fn target(space: &Value, value: &str) -> Result<PathBuf> {
    if value.starts_with("obsidian:") {
        let url=url::Url::parse(value).map_err(error)?;
        if url.host_str()!=Some("open") {return Err("仅支持 Obsidian 打开笔记链接".into());}
        let params: std::collections::HashMap<_,_>=url.query_pairs().into_owned().collect();
        if let Some(path)=params.get("path") {return scoped(space,Path::new(path));}
        let vault=params.get("vault").ok_or("Obsidian 链接缺少库名")?;
        let matches:Vec<_>=space["materialRoots"].as_array().into_iter().flatten().filter(|root|root["name"].as_str()==Some(vault)).collect();
        if matches.len()>1 {return Err("存在多个同名材料目录，请在「自定工作区」修改名称后再打开。".into());}
        let root=matches.first().and_then(|root|root["path"].as_str()).ok_or("请在「自定工作区」添加与 Obsidian 库同名的材料目录。")?;
        let file=params.get("file").ok_or("请选择具体的 Obsidian 笔记")?.split('#').next().unwrap_or("");
        let mut path=PathBuf::from(root).join(file);if path.extension().is_none() {path.set_extension("md");}
        scoped(space,&path)
    } else if value.starts_with("file:") {scoped(space,&url::Url::parse(value).map_err(error)?.to_file_path().map_err(|_|"文件链接无效")?)}
    else {scoped(space,Path::new(value))}
}
fn read(path: PathBuf) -> Result<TextFile> {
    if path.is_dir(){return Ok(TextFile{path:display_path(&path),name:path.file_name().unwrap_or_default().to_string_lossy().into(),text:format!("文件夹位置：{}\n可使用原应用打开。",display_path(&path))});}
    let handle=fs::File::open(&path).map_err(error)?;let mut bytes=Vec::new();handle.take(1_048_577).read_to_end(&mut bytes).map_err(error)?;
    if bytes.len()>1_048_576 || bytes.contains(&0) {return Err("内置阅读支持 1 MB 以内的 UTF-8 文本文件，请用原应用打开其他格式。".into());}
    let text=String::from_utf8(bytes).map_err(|_|"文件不是 UTF-8 文本，请用原应用打开。")?;
    Ok(TextFile{path:display_path(&path),name:path.file_name().unwrap_or_default().to_string_lossy().into(),text})
}
pub fn material(store: &Store, workspace: &str, node: &str, id: &str) -> Result<(Value, PathBuf)> {
    let space=space(store,workspace)?;
    let node=space["nodes"].as_array().into_iter().flatten().find(|n|n["id"]==node).ok_or("节点不存在")?;
    let value=node["materials"].as_array().into_iter().flatten().find(|m|m["id"]==id).and_then(|m|m["target"].as_str()).or_else(||if id=="legacy-reference" {node["reference"].as_str()} else {None}).ok_or("材料关联不存在")?;
    let path=target(&space,value)?;Ok((space,path))
}
pub fn read_material(store: &Store, workspace: &str, node: &str, id: &str) -> Result<TextFile> {let (_,path)=material(store,workspace,node,id)?;read(path)}
pub fn workspace_html(store:&Store,workspace:&str,value:&str)->Result<TextFile>{
    if value.len()>32768||value.chars().any(char::is_control){return Err("文件路径无效".into());}
    let space=space(store,workspace)?;let path=target(&space,value)?;
    if !path.extension().and_then(|ext|ext.to_str()).is_some_and(|ext|["html","htm"].contains(&ext.to_ascii_lowercase().as_str())){return Err("内置浏览器预览支持 HTML 文件".into());}
    let file=read(path)?;if file.text.len()>1_000_000{return Err("HTML 超过 1 MB".into());}Ok(file)
}
pub fn session_target(store:&Store,workspace:&str,cwd:&str,value:&str)->Result<PathBuf>{
    if value.len()>32768||value.chars().any(char::is_control){return Err("文件路径无效".into());}
    let mut space=space(store,workspace)?;
    if !space["materialRoots"].is_array(){space["materialRoots"]=serde_json::json!([]);}
    space["materialRoots"].as_array_mut().unwrap().push(serde_json::json!({"path":cwd}));
    let requested=if value.starts_with("file:"){url::Url::parse(value).map_err(error)?.to_file_path().map_err(|_|"文件链接无效")?}else{PathBuf::from(value)};
    #[cfg(windows)] if requested.to_string_lossy().get(2..).is_some_and(|tail|tail.contains(':')){return Err("文件路径无效".into());}
    let path=scoped(&space,&if requested.is_absolute(){requested}else{Path::new(cwd).join(requested)})?;
    let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !path.is_dir()&&!["html","htm","md","markdown","txt","pdf","docx","xlsx","pptx","png","jpg","jpeg","gif","webp","svg","csv","log","json","yaml","yml","toml","excalidraw","mindmap"].contains(&ext.as_str()){
        return Err("此文件类型请从资源管理器打开".into());
    }
    Ok(path)
}
fn git(directory: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output_path=std::env::temp_dir().join(format!("northstar-git-{}",uuid::Uuid::new_v4()));let output=fs::File::create(&output_path).map_err(error)?;
    let mut command=Command::new("git");command.current_dir(directory).env("GIT_OPTIONAL_LOCKS","0").args(["--no-pager","-c","core.quotepath=false"]).args(args).stdin(Stdio::null()).stdout(output).stderr(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let result=(|| {let mut child=command.spawn().map_err(error)?;let deadline=Instant::now()+Duration::from_secs(8);loop {if let Some(status)=child.try_wait().map_err(error)? {if !status.success() {return Err("Git 无法读取该仓库或文件版本".into());}break;}if Instant::now()>deadline {let _=child.kill();let _=child.wait();return Err("Git 读取超时".into());}std::thread::sleep(Duration::from_millis(20));}
        if fs::metadata(&output_path).map_err(error)?.len()>2_000_000 {return Err("差异超过 2 MB，请缩小审查范围".into());}fs::read(&output_path).map_err(error)})();let _=fs::remove_file(output_path);result
}
pub fn git_files(store: &Store, workspace: &str) -> Result<Vec<String>> {
    let space=space(store,workspace)?;let root=PathBuf::from(space["cwd"].as_str().or(space["_ownedRoot"].as_str()).ok_or("请先为工作区选择 Git 工作目录")?);
    let bytes=git(&root,&["status","--porcelain=v1","-z","--no-renames","--untracked-files=all","--","."])?;
    let mut files=Vec::new();let mut rows=bytes.split(|b|*b==0).filter(|r|!r.is_empty());while let Some(row)=rows.next() {if row.len()<4 {continue;}let name=std::str::from_utf8(&row[3..]).map_err(|_|"文件名不是 UTF-8")?.to_string();files.push(name);if row[..2].contains(&b'R') || row[..2].contains(&b'C') {rows.next();}}
    Ok(files)
}
pub fn git_diff(store: &Store, workspace: &str, file: &str) -> Result<Vec<TextFile>> {
    if file.starts_with('-') || file.contains('\0') || Path::new(file).is_absolute() || Path::new(file).components().any(|c|matches!(c,std::path::Component::ParentDir|std::path::Component::Prefix(_))) {return Err("Git 文件路径无效".into());}
    if !git_files(store,workspace)?.iter().any(|name|name==file) {return Err("此文件不在当前改动列表内".into());}
    let space=space(store,workspace)?;let directory=PathBuf::from(space["cwd"].as_str().or(space["_ownedRoot"].as_str()).ok_or("工作目录不存在")?);let top=String::from_utf8(git(&directory,&["rev-parse","--show-toplevel"])?).map_err(error)?;let top=PathBuf::from(top.trim());
    // status paths are repository-relative, including when cwd is a subdirectory.
    let path=top.join(file);let current=if path.exists() {read(scoped(&space,&path)?)?.text}else {scoped(&space,path.parent().ok_or("文件目录无效")?)?;String::new()};
    let has_head=git(&top,&["rev-parse","--verify","HEAD"]).is_ok();
    let tracked=has_head && !git(&top,&["ls-tree","--name-only","HEAD","--",file])?.is_empty();
    let base=if tracked {String::from_utf8(git(&top,&["show",&format!("HEAD:{file}")])?).map_err(error)?}else {String::new()};
    if base.contains('\0') || base.len()>262144 || current.len()>262144 || base.lines().count()>5000 || current.lines().count()>5000 {return Err("当前差异预览支持每个版本 256 KB、5000 行以内的文本文件".into());}
    Ok(vec![TextFile{path:file.into(),name:format!("HEAD · {file}"),text:base},TextFile{path:file.into(),name:format!("工作目录 · {file}"),text:current}])
}
#[cfg(test)]
mod tests {
    use super::*;use serde_json::json;
    #[test]
    fn session_reports_open_without_node_materials_and_stay_within_their_roots(){
        let root=std::env::temp_dir().join(format!("northstar-session-path-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        let owned=root.join("agents/workspaces/w");fs::create_dir_all(&owned).unwrap();let report=owned.join("PR 检视报告.html");fs::write(&report,"<!doctype html><title>Report</title>").unwrap();
        workspace_state::save(&store,&json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"root"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]})).unwrap();
        assert_eq!(session_target(&store,"w",&owned.to_string_lossy(),&report.to_string_lossy()).unwrap(),report.canonicalize().unwrap());
        assert_eq!(session_target(&store,"w",&owned.to_string_lossy(),"PR 检视报告.html").unwrap(),report.canonicalize().unwrap());
        let uri=url::Url::from_file_path(&report).unwrap();assert!(session_target(&store,"w",&owned.to_string_lossy(),uri.as_str()).is_ok());
        let page=workspace_html(&store,"w",&report.to_string_lossy()).unwrap();assert_eq!(page.name,"PR 检视报告.html");assert!(page.text.contains("<!doctype html>"));
        assert!(workspace_html(&store,"w",uri.as_str()).is_ok());
        fs::write(root.join("outside.html"),"Outside").unwrap();assert!(session_target(&store,"w",&owned.to_string_lossy(),"../../../outside.html").is_err());
        assert!(session_target(&store,"w",&owned.to_string_lossy(),&root.join("outside.html").to_string_lossy()).is_err());
        assert!(workspace_html(&store,"w",&root.join("outside.html").to_string_lossy()).is_err());
        fs::write(owned.join("run.cmd"),"echo not run").unwrap();assert!(session_target(&store,"w",&owned.to_string_lossy(),"run.cmd").is_err());
        assert!(workspace_html(&store,"w",&owned.join("run.cmd").to_string_lossy()).is_err());
        assert!(session_target(&store,"w",&owned.to_string_lossy(),"missing.html").is_err());
    }
    #[test]
    fn default_workspace_materials_are_available_without_granting_neighbour_workspaces(){let root=std::env::temp_dir().join(format!("northstar-owned-material-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();let owned=root.join("agents/workspaces/w");let other=root.join("agents/workspaces/other");fs::create_dir_all(&owned).unwrap();fs::create_dir_all(&other).unwrap();fs::write(owned.join("note.md"),"Own").unwrap();fs::write(other.join("note.md"),"Other").unwrap();workspace_state::save(&store,&serde_json::json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","nodes":[{"id":"n"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]})).unwrap();let space=space(&store,"w").unwrap();assert_eq!(read(target(&space,&owned.join("note.md").to_string_lossy()).unwrap()).unwrap().text,"Own");assert!(target(&space,&other.join("note.md").to_string_lossy()).is_err());assert!(read(target(&space,&owned.to_string_lossy()).unwrap()).unwrap().text.contains("文件夹位置"));}
    #[test]
    fn scopes_canonical_paths_and_resolves_vault_notes_without_traversal() {
        let root=std::env::temp_dir().join(format!("northstar-resource-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(root.join("vault")).unwrap();fs::write(root.join("vault/note.md"),"Note").unwrap();fs::write(root.join("private.txt"),"Private").unwrap();let space=json!({"materialRoots":[{"name":"Knowledge","path":root.join("vault")} ]});
        assert_eq!(read(target(&space,"obsidian://open?vault=Knowledge&file=note").unwrap()).unwrap().text,"Note");assert!(target(&space,&root.join("private.txt").to_string_lossy()).is_err());assert!(target(&space,"obsidian://open?vault=Knowledge&file=../private.txt").is_err());
        let duplicate=json!({"materialRoots":[{"name":"Knowledge","path":root.join("vault")},{"name":"Knowledge","path":root}]});assert!(target(&duplicate,"obsidian://open?vault=Knowledge&file=note").is_err());
    }
    #[test]
    fn canonical_reference_identity_and_child_tasks_remain_available_to_agents() {
        let root=std::env::temp_dir().join(format!("northstar-primitives-test-{}",uuid::Uuid::new_v4()));let store=Store::open(root.clone()).unwrap();
        fs::write(root.join("canonical.md"),"Canonical material").unwrap();fs::write(root.join("old.md"),"Old material").unwrap();
        let mut shell=serde_json::json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"Work","cwd":root,"nodes":[{"id":"n","title":"Parent","body":"Goal","task":true,"progress":50,"reference":root.join("old.md"),"materials":[{"id":"legacy-reference","title":"Note","target":root.join("canonical.md")}]},{"id":"child","parentId":"n","title":"A real child task","body":"","task":true,"progress":100}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]});
        workspace_state::save(&store,&shell).unwrap();assert_eq!(read_material(&store,"w","n","legacy-reference").unwrap().text,"Canonical material");
        shell["spaces"][0]["nodes"][0]["materials"]=serde_json::json!([]);workspace_state::save(&store,&shell).unwrap();assert_eq!(read_material(&store,"w","n","legacy-reference").unwrap().text,"Old material");
    }
    #[test]
    fn real_git_diff_handles_modified_untracked_deleted_and_subdirectory_scope() {
        let root=std::env::temp_dir().join(format!("northstar-git-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(root.join("sub")).unwrap();git(&root,&["init","--quiet"]).unwrap();
        fs::write(root.join("sub/code.txt"),"old\n").unwrap();fs::write(root.join("removed.txt"),"deleted\n").unwrap();git(&root,&["add","."]).unwrap();git(&root,&["-c","user.name=Northstar test","-c","user.email=test@localhost","commit","-qm","fixture"]).unwrap();
        fs::write(root.join("sub/code.txt"),"new\n").unwrap();fs::write(root.join("new.txt"),"untracked\n").unwrap();fs::remove_file(root.join("removed.txt")).unwrap();
        let store=Store::open(root.join("data")).unwrap();let mut shell=serde_json::json!({"version":2,"activeId":"w","spaces":[{"id":"w","name":"w","cwd":root,"nodes":[{"id":"n"}],"dock":{}}],"sessions":[],"runs":[],"artifacts":[],"notices":[]});workspace_state::save(&store,&shell).unwrap();
        let diff=git_diff(&store,"w","sub/code.txt").unwrap();assert_eq!(diff[0].text,"old\n");assert_eq!(diff[1].text,"new\n");assert!(git_diff(&store,"w","new.txt").unwrap()[0].text.is_empty());assert_eq!(git_diff(&store,"w","removed.txt").unwrap()[0].text,"deleted\n");assert!(git_diff(&store,"w","../private").is_err());
        shell["spaces"][0]["cwd"]=serde_json::json!(root.join("sub"));workspace_state::save(&store,&shell).unwrap();assert_eq!(git_files(&store,"w").unwrap(),vec!["sub/code.txt"]);
    }
}
