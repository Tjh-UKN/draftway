import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const server = __NORTHSTAR_SERVER__;
const tools = __NORTHSTAR_TOOLS__;
function callTool(name, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let buffer = ''; let result; let error = ''; let size = 0;
    const abort = () => {child.kill(); reject(new Error('Workspace tool cancelled'));};
    const timer = setTimeout(() => {child.kill(); reject(new Error('Workspace tool timed out'));}, 15000);
    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {size += Buffer.byteLength(data); if(size > 2_000_000){child.kill();reject(new Error('Workspace result exceeds 2 MB'));return;}buffer += data; let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.id===1){child.stdin.end(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})+'\n');}if(message.id===2)result=message;}catch{}}});
    child.stderr.on('data', data => {if(error.length<1000)error+=data.toString('utf8');});
    child.on('error', reject);
    child.on('close', code => {clearTimeout(timer); signal?.removeEventListener('abort', abort);if(code!==0 || !result || result.error)reject(new Error(result?.error?.message || error || 'Workspace tool connection failed'));else resolve(result.result);});
    child.stdin.on('error', reject);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'northstar-pi',version:'1.0.0'}}})+'\n');
  });
}
export default async function(pi) {
  if (typeof pi.registerMcpServer === 'function') {pi.registerMcpServer('northstar', server);return;}
  const require=createRequire(realpathSync(process.argv[1]));
  const {Type}=await import(pathToFileURL(require.resolve('typebox')).href);
  for(const tool of tools)pi.registerTool({name:tool.name,label:'北极星',description:tool.description,parameters:Type.Unsafe(tool.inputSchema),async execute(_id,params,signal){const result=await callTool(tool.name,params,signal);if(result.isError)throw new Error(result.content.map(part=>part.text||'').join('\n'));return {...result,details:{source:'northstar-workspace'}};}});
}
