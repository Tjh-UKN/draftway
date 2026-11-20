import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd(); const env = {...process.env};
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
if (existsSync(path.join(root, '.tools/cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = path.join(root, '.tools/cargo'); env.RUSTUP_HOME = path.join(root, '.tools/rustup');
  env[pathKey] = path.join(env.CARGO_HOME, 'bin') + path.delimiter + env[pathKey];
}
const assets = path.join(root, 'artifacts/native-browser-smoke-assets'); mkdirSync(assets, {recursive: true});
writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>Browser runtime verification</title><h1>Native browser runtime verification</h1>');
const manifest = path.join(assets, 'browser-smoke.manifest');
writeFileSync(manifest, '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency></assembly>');
const server = createServer((request, response) => {
  response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'"});
  response.end(request.url === '/second.html' ? '<!doctype html><title>Second page</title><h1>Second page</h1>' : '<!doctype html><title>Native browser fixture</title><h1>Native browser fixture</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
env.NORTHSTAR_BROWSER_FIXTURE = `http://127.0.0.1:${server.address().port}/`;
env.NORTHSTAR_BROWSER_REPORT = path.join(root, 'artifacts/native-browser-runtime.json');
env.TAURI_CONFIG = JSON.stringify({identifier: 'com.northstar.browser-smoke', build: {frontendDist: '../artifacts/native-browser-smoke-assets'}, app: {windows: [{label: 'main', title: 'Draftway · 浏览器运行验证', width: 900, height: 650, decorations: true}]}});
const run = (executable, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {env, stdio: 'inherit', windowsHide: true});
  const timeout = setTimeout(() => {child.kill(); reject(new Error(`${executable} timed out`));}, 240000);
  child.on('error', error => {clearTimeout(timeout); reject(error);});
  child.on('exit', code => {clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${executable} exited with ${code}`));});
});
try {
  const headers = env.NORTHSTAR_BROWSER_DASHBOARD ? Object.fromEntries((await fetch(env.NORTHSTAR_BROWSER_DASHBOARD)).headers) : null;
  // Tauri's default Windows manifest is attached to its app binary, not cargo examples.
  await run('cargo', ['rustc', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'browser_smoke', '--features', 'custom-protocol', '--', '-C', 'link-arg=/MANIFEST:EMBED', '-C', `link-arg=/MANIFESTINPUT:${manifest}`]);
  await run(path.join(root, 'src-tauri/target/debug/examples/browser_smoke.exe'), []);
  const report = JSON.parse(readFileSync(env.NORTHSTAR_BROWSER_REPORT, 'utf8'));
  if (!report.passed?.length) throw new Error(report.error || 'Runtime probe did not pass');
  writeFileSync(env.NORTHSTAR_BROWSER_REPORT, JSON.stringify({...report, dashboardHeaders: headers}, null, 2));
  console.log(JSON.stringify({passed: report.passed, report: env.NORTHSTAR_BROWSER_REPORT}));
} finally {server.close();}
