import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
const root=process.cwd();const env={...process.env};const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'Path';
if(existsSync(path.join(root,'.tools/cargo/bin/cargo.exe'))){env.CARGO_HOME=path.join(root,'.tools/cargo');env.RUSTUP_HOME=path.join(root,'.tools/rustup');env[key]=path.join(env.CARGO_HOME,'bin')+path.delimiter+env[key];}
env.TAURI_CONFIG=readFileSync(path.join(root,'scripts/qa-config.json'),'utf8');
const run=(exe,args)=>new Promise((resolve,reject)=>{const child=spawn(exe,args,{env,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${exe} exited with ${code}`)));});
try{await run('cargo',['build','--manifest-path','src-tauri/Cargo.toml','--features','custom-protocol']);await run(process.execPath,['scripts/check-native.cjs']);}catch(e){console.error(e);process.exit(1);}
