#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
fn main() {if !northstar_lib::workspace_tools_cli() {northstar_lib::run();}}
