use std::{process::{Child, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

#[derive(Clone)]
pub struct GroupTracker {inner: Arc<GroupState>}
struct GroupState {token: Option<String>, process: Mutex<Option<(String, String, u32)>>, stopped: AtomicBool, #[cfg(unix)] local_group: Mutex<Option<u32>>}
impl GroupTracker {
    pub fn new(token: Option<String>) -> Self {Self {inner: Arc::new(GroupState {token, process: Mutex::new(None), stopped: AtomicBool::new(false), #[cfg(unix)] local_group: Mutex::new(None)})}}
    pub fn observe(&self, line: &str) {
        let Some(raw) = line.strip_prefix("__NORTHSTAR_PROCESS__:") else {return;};
        let values: Vec<_> = raw.split(':').collect();
        if values.len() != 3 || values[0].is_empty() || values[0].len() > 128 || values[1].is_empty() || values[1].len() > 64 {return;}
        let Ok(pid) = values[2].parse::<u32>() else {return;}; if pid < 2 {return;}
        let mut process = self.inner.process.lock().unwrap(); if process.is_some() {return;}
        *process = Some((values[0].into(), values[1].into(), pid)); drop(process);
        if self.inner.stopped.load(Ordering::SeqCst) {self.cleanup();}
    }
    pub fn stop(&self) {
        if !self.inner.stopped.swap(true, Ordering::SeqCst) {self.cleanup();}
    }
    fn cleanup(&self) {
        // A local executor runs as the leader of its own process group; stop() runs before the leader is reaped,
        // so the group id still belongs to it and every tool process it started goes with it.
        #[cfg(unix)] if let Some(group) = self.inner.local_group.lock().unwrap().take() {
            if let Ok(group) = i32::try_from(group) {if group > 1 {unsafe {libc::killpg(group, libc::SIGKILL);}}}
        }
        let Some(token) = &self.inner.token else {return;};
        let Some((distro, user, pid)) = self.inner.process.lock().unwrap().clone() else {return;};
        // Verify the per-launch token before killing the owned Linux process group.
        let script = r#"if [ -r "/proc/$1/environ" ] && tr '\000' '\n' < "/proc/$1/environ" | grep -Fxq "NORTHSTAR_SESSION_TOKEN=$2"; then kill -KILL -- "-$1"; fi"#;
        let mut command = Command::new("wsl.exe");
        command.args(["-d", &distro, "--user", &user, "--exec", "/bin/bash", "-c", script, "northstar-cleanup", &pid.to_string(), token]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)] {use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);}
        if let Ok(mut child) = command.spawn() {let start = Instant::now(); while child.try_wait().ok().flatten().is_none() {if start.elapsed() > Duration::from_secs(3) {let _ = child.kill(); break;} std::thread::sleep(Duration::from_millis(30));} let _ = child.wait();}
    }
}

pub struct Ownership {#[cfg(windows)] job: isize, pub group: GroupTracker}
impl Ownership {
    pub fn attach(child: &Child, token: Option<String>) -> Result<Self, String> {
        #[cfg(windows)] {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::{CloseHandle, HANDLE}, System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE}};
            unsafe {
                let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default(); info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let result = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32).and_then(|_| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())));
                if let Err(error) = result {let _ = CloseHandle(job); return Err(format!("无法托管执行器进程：{error}"));}
                return Ok(Self {job: job.0 as isize, group: GroupTracker::new(token)});
            }
        }
        #[cfg(not(windows))] {
            let group = GroupTracker::new(token);
            #[cfg(unix)] {*group.inner.local_group.lock().unwrap() = Some(child.id());}
            Ok(Self {group})
        }
    }
    #[cfg(test)]
    pub fn empty() -> Self {Self {#[cfg(windows)] job: 0, group: GroupTracker::new(None)}}
}
impl Drop for Ownership {
    fn drop(&mut self) {
        self.group.stop();
        #[cfg(windows)] if self.job != 0 {unsafe {let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(self.job as *mut _));}}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_unrelated_or_malformed_process_markers_and_uses_only_first_owner() {
        let tracker = GroupTracker::new(None);
        for line in ["hello", "__NORTHSTAR_PROCESS__:Ubuntu:tjh:-1", "__NORTHSTAR_PROCESS__:Ubuntu:tjh:1", "__NORTHSTAR_PROCESS__:Ubuntu:tjh:1;bad"] {tracker.observe(line);}
        assert!(tracker.inner.process.lock().unwrap().is_none());
        tracker.observe("__NORTHSTAR_PROCESS__:Ubuntu:tjh:123"); tracker.observe("__NORTHSTAR_PROCESS__:Ubuntu:tjh:456"); assert_eq!(tracker.inner.process.lock().unwrap().as_ref().unwrap().2,123);
    }
    #[cfg(unix)]
    #[test]
    fn stopping_a_local_executor_also_ends_the_tools_it_started() {
        use std::{io::{BufRead, BufReader}, os::unix::process::CommandExt};
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & echo $!; wait"]).stdout(Stdio::piped()).process_group(0);
        let mut child = command.spawn().unwrap();
        let mut line = String::new(); BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let tool: i32 = line.trim().parse().unwrap();
        let ownership = Ownership::attach(&child, None).unwrap();
        assert_eq!(unsafe {libc::kill(tool, 0)}, 0);
        drop(ownership); child.wait().unwrap();
        let start = Instant::now();
        while unsafe {libc::kill(tool, 0)} == 0 && start.elapsed() < Duration::from_secs(3) {std::thread::sleep(Duration::from_millis(20));}
        assert_ne!(unsafe {libc::kill(tool, 0)}, 0, "background tool process survived its executor");
    }
}
