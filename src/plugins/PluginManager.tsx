import {useRef,useState} from 'react';
import {Download,Power,Puzzle,Trash2} from 'lucide-react';
import {Dialog} from '../next/ui';
import {readPluginFolder,type PluginOperation} from './manifest';
import {usePluginRegistry} from './registry';
import {noteToolsPlugin} from './starter';
import './plugins.css';
const capabilityNames={'note.read':'读取当前笔记','note.edit':'修改当前笔记正文','storage.own':'保存插件自己的数据'};
export function PluginManagerDialog({onClose}:{onClose:()=>void}){
  const {registry,error,ready,change}=usePluginRegistry();const [busy,setBusy]=useState(false);const [failure,setFailure]=useState('');const input=useRef<HTMLInputElement>(null);
  async function update(operation:PluginOperation){setBusy(true);setFailure('');try{await change(operation);}catch(error){setFailure(String(error));}finally{setBusy(false);}}
  return <Dialog title="插件" onClose={onClose}><div className="plugin-manager">
    <div className="plugin-manager-heading"><p>给笔记增加命令和面板。</p><button type="button" className="plugin-button primary" disabled={busy||!ready} onClick={()=>input.current?.click()}><Download size={14}/>安装本地插件</button></div>
    <input hidden type="file" multiple ref={element=>{input.current=element;element?.setAttribute('webkitdirectory','');}} aria-label="选择插件文件夹" onChange={event=>{const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length)return;setBusy(true);setFailure('');void readPluginFolder(files).then(plugin=>update({kind:'install',plugin})).catch(error=>setFailure(String(error))).finally(()=>setBusy(false));}}/>
    {(error||failure)&&<p className="plugin-error" role="alert">{failure||error}</p>}
    {!registry.plugins.length&&<div className="plugins-empty"><Puzzle size={24}/><p>还没有安装插件</p><button className="plugin-button" disabled={busy||!ready} onClick={()=>void update({kind:'install',plugin:noteToolsPlugin()})}>试用示例：笔记工具</button></div>}
    <div className="plugin-list">{registry.plugins.map(plugin=><article className="plugin-card" key={plugin.manifest.id}><header><Puzzle size={18}/><div><strong>{plugin.manifest.name}</strong><span>{plugin.manifest.version} · {plugin.enabled?'已启用':'已停用'}</span></div><button type="button" className={`plugin-button ${plugin.enabled?'':'primary'}`} disabled={busy||!ready} onClick={()=>void update({kind:'enable',id:plugin.manifest.id,enabled:!plugin.enabled})}><Power size={13}/>{plugin.enabled?'停用':'启用'}</button><button type="button" className="plugin-icon" title="卸载插件" aria-label={`卸载${plugin.manifest.name}`} disabled={busy||!ready} onClick={()=>void update({kind:'uninstall',id:plugin.manifest.id})}><Trash2 size={15}/></button></header>
      {plugin.manifest.description&&<p>{plugin.manifest.description}</p>}
      <div className="plugin-contributions">{plugin.manifest.contributes.commands.length>0&&<span>{plugin.manifest.contributes.commands.length} 个命令</span>}{plugin.manifest.contributes.panels.length>0&&<span>{plugin.manifest.contributes.panels.length} 个面板</span>}</div>
      <p className="plugin-capabilities">启用后可：{plugin.manifest.capabilities.map(cap=>capabilityNames[cap]).join('、')||'显示插件界面'}</p>
    </article>)}</div>
    <footer>本地安装 · 笔记中的“插件”入口运行命令、打开面板。更新后需重新启用。</footer>
  </div></Dialog>;
}
