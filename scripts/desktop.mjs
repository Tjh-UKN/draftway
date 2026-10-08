import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
const systemPath = env[pathKey] || '';
env[pathKey] = path.dirname(process.execPath) + path.delimiter + systemPath;
if (existsSync(path.join(root, '.tools/cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = path.join(root, '.tools/cargo');
  env.RUSTUP_HOME = path.join(root, '.tools/rustup');
  env[pathKey] = path.join(env.CARGO_HOME, 'bin') + path.delimiter + env[pathKey];
}
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
