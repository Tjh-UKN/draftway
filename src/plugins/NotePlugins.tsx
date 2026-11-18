import {useEffect,useRef,useState} from 'react';
import {Puzzle,Settings2,X} from 'lucide-react';
import {desktop} from '../api';
import {PluginFrame} from './PluginFrame';
import {PluginManagerDialog} from './PluginManager';
import {usePluginRegistry} from './registry';
import type {NotePluginHost,pluginPeer} from './runtime';
import './plugins.css';
export function useNotePlugins(host:NotePluginHost,value:string,available:boolean){
  const {registry,ready,error,change}=usePluginRegistry();const [menu,setMenu]=useState(false);const [manager,setManager]=useState(false);const [panel,setPanel]=useState<{id:string;entry:string;title:string}|null>(null);const [command,setCommand]=useState<{id:string;command:string}|null>(null);const [failure,setFailure]=useState('');const menuRef=useRef<HTMLDivElement>(null);const panelPeer=useRef<ReturnType<typeof pluginPeer>|null>(null);
  const enabled=ready?registry.plugins.filter(plugin=>plugin.enabled):[];const activePanel=enabled.find(plugin=>plugin.manifest.id===panel?.id);const activeCommand=enabled.find(plugin=>plugin.manifest.id===command?.id);
  useEffect(()=>{if(!menu)return;const close=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
  useEffect(()=>{const timer=setTimeout(()=>panelPeer.current?.notify('note.changed'),120);return()=>clearTimeout(timer);},[value]);
  useEffect(()=>{if(!activePanel){panelPeer.current=null;if(panel)setPanel(null);}if(command&&!activeCommand)setCommand(null);},[activePanel,activeCommand,panel,command]);
  return {
    controls:available?<div className="note-plugin-tools" ref={menuRef}><button type="button" title="插件" aria-label="笔记插件" aria-expanded={menu} onClick={()=>setMenu(old=>!old)}><Puzzle size={15}/></button>{menu&&<div className="note-plugin-menu" aria-label="笔记插件菜单" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setMenu(false);}}}>
      {(!desktop)&&<p>Windows 版可运行插件。</p>}{error&&<p className="plugin-error">{error}</p>}
      {enabled.map(plugin=><section key={plugin.manifest.id}><span>{plugin.manifest.name}</span>{plugin.manifest.contributes.commands.map(item=><button type="button" key={item.id} disabled={!desktop||!!command} onClick={()=>{setFailure('');setCommand({id:plugin.manifest.id,command:item.id});setMenu(false);}}>{item.title}</button>)}{plugin.manifest.contributes.panels.map(item=><button type="button" key={item.id} disabled={!desktop} onClick={()=>{setPanel({id:plugin.manifest.id,entry:item.entry,title:item.title});setMenu(false);}}>{item.title}</button>)}</section>)}
      {!enabled.length&&<p>还没有启用的插件</p>}<button type="button" className="plugin-manage-entry" onClick={()=>{setManager(true);setMenu(false);}}><Settings2 size={13}/>管理插件</button>
    </div>}</div>:null,
    panel:activePanel&&panel?<aside className="note-extension-panel"><header><span>{panel.title}</span><button type="button" className="plugin-icon" aria-label="关闭插件面板" onClick={()=>setPanel(null)}><X size={14}/></button></header><PluginFrame plugin={activePanel} entry={panel.entry} host={host} registry={registry} change={change} onReady={peer=>{panelPeer.current=peer;}}/></aside>:null,
    runner:<>{activeCommand&&command&&<PluginFrame hidden plugin={activeCommand} host={host} registry={registry} change={change} onReady={peer=>{void peer.command(command.command).then(()=>setCommand(null),error=>{setFailure(String(error));setCommand(null);});}} onError={error=>{setFailure(error);setCommand(null);}}/>}{failure&&<div className="plugin-command-error" role="alert">{failure}<button type="button" onClick={()=>setFailure('')} aria-label="关闭插件错误"><X size={13}/></button></div>}{manager&&<PluginManagerDialog onClose={()=>setManager(false)}/>}</>,
  };
}
