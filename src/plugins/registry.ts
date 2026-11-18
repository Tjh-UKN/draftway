import {useCallback,useEffect,useState} from 'react';
import * as api from '../api';
import {listenFromHost} from '../embedded-bridge';
import {emptyPlugins,type PluginOperation,type PluginRegistry} from './manifest';
export function usePluginRegistry(){
  const [registry,setRegistry]=useState(emptyPlugins);const [error,setError]=useState('');const [ready,setReady]=useState(false);
  const accept=useCallback((next:PluginRegistry)=>{setRegistry(old=>next.revision>=old.revision?next:old);setError('');setReady(true);},[]);
  useEffect(()=>{let alive=true;let dispose=()=>{};const reload=()=>{void api.loadPlugins().then(next=>{if(alive)accept(next);}).catch(error=>{if(alive){setError(String(error));setReady(false);}});};reload();
    window.addEventListener('northstar-plugins-changed',reload);const channel=!api.desktop?new BroadcastChannel('northstar-plugins'):null;if(channel)channel.onmessage=reload;
    if(api.desktop)void listenFromHost('northstar-plugins-changed',reload).then(unlisten=>{if(alive)dispose=unlisten;else unlisten();}).catch(error=>{if(alive)setError(String(error));});
    return()=>{alive=false;dispose();channel?.close();window.removeEventListener('northstar-plugins-changed',reload);};
  },[accept]);
  const change=async(operation:PluginOperation)=>{const result=await api.changePlugins(operation);accept(result);return result;};
  return {registry,ready,error,change};
}
