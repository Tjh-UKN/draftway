#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {if !northstar_lib::workspace_tools_cli() {northstar_lib::run();}}
