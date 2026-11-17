import {lazy,Suspense,useEffect,useState} from 'react';
import {FileCode2,RotateCw} from 'lucide-react';
import {invoke} from '@tauri-apps/api/core';
import type {DockTab} from './docking';
import './local-file-browser.css';
const HtmlPreview=lazy(()=>import('../HtmlPreview'));
export default function LocalFileBrowser({tab}:{tab:Extract<DockTab,{kind:'browser'}>}){
  const location=tab.localFile!;
  const [refresh,setRefresh]=useState(0);
  const [file,setFile]=useState<{path:string;name:string;text:string}|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let alive=true;setFile(null);setError('');
    void invoke<{path:string;name:string;text:string}>('read_workspace_html',{workspaceId:location.workspaceId,path:location.path}).then(value=>{if(alive)setFile(value);}).catch(error=>{if(alive)setError(String(error));});
    return()=>{alive=false;};
  },[location,refresh]);
  return <div className="browser-view local-file-browser" aria-label={`本地网页：${tab.title}`}>
    <div className="browser-addressbar"><button type="button" className="icon-button" aria-label="刷新网页" onClick={()=>setRefresh(value=>value+1)}><RotateCw size={14}/></button>
      <label><FileCode2 size={13}/><input aria-label="网页地址" readOnly value={file?.path||location.path} onFocus={event=>event.target.select()}/></label>
    </div>
    {error?<p className="tool-error" role="alert">{error}</p>:file?<Suspense fallback={<p className="quiet-note">正在打开网页…</p>}><HtmlPreview key={refresh} body={file.text} title={`网页：${file.name}`} className="local-report-frame"/></Suspense>:<p className="quiet-note">正在读取网页…</p>}
  </div>;
}
