import {useEffect,useImperativeHandle,useReducer,useRef,useState,type Ref} from 'react';
import {Archive,ArrowLeft,Download,Info,Paperclip,X} from 'lucide-react';
import {noteTypes,type Note} from './domain';
import {useWorkbench} from './workbench';
import * as api from './api';
import MarkdownEditor from './MarkdownEditor';
import {NoteDraft} from './note-draft';
import HtmlPreview from './HtmlPreview';
import {knowledgeFormat,knowledgeLabels,knowledgeMapState} from './knowledge-graph';
import {GraphView,NodeInspector} from './next/Graph';
import {createMapNode,editNodeBody,renameMapNode,updateMapGraph,type WorkbenchState} from './next/core';
import {initialMapEditor,mapEditorReducer} from './next/map-editor';
import {clipboardNodes,copyMapBranch,createMapSibling,deleteMapBranch,moveMapBranch,pasteMapBranch,type NodeClipboard} from './next/node-operations';
import './pages/knowledge-graph.css';
import './pages/knowledge-map.css';

export interface KnowledgeEditorHandle {flush:()=>Promise<void>;}
export default function KnowledgeEditor({initial,onClose,inline=false,draftKey,ref}:{initial:Note;onClose:()=>void;inline?:boolean;draftKey?:string;ref?:Ref<KnowledgeEditorHandle>}){
  const ctx=useWorkbench();const latestCtx=useRef(ctx);latestCtx.current=ctx;
  const key=draftKey||`northstar-note-draft:${initial.id}`;
  const [draft]=useState(()=>{
    let recovered:Note|undefined;try{recovered=JSON.parse(sessionStorage.getItem(key)||'null')?.record;}catch{/* Ignore invalid recovery data. */}
    return new NoteDraft(initial,async next=>{
      const saved=await api.saveRecord(next) as Note;
      void latestCtx.current.refresh().catch(()=>{});
      if(parent!==window)parent.postMessage({type:'northstar-business-changed'},location.origin);
      return saved;
    },initial.archived?undefined:recovered);
  });
  const [,render]=useReducer(n=>n+1,0);const [source,setSource]=useState(!initial.body);const [closing,setClosing]=useState(false);const [details,setDetails]=useState(false);
  const record=draft.note;const [format]=useState<ReturnType<typeof knowledgeFormat>>(()=>knowledgeFormat(initial));const markdown=format==='markdown';
  const cache=()=>{try{if(draft.dirty)sessionStorage.setItem(key,JSON.stringify({record:draft.note}));else sessionStorage.removeItem(key);}catch{/* Keep the in-memory draft if storage is full. */}};
  const flush=()=>draft.flush().finally(cache);const flushRef=useRef(flush);flushRef.current=flush;
  useImperativeHandle(ref,()=>({flush:()=>flushRef.current()}),[]);
  useEffect(()=>draft.subscribe(()=>{cache();render();}),[draft]);
  useEffect(()=>{if(!draft.dirty||draft.error)return;const timer=setTimeout(()=>void flushRef.current().catch(()=>{}),700);return()=>clearTimeout(timer);},[draft,record,draft.error]);
  useEffect(()=>{
    const before=(event:BeforeUnloadEvent)=>{if(draft.dirty)event.preventDefault();};
    const keydown=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void flushRef.current().catch(()=>{});}};
    window.addEventListener('beforeunload',before);document.addEventListener('keydown',keydown);
    return()=>{window.removeEventListener('beforeunload',before);document.removeEventListener('keydown',keydown);if(draft.dirty)void flushRef.current().catch(()=>{});};
  },[draft]);
  async function close(){setClosing(true);try{await flush();onClose();}catch{setClosing(false);}}
  async function download(){await ctx.run(async()=>{const extension=format==='html'?'html':format==='mindmap'?'mindmap':'md';const name=(draft.note.title.replace(/[<>:"/\\|?*]/g,'_')||'未命名笔记')+'.'+extension;const blob=new Blob([draft.note.body],{type:format==='html'?'text/html;charset=utf-8':format==='mindmap'?'application/json':'text/markdown;charset=utf-8'});await api.exportKnowledgeBlob(blob,name,extension);});}
  const status=initial.archived?'已归档 · 只读':draft.error?'保存失败':draft.saving?'正在保存…':draft.dirty?'即将保存':'已保存';
  return <div className={`kg-editor ${inline?'note-inline-editor':''} ${markdown?'note-document':''}`} role={inline?'region':'dialog'} aria-modal={inline?undefined:true} aria-label={`${knowledgeLabels[format]}编辑器`}>
    <header className="kg-editor-toolbar">
      {!inline&&<button className="button" disabled={closing} onClick={()=>void close()}><ArrowLeft size={15}/>返回</button>}
      {markdown?<span className="note-document-label">笔记</span>:<input aria-label="内容标题" maxLength={120} value={record.title} readOnly={initial.archived} onChange={e=>draft.patch({title:e.target.value})}/>}
      <span role="status">{status}</span><div className="spacer"/>
      {!markdown&&format!=='mindmap'&&<button className="button" onClick={()=>setSource(old=>!old)}>{source?'预览':'编辑源码'}</button>}
      <button className="icon-button" title="资料与附件" aria-label="资料与附件" aria-expanded={details} onClick={()=>setDetails(old=>!old)}><Info size={16}/></button>
      <button className="icon-button" title="导出" aria-label="导出笔记" onClick={()=>void download()}><Download size={16}/></button>
      {inline&&!initial.archived&&<button className="icon-button" title="归档笔记" aria-label="归档笔记" disabled={closing} onClick={()=>{setClosing(true);void flush().then(()=>ctx.archive(draft.note)).then(ok=>{if(ok)onClose();else setClosing(false);}).catch(()=>setClosing(false));}}><Archive size={16}/></button>}
    </header>
    {draft.error&&<p className="note-save-error" role="alert">{draft.error}，草稿仍保留。<button className="text-button" onClick={()=>void flush().catch(()=>{})}>重试保存</button></p>}
    <div className="note-document-layout"><div className="note-document-main">
      {markdown?<><input className="note-document-title" aria-label="笔记标题" placeholder="未命名笔记" maxLength={120} value={record.title} readOnly={initial.archived} onChange={e=>draft.patch({title:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.parentElement?.querySelector<HTMLElement>('[aria-label="笔记正文"]')?.focus();}}}/><MarkdownEditor autoFocus value={record.body} onChange={body=>draft.patch({body})} readOnly={initial.archived} allowRemoteImages={!record.knowledgeSource} onOpenLink={url=>void ctx.run(()=>api.openExternalUrl(url))}/></>
      :format==='mindmap'?<KnowledgeMapEditor initial={initial} title={record.title} onChange={body=>draft.patch({body})}/>:source?<textarea className="kg-source-editor" aria-label="HTML 源码" value={record.body} readOnly={initial.archived} onChange={e=>draft.patch({body:e.target.value})}/>:<HtmlPreview className="kg-html-full" title="HTML 网页" body={record.body}/>}
    </div>
    {details&&<aside className="note-document-details" aria-label="笔记资料"><header><strong>资料与附件</strong><button className="icon-button" aria-label="关闭笔记资料" onClick={()=>setDetails(false)}><X size={15}/></button></header>
      <label>标签<input aria-label="笔记标签" disabled={initial.archived} defaultValue={record.tags.join('，')} onBlur={event=>draft.patch({tags:Array.from(new Set(event.target.value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))).slice(0,20)})}/></label>
      <label>关联项目<select aria-label="笔记关联项目" disabled={initial.archived} value={record.projectId||''} onChange={event=>draft.patch({projectId:event.target.value||null,taskId:null})}><option value="">无</option>{ctx.data.records.filter(r=>r.kind==='project'&&(!r.archived||r.id===record.projectId)).map(project=><option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <label>关联任务<select aria-label="笔记关联任务" disabled={initial.archived} value={record.taskId||''} onChange={event=>{const task=ctx.data.records.find(r=>r.id===event.target.value&&r.kind==='task');draft.patch({taskId:task?.id||null,...(task?.kind==='task'?{projectId:task.projectId}:{})});}}><option value="">无</option>{ctx.data.records.filter(r=>r.kind==='task'&&(!r.archived||r.id===record.taskId)).map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <details><summary>记录信息</summary><label>记录类型<select aria-label="笔记记录类型" disabled={initial.archived} value={record.noteType} onChange={event=>draft.patch({noteType:event.target.value as Note['noteType']})}>{Object.entries(noteTypes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>记录日期<input aria-label="笔记记录日期" type="date" disabled={initial.archived} value={record.occurredOn} onChange={event=>{if(event.target.value)draft.patch({occurredOn:event.target.value});}}/></label></details>
      {record.knowledgeSource&&<p>来源 · {record.knowledgeSource.workspaceName}</p>}
      <p>更新于 {new Date(record.updatedAt).toLocaleString('zh-CN')}</p>
      {ctx.data.attachments.filter(file=>file.entityId===record.id).map(file=><button className="text-button" key={file.id} onClick={()=>void ctx.run(()=>api.openAttachment(file.id))}><Paperclip size={13}/>{file.name}</button>)}
      {!initial.archived&&<button className="button" disabled={closing} onClick={()=>void flush().then(()=>ctx.addFiles(record.id)).catch(()=>{})}><Paperclip size={14}/>添加附件</button>}
    </aside>}
    </div>
    {!markdown&&<footer>{format==='html'?'HTML 独立预览 · 支持内嵌脚本和样式；外部文件与网络资源未加载':'本地自动保存 · Ctrl S 保存'}</footer>}
  </div>;
}
function KnowledgeMapEditor({initial,title,onChange}:{initial:Note;title:string;onChange:(body:string)=>void}){
  const [editor,dispatch]=useReducer(mapEditorReducer,initial,record=>initialMapEditor(knowledgeMapState(record)));const space={...editor.state.spaces[0],name:title};const [autoEdit,setAutoEdit]=useState<string|null>(null);const clip=useRef<NodeClipboard|null>(null);const current=useRef(editor.state);current.current=editor.state;const initialNodes=useRef(space.nodes);
  useEffect(()=>{if(space.nodes!==initialNodes.current){initialNodes.current=space.nodes;onChange(JSON.stringify(space.nodes));}},[space.nodes]);
  const edit=(update:(s:WorkbenchState)=>WorkbenchState)=>{if(!initial.archived)dispatch({type:'edit',workspaceId:space.id,update,at:Date.now()});};
  return <div className="kg-map-editor"><div className="kg-document-canvas"><GraphView space={space} sessionCounts={{}} autoEditId={autoEdit} onChange={graph=>dispatch({type:'change',update:s=>({...s,spaces:[updateMapGraph(s.spaces[0],graph,'workspace')]})})} onRename={(id,title)=>{edit(s=>renameMapNode(s,space.id,id,title));if(id===autoEdit)dispatch({type:'change',update:s=>({...s,spaces:[{...s.spaces[0],graph:{...s.spaces[0].graph,selectedId:null}}]})});setAutoEdit(null);}} onInspect={id=>dispatch({type:'change',update:s=>({...s,spaces:[{...s.spaces[0],graph:{...s.spaces[0].graph,selectedId:id}}]})})} onAdd={parent=>{const id=crypto.randomUUID();edit(s=>createMapNode(s,space.id,parent,id,'workspace'));setAutoEdit(id);}} editing={{canUndo:!!editor.past[space.id]?.length,canRedo:!!editor.future[space.id]?.length,error:editor.error,undo:()=>{setAutoEdit(null);dispatch({type:'undo',workspaceId:space.id});},redo:()=>{setAutoEdit(null);dispatch({type:'redo',workspaceId:space.id});},sibling:parent=>{const id=crypto.randomUUID();edit(s=>createMapSibling(s,space.id,parent,id,'workspace'));setAutoEdit(id);},remove:id=>{setAutoEdit(null);edit(s=>deleteMapBranch(s,space.id,id));},move:(id,target,position)=>edit(s=>moveMapBranch(s,space.id,id,target,position)),copy:(id,cut)=>{const owner=current.current.spaces[0];const ids=(typeof id==='string'?[id]:id).filter(id=>!cut||owner.nodes.find(n=>n.id===id)?.parentId);const copied=copyMapBranch(owner,ids);clip.current=copied;if(cut)edit(s=>deleteMapBranch(s,space.id,ids));return copied;},paste:(parent,text,token)=>{try{const nodes=clipboardNodes(text??clip.current?.text??'',text===undefined||token===clip.current?.token?clip.current:null);const ids=nodes.map(()=>crypto.randomUUID());edit(s=>pasteMapBranch(s,space.id,parent,nodes,ids,'workspace'));return ids[0]||null;}catch(error){dispatch({type:'error',message:String(error)});return null;}},failure:message=>dispatch({type:'error',message})}}/></div>{space.graph.selectedId!==autoEdit&&space.nodes.find(n=>n.id===space.graph.selectedId)&&<NodeInspector space={space} node={space.nodes.find(n=>n.id===space.graph.selectedId)!} onEditBody={body=>edit(s=>editNodeBody(s,space.id,space.graph.selectedId!,body))} onClose={()=>dispatch({type:'change',update:s=>({...s,spaces:[{...s.spaces[0],graph:{...s.spaces[0].graph,selectedId:null}}]})})} onFocus={()=>dispatch({type:'change',update:s=>({...s,spaces:[{...s.spaces[0],graph:{...s.spaces[0].graph,focusId:space.graph.selectedId,selectedId:null,camera:null}}]})})}>{null}</NodeInspector>}</div>;
}
