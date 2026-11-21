import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Download,Save} from 'lucide-react';
import {Excalidraw,MainMenu,exportToBlob,exportToSvg,serializeAsJSON} from '@excalidraw/excalidraw';
import type {ExcalidrawProps,LibraryItems} from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type {Drawing} from './domain';
import {useWorkbench} from './workbench';
import {drawingFileName,parseDrawingScene} from './drawings';
import * as api from './api';

// Resolve all handwriting/font subsets from the packaged application.
declare global {interface Window {EXCALIDRAW_ASSET_PATH:string;}}

export default function DrawingEditor({initial,onClose,theme}:{initial:Drawing;onClose:()=>void;theme?:'light'|'dark'}){
 const ctx=useWorkbench();const [record,setRecord]=useState(initial);const draft=useRef(initial);const saved=useRef(initial.version?JSON.stringify([initial.title,initial.projectId,initial.scene]):'');
 const [status,setStatus]=useState(initial.archived?'已归档 · 只读':initial.version?'已保存到本机':'等待保存');const [error,setError]=useState('');const [closing,setClosing]=useState(false);const [exporting,setExporting]=useState(false);
 const library=useRef<LibraryItems>([]);const active=useRef<Promise<boolean>|null>(null);const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const mounted=useRef(true);const closeRef=useRef(false);
 const initialScene=useRef<{data:ExcalidrawProps['initialData'];error:string} | null>(null);
 if(!initialScene.current){try{const scene=parseDrawingScene(initial.scene);library.current=scene.libraryItems||[];initialScene.current={data:{...scene,scrollToContent:true},error:''};}catch(e){initialScene.current={data:null,error:String(e)};}}
 const signature=(r:Drawing)=>JSON.stringify([r.title.trim(),r.projectId,r.scene]);
 const persist=useCallback(async():Promise<boolean>=>{
  if(initial.archived||initialScene.current?.error)return true;
  if(active.current)return active.current;
  const task=(async()=>{
   try{
    while(signature(draft.current)!==saved.current){
     const next={...draft.current,title:draft.current.title.trim()};
     if(!next.title)throw new Error('请填写画板名称，才能保存。');
     parseDrawingScene(next.scene);
     if(mounted.current){setStatus('正在保存…');setError('');}
     const stored=await api.saveRecord(next) as Drawing;
     saved.current=signature(next);draft.current={...draft.current,version:stored.version,updatedAt:stored.updatedAt};
     if(mounted.current)setRecord(draft.current);
    }
    if(mounted.current){setStatus('已保存到本机');setError('');}return true;
   }catch(e){if(mounted.current){setStatus('保存失败');setError((e instanceof Error?e.message:String(e))+' 画布仍保留，请重试保存或导出源文件。');}return false;}
  })();
  active.current=task;try{return await task;}finally{active.current=null;}
 },[initial.archived]);
 const schedule=useCallback(()=>{if(timer.current)clearTimeout(timer.current);if(!initial.archived){setStatus('有更改 · 即将保存');timer.current=setTimeout(()=>void persist(),1000);}},[persist,initial.archived]);
 function patch(fields:Partial<Drawing>){draft.current={...draft.current,...fields};setRecord(draft.current);schedule();}
 const onChange:NonNullable<ExcalidrawProps['onChange']>=(elements,state,files)=>{
  if(initial.archived||initialScene.current?.error)return;
  const serialized=serializeAsJSON(elements,state,files,'local');const scene=library.current.length?JSON.stringify({...JSON.parse(serialized),libraryItems:library.current}):serialized;if(scene!==draft.current.scene)patch({scene});
 };
 async function close(){if(closeRef.current)return;closeRef.current=true;setClosing(true);if(timer.current)clearTimeout(timer.current);if(await persist()){await ctx.refresh().catch(()=>{});onClose();}else{closeRef.current=false;setClosing(false);}}
 async function download(format:'excalidraw'|'png'|'svg'){
  setExporting(true);try{
   const current=draft.current;let blob:Blob;
   if(format==='excalidraw')blob=new Blob([current.scene],{type:'application/json'});
   else {const scene=parseDrawingScene(current.scene);const options={elements:scene.elements.filter((e:{isDeleted?:boolean})=>!e.isDeleted),appState:{...scene.appState,exportBackground:true,exportEmbedScene:false},files:scene.files};if(!options.elements.length)throw new Error('先画一些内容再导出图片。');blob=format==='png'?await exportToBlob({...options,mimeType:'image/png'}):new Blob([(await exportToSvg(options)).outerHTML],{type:'image/svg+xml'});}
   await api.exportDrawingBlob(blob,drawingFileName(current.title,format),format);
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setExporting(false);}
 }
 useEffect(()=>{mounted.current=true;const prevent=(e:BeforeUnloadEvent)=>{if(!initial.archived&&signature(draft.current)!==saved.current){e.preventDefault();}};const key=(e:KeyboardEvent)=>{if(e.ctrlKey&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();void persist();}};window.addEventListener('beforeunload',prevent);document.addEventListener('keydown',key,true);schedule();return()=>{mounted.current=false;if(timer.current)clearTimeout(timer.current);window.removeEventListener('beforeunload',prevent);document.removeEventListener('keydown',key,true);};},[initial.archived,persist,schedule]);
 const projects=ctx.data.records.filter(r=>r.kind==='project'&&(!r.archived||r.id===record.projectId));
 return <div className="drawing-editor" role="dialog" aria-modal="true" aria-label="Excalidraw 自由画板"><header className="drawing-editor-toolbar"><button className="button" disabled={closing} onClick={()=>void close()}><ArrowLeft size={16}/>{closing?'保存中…':'返回画板'}</button><div className="drawing-editor-name"><input aria-label="画板名称" maxLength={120} value={record.title} readOnly={initial.archived||closing} onChange={e=>patch({title:e.target.value})}/><span role="status">{status}</span></div><select className="compact-select" aria-label="画板关联项目" disabled={initial.archived||closing} value={record.projectId||''} onChange={e=>patch({projectId:e.target.value||null})}><option value="">独立画板</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><div className="actions"><button className="button" disabled={exporting} onClick={()=>void download('excalidraw')}><Download size={14}/>源文件</button><button className="button" disabled={exporting} onClick={()=>void download('png')}>PNG</button><button className="button" disabled={exporting} onClick={()=>void download('svg')}>SVG</button>{!initial.archived&&<button className="button primary" disabled={closing} onClick={()=>void persist()}><Save size={14}/>保存</button>}</div></header>
 {(error||initialScene.current.error)&&<p className="drawing-editor-error" role="alert">{error||initialScene.current.error}</p>}
 <div className="drawing-canvas" style={closing?{pointerEvents:'none'}:undefined}>{!initialScene.current.error&&<Excalidraw initialData={initialScene.current.data} onChange={onChange} onLibraryChange={items=>{library.current=items;if(!initial.archived){const scene=JSON.parse(draft.current.scene);const previous=JSON.stringify(scene.libraryItems||[]);if(previous!==JSON.stringify(items))patch({scene:JSON.stringify({...scene,libraryItems:items})});}}} langCode="zh-CN" theme={theme??ctx.data.settings.theme} viewModeEnabled={initial.archived} handleKeyboardGlobally={false} autoFocus validateEmbeddable={false} onLinkOpen={(element,event)=>{event.preventDefault();if(element.link)void ctx.run(()=>api.openExternalUrl(element.link!));}} UIOptions={{canvasActions:{loadScene:false,saveToActiveFile:false,export:false,saveAsImage:false,toggleTheme:false}}}><MainMenu><MainMenu.DefaultItems.ClearCanvas/><MainMenu.DefaultItems.ChangeCanvasBackground/></MainMenu></Excalidraw>}</div>
 <footer className="drawing-editor-footnote">Excalidraw · 绘图工具在画布顶部 · 空格拖动画布 · Ctrl + S 保存 · 关闭画板前会完成保存</footer></div>;
}
