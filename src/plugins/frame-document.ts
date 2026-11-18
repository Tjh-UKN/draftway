import {pluginPath,type PluginPackage} from './manifest';

// Runs in the opaque frame, never in the workbench's JavaScript context.
function frameSdk(commandIds:string[]){
  let port:MessagePort|null=null;let sequence=0;let connect!:()=>void;let failure='';
  const connected=new Promise<void>(resolve=>connect=resolve);const commands=new Map<string,()=>unknown>();const events=new Map<string,Set<()=>void>>();
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const call=async(method:string,params:unknown={})=>{await connected;return new Promise<unknown>((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('宿主操作超时'));},10000);pending.set(id,{resolve,reject,timer});port!.postMessage({type:'call',id,method,params});});};
  Object.defineProperty(window,'northstar',{value:Object.freeze({api:Object.freeze({major:1,minor:0}),note:Object.freeze({read:()=>call('note.read'),edit:(edit:unknown)=>call('note.edit',edit),select:(range:unknown)=>call('note.select',range)}),storage:Object.freeze({get:(key:string)=>call('storage.get',{key}),set:(key:string,value:unknown)=>call('storage.set',{key,value})}),commands:Object.freeze({register:(id:string,run:()=>unknown)=>{if(!commandIds.includes(id)||commands.has(id)||typeof run!=='function')throw Error('命令未声明或重复注册');commands.set(id,run);}}),on:(name:string,listener:()=>void)=>{if(name!=='note.changed'||typeof listener!=='function')throw Error('事件无效');const listeners=events.get(name)||new Set();events.set(name,listeners);listeners.add(listener);return {dispose:()=>listeners.delete(listener)};}}),writable:false,configurable:false});
  window.addEventListener('error',event=>{failure=event.message;});
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='northstar-plugin-connect'||port||!event.ports[0])return;
    port=event.ports[0];port.onmessage=event=>{const message=event.data;if(!message||typeof message!=='object')return;
      if(message.type==='response'){const entry=pending.get(message.id);if(entry){clearTimeout(entry.timer);pending.delete(message.id);if(message.error)entry.reject(Error(message.error));else entry.resolve(message.value);}}
      if(message.type==='event')for(const listener of events.get(message.name)||[])try{listener();}catch(error){console.error(error);}
      if(message.type==='command'){const run=commands.get(message.command);void Promise.resolve().then(()=>{if(!run)throw Error('插件没有注册此命令');return run();}).then(value=>port?.postMessage({type:'command.result',id:message.id,value}),error=>port?.postMessage({type:'command.result',id:message.id,error:String(error)}));}
    };port.start();connect();port.postMessage({type:'ready',error:failure||(commandIds.some(id=>!commands.has(id))?'插件命令未注册':undefined)});
  });
}
const script=(source:string)=>`<script>${source.replace(/<\/script/gi,'<\\/script')}</script>`;
export function pluginAsset(entry:string,path:string){const clean=path.replace(/^\.\//,'');const resolved=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1)+clean:clean;if(!pluginPath(resolved))throw Error('插件资源路径无效');return resolved;}
export function pluginDocument(plugin:PluginPackage,entry?:string){
  const commands=entry?[]:plugin.manifest.contributes.commands.map(command=>command.id);
  const sdk=script(`(${frameSdk.toString()})(${JSON.stringify(commands)});`);
  const style='<style>:root{color-scheme:light;--northstar-background:#fff;--northstar-foreground:#252525;--northstar-muted:#737373;--northstar-line:#d1d3d7}body{margin:0;background:var(--northstar-background);color:var(--northstar-foreground);font:13px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}</style>';
  if(!entry)return '<!doctype html><meta charset="utf-8">'+sdk+script(plugin.files[plugin.manifest.main!]);
  const document=new DOMParser().parseFromString(plugin.files[entry],'text/html');
  let expanded=new TextEncoder().encode(plugin.files[entry]+sdk+style).length;
  document.querySelectorAll('base,meta[http-equiv]').forEach(element=>element.remove());
  for(const element of document.querySelectorAll('script[src],link[rel="stylesheet"]')){
    const path=pluginAsset(entry,element.getAttribute(element.tagName==='SCRIPT'?'src':'href')||'');const asset=plugin.files[path];if(asset===undefined)throw Error(`插件资源不存在：${path}`);
    expanded+=new TextEncoder().encode(asset).length;if(expanded>900_000)throw Error('插件界面资源展开超过 900 KB');
    const replacement=document.createElement(element.tagName==='SCRIPT'?'script':'style');replacement.textContent=asset.replace(/<\/script/gi,'<\\/script');element.replaceWith(replacement);
  }
  return '<!doctype html><html><head><meta charset="utf-8">'+sdk+style+document.head.innerHTML+'</head><body>'+document.body.innerHTML+'</body></html>';
}
