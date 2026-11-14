import {isBusinessPage} from './business-components';
import {listen,type EventCallback,type UnlistenFn} from '@tauri-apps/api/event';
interface HostInternals {invoke:<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;transformCallback:(callback:unknown,once?:boolean)=>number;unregisterCallback:(id:number)=>void}
export function embeddedInternals(target:Window|undefined=typeof window==='undefined'?undefined:window):HostInternals|null {
  try {if(!target || target.parent===target || target.parent.location.origin!==target.location.origin || target.parent.location.pathname!=='/next.html' || !isBusinessPage(new URLSearchParams(target.location.search).get('embed')))return null;return (target.parent as unknown as {__TAURI_INTERNALS__?:HostInternals}).__TAURI_INTERNALS__||null;}catch{return null;}
}
export async function listenFromHost<T>(event:string,handler:EventCallback<T>):Promise<UnlistenFn> {
  const host=embeddedInternals();if(!host)return listen(event,handler);
  const callback=host.transformCallback(handler);let id:number;
  try {id=await host.invoke<number>('plugin:event|listen',{event,target:{kind:'Any'},handler:callback});}catch(error){host.unregisterCallback(callback);throw error;}
  return async()=>{host.unregisterCallback(callback);await host.invoke('plugin:event|unlisten',{event,eventId:id});};
}
export function installEmbeddedBridge(target:Window) {
  try {
    if(target.parent===target || target.parent.location.origin!==target.location.origin || target.parent.location.pathname!=='/next.html' || !isBusinessPage(new URLSearchParams(target.location.search).get('embed')))return;
    const child=target as unknown as Record<string,unknown>;const host=target.parent as unknown as Record<string,unknown>;
    for(const key of ['isTauri','__TAURI_INTERNALS__','__TAURI_EVENT_PLUGIN_INTERNALS__'])if(!child[key] && host[key])Object.defineProperty(child,key,{value:host[key],configurable:true});
  }catch{/* Cross-origin frames cannot acquire the desktop bridge. */}
}
if(typeof window!=='undefined')installEmbeddedBridge(window);
