import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

const backend = process.argv[2] || 'codex';
if (!['codex', 'claude', 'pi'].includes(backend)) throw new Error('Expected codex, claude or pi');
const root = process.cwd(); const env = {...process.env, NORTHSTAR_AGENT_BACKEND: backend};
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
if (existsSync(path.join(root, '.tools/cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = path.join(root, '.tools/cargo'); env.RUSTUP_HOME = path.join(root, '.tools/rustup');
  env[pathKey] = path.join(env.CARGO_HOME, 'bin') + path.delimiter + env[pathKey];
}
const child = spawn('cargo', ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'agent_smoke'], {env, stdio: 'inherit', windowsHide: true});
child.on('error', error => {console.error(error); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code ?? 1;});
