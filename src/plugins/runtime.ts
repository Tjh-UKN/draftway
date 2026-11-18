import type {PluginPackage} from './manifest';

export interface PluginNote {id:string;title:string;text:string;revision:number;selection:{from:number;to:number;text:string}}
export interface NotePluginHost {read:()=>PluginNote;edit:(from:number,to:number,text:string)=>void;select:(from:number,to:number)=>void;readOnly:()=>boolean}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function notePluginCall(plugin:PluginPackage,host:NotePluginHost,method:string,params:unknown):unknown{
  if(!plugin.enabled)throw Error('插件已停用');
  const capability=method==='note.edit'?'note.edit':'note.read';
  if(!['note.read','note.edit','note.select'].includes(method)||!plugin.manifest.capabilities.includes(capability))throw Error('插件没有此操作的权限');
  if(method==='note.read'){if(params!==undefined&&(!plain(params)||Object.keys(params).length))throw Error('读取参数无效');return host.read();}
  const allowed=method==='note.edit'?['from','to','text','revision']:['from','to'];
  if(!plain(params)||Object.keys(params).some(key=>!allowed.includes(key)))throw Error('编辑参数无效');
  const note=host.read();const from=params.from,to=params.to;
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||Number(from)<0||Number(to)<Number(from)||Number(to)>note.text.length)throw Error('文字范围无效');
  if(method==='note.select'){host.select(Number(from),Number(to));return null;}
  if(host.readOnly())throw Error('当前笔记只读');
  if(params.revision!==note.revision)throw Error('笔记已更新，请重新读取后再操作');
  if(typeof params.text!=='string'||new TextEncoder().encode(note.text.slice(0,Number(from))+params.text+note.text.slice(Number(to))).length>1_000_000)throw Error('笔记内容无效或超过 1 MB');
  host.edit(Number(from),Number(to),params.text);return null;
}

export function pluginPeer(port:MessagePort,call:(method:string,params:unknown)=>Promise<unknown>|unknown){
  let stopped=false;let connected=false;let resolveReady!:()=>void;let rejectReady!:(error:Error)=>void;let sequence=0;let windowAt=Date.now();let requests=0;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void ready.catch(()=>{});
  const startup=setTimeout(()=>rejectReady(Error('插件未能启动')),8000);
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  port.onmessage=event=>{
    if(stopped||!plain(event.data))return;const message=event.data;
    if(message.type==='ready'){clearTimeout(startup);if(typeof message.error==='string'){rejectReady(Error(message.error));return;}connected=true;resolveReady();return;}
    if(message.type==='command.result'&&Number.isSafeInteger(message.id)){const entry=pending.get(Number(message.id));if(entry){clearTimeout(entry.timer);pending.delete(Number(message.id));if(message.error)entry.reject(Error(String(message.error)));else entry.resolve(message.value);}return;}
    if(message.type!=='call'||!Number.isSafeInteger(message.id)||typeof message.method!=='string')return;
    if(Date.now()-windowAt>1000){windowAt=Date.now();requests=0;}
    const reply=(result:Record<string,unknown>)=>{if(!stopped)port.postMessage({type:'response',id:message.id,...result});};
    if(++requests>60){reply({error:'插件请求过于频繁'});return;}
    void Promise.resolve().then(()=>call(String(message.method),message.params)).then(value=>reply({value}),error=>reply({error:error instanceof Error?error.message:String(error)}));
  };port.start();
  return {
    ready,
    async command(command:string){await ready;if(stopped)throw Error('插件已停止');return new Promise<unknown>((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('插件命令超时'));},10000);pending.set(id,{resolve,reject,timer});port.postMessage({type:'command',id,command});});},
    notify(name:string){if(!stopped&&connected)port.postMessage({type:'event',name});},
    dispose(){if(stopped)return;stopped=true;clearTimeout(startup);rejectReady(Error('插件已停止'));for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('插件已停止'));}pending.clear();port.onmessage=null;port.close();},
  };
}
