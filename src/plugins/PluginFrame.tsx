import {useEffect,useMemo,useRef,useState} from 'react';
import HtmlPreview from '../HtmlPreview';
import type {PluginPackage,PluginRegistry,PluginOperation} from './manifest';
import {pluginDocument} from './frame-document';
import {notePluginCall,pluginPeer,type NotePluginHost} from './runtime';
export function PluginFrame({plugin,entry,host,registry,change,onReady,onError,hidden=false}:{plugin:PluginPackage;entry?:string;host:NotePluginHost;registry:PluginRegistry;change:(op:PluginOperation)=>Promise<PluginRegistry>;onReady?:(peer:ReturnType<typeof pluginPeer>)=>void;onError?:(error:string)=>void;hidden?:boolean}){
  const frame=useRef<HTMLIFrameElement>(null);const peer=useRef<ReturnType<typeof pluginPeer>|null>(null);const [error,setError]=useState('');const latest=useRef({plugin,host,registry,change,onReady,onError});latest.current={plugin,host,registry,change,onReady,onError};
  const loadTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const source=useMemo(()=>{try{return {body:pluginDocument(plugin,entry),error:''};}catch(error){return {body:'',error:String(error)};}},[plugin.manifest,plugin.files,entry]);
  useEffect(()=>{loadTimer.current=setTimeout(()=>{setError('插件加载超时');latest.current.onError?.('插件加载超时');},12000);return()=>clearTimeout(loadTimer.current);},[source.body]);
  useEffect(()=>()=>{peer.current?.dispose();peer.current=null;},[]);
  function connect(){
    peer.current?.dispose();const channel=new MessageChannel();
    const client=pluginPeer(channel.port1,async(method,params)=>{
      const current=latest.current;const installed=current.registry.plugins.find(item=>item.manifest.id===current.plugin.manifest.id);
      if(!installed?.enabled)throw Error('插件已停用');
      if(method==='storage.get'||method==='storage.set'){
        if(!installed.manifest.capabilities.includes('storage.own'))throw Error('插件没有存储权限');
        if(!params||typeof params!=='object'||Array.isArray(params))throw Error('存储参数无效');const options=params as Record<string,unknown>;
        if(typeof options.key!=='string'||!/^[a-z][a-z\d.-]{0,79}$/.test(options.key)||['constructor','prototype'].includes(options.key)||Object.keys(options).some(key=>!['key',...(method==='storage.set'?['value']:[])].includes(key)))throw Error('存储参数无效');
        if(method==='storage.get')return current.registry.data[installed.manifest.id]?.[options.key];
        const encoded=JSON.stringify(options.value);if(encoded===undefined)throw Error('插件数据需要 JSON 值');
        await current.change({kind:'storage.set',id:installed.manifest.id,key:options.key,value:JSON.parse(encoded)});return null;
      }
      return notePluginCall(installed,current.host,method,params);
    });peer.current=client;frame.current?.contentWindow?.postMessage({type:'northstar-plugin-connect'},'*',[channel.port2]);
    void client.ready.then(()=>{clearTimeout(loadTimer.current);if(peer.current===client)latest.current.onReady?.(client);}).catch(error=>{clearTimeout(loadTimer.current);if(peer.current===client){setError(String(error));latest.current.onError?.(String(error));}});
  }
  if(source.error||error)return <p className="plugin-error" role="alert">{source.error||error}</p>;
  return <div className={hidden?'plugin-command-frame':'plugin-panel-frame'}><HtmlPreview frameRef={frame} onLoad={connect} body={source.body} title={`${plugin.manifest.name}插件`}/></div>;
}
