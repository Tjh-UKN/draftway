import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Archive,ArrowUpRight,ChevronRight,FileCode2,FileText,Folder,GitBranch,Minus,PenTool,Plus,Search,Trash2,Upload,X} from 'lucide-react';
import {Modal} from '../components';
import {ManagementMenu} from '../next/ManagementMenu';
import {useWorkbench} from '../workbench';
import * as api from '../api';
import MarkdownView from '../MarkdownView';
import HtmlPreview from '../HtmlPreview';
import NodeDot from '../NodeDot';
import {knowledgeFormat,knowledgeHierarchy,knowledgeLabels,knowledgeRecords,knowledgeRoot,importKnowledge,newKnowledge,type KnowledgeRecord} from '../knowledge-graph';
import {placeNodes,type MindNode} from '../next/model';
import type {KnowledgeFormat} from '../domain';
import './knowledge-graph.css';

const DrawingEditor=lazy(()=>import('../DrawingEditor'));
const ContentEditor=lazy(()=>import('../KnowledgeEditor'));
export function KnowledgeGlyph({format}:{format:string}) {const Icon=format==='folder'?Folder:format==='html'?FileCode2:format==='mindmap'?GitBranch:format==='excalidraw'?PenTool:FileText;return <Icon size={17}/>;}

export default function KnowledgeGraph({theme}:{theme?:'light'|'dark'}){
  const ctx=useWorkbench();const [query,setQuery]=useState('');const [selected,setSelected]=useState<string|null>(null);const [collapsed,setCollapsed]=useState<string[]>([]);const [createAt,setCreateAt]=useState<string|null>(null);const [editor,setEditor]=useState<KnowledgeRecord|null>(null);const [error,setError]=useState('');const picker=useRef<HTMLInputElement>(null);
  const [deleteItem,setDeleteItem]=useState<KnowledgeRecord|null>(null);
  const records=knowledgeRecords(ctx.data.records);
  const tree=useMemo(()=>knowledgeHierarchy(ctx.data.records),[ctx.data.records]);
  const filtering=!!query.trim();
  const nodes=useMemo(()=>filtering?knowledgeHierarchy(ctx.data.records,query):tree,[ctx.data.records,filtering,query,tree]);
  const selectedNode=nodes.find(n=>n.id===selected);const current=records.find(r=>r.id===selected);const parent=selectedNode?.id||knowledgeRoot;
  useEffect(()=>{if(selected&&!nodes.some(n=>n.id===selected))setSelected(null);},[nodes,selected]);
  async function save(record:KnowledgeRecord){let stored:KnowledgeRecord|undefined;const ok=await ctx.run(async()=>{stored=await api.saveRecord(record) as KnowledgeRecord;await ctx.refresh();});if(ok&&stored){setSelected(stored.id);if(knowledgeFormat(stored)!=='folder')setEditor(stored);}return ok;}
  async function create(format:KnowledgeFormat|'excalidraw'){const record=newKnowledge(format,createAt||parent);setCreateAt(null);if(await save(record))setCollapsed(old=>old.filter(id=>id!==record.knowledgeParentId));}
  async function importFile(file:File){try{setError('');const record=await importKnowledge(file,parent);await save(record);}catch(e){setError(String(e));}}
  async function move(id:string,targetId:string){const record=records.find(r=>r.id===id);if(!record||id===targetId)return;const ok=await ctx.save({...record,knowledgeParentId:targetId===knowledgeRoot?null:targetId});if(ok)setCollapsed(old=>old.filter(id=>id!==targetId));}
  async function confirmDelete(){
    if(!deleteItem||ctx.busy)return;
    const {id,version}=deleteItem;
    if(await ctx.run(async()=>{await api.deleteKnowledge(id,version);await ctx.refresh();},'条目已删除')){
      setSelected(old=>old===id?null:old);
      setDeleteItem(null);
    }
  }
  return <section className="knowledge-graph-page" aria-label="层级知识库">
    <header className="kg-toolbar"><label className="kg-search"><Search size={15}/><input aria-label="搜索知识" placeholder="搜索知识…" value={query} onChange={e=>setQuery(e.target.value)}/></label><span className="kg-count">{records.filter(r=>knowledgeFormat(r)!=='folder').length} 份内容</span><div className="kg-create"><button className="button" aria-expanded={createAt!==null} onClick={()=>setCreateAt(createAt?null:parent)}><Plus size={15}/>新建</button>{createAt&&<div className="kg-create-menu" role="menu" aria-label="新建知识内容">{(['folder','markdown','html','excalidraw','mindmap'] as const).map(format=><button role="menuitem" key={format} onClick={()=>void create(format)}><KnowledgeGlyph format={format}/>{knowledgeLabels[format]}</button>)}</div>}</div><button className="button" onClick={()=>picker.current?.click()}><Upload size={15}/>导入</button><input ref={picker} hidden type="file" accept=".md,.markdown,.txt,.html,.htm,.excalidraw,.json,.mindmap,.northmap" aria-label="导入知识文件" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importFile(file);}}/></header>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="kg-scene"><KnowledgeCanvas nodes={nodes} collapsed={filtering?[]:collapsed} selected={selected} onSelect={id=>{setSelected(id);setCreateAt(null);const record=records.find(r=>r.id===id);if(record&&knowledgeFormat(record)==='markdown')setEditor(record);}} onOpen={id=>{const record=records.find(r=>r.id===id);if(record&&knowledgeFormat(record)!=='folder')setEditor(record);}} onFold={filtering?undefined:id=>setCollapsed(old=>old.includes(id)?old.filter(n=>n!==id):[...old,id])} onAdd={id=>{setSelected(id);setCreateAt(id);}} onMove={(id,target)=>void move(id,target)} records={records} busy={ctx.busy} onDelete={setDeleteItem}/>
    {selectedNode&&selected!==knowledgeRoot&&<aside className="kg-details" aria-label="知识详情"><header><span>{current?knowledgeLabels[knowledgeFormat(current)]:'来源工作区'}</span><button className="icon-button" aria-label="关闭知识详情" onClick={()=>setSelected(null)}><X size={16}/></button></header>
      {current?<><input className="kg-title" aria-label="知识标题" key={current.id+current.version} defaultValue={current.title} onBlur={e=>{const title=e.currentTarget.value.trim()||current.title;e.currentTarget.value=title;if(title!==current.title)void ctx.save({...current,title});}} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing)e.currentTarget.blur();}}/><div className="kg-detail-actions">{knowledgeFormat(current)!=='folder'&&<button className="button primary" onClick={()=>setEditor(current)}><ArrowUpRight size={15}/>打开{knowledgeLabels[knowledgeFormat(current)]}</button>}<button className="icon-button" aria-label="归档知识" disabled={ctx.busy} onClick={()=>void ctx.archive(current).then(ok=>{if(ok)setSelected(null);})}><Archive size={16}/></button></div>
      <label className="kg-parent">所在分支<select aria-label="移动知识到分支" value={selectedNode.parentId||knowledgeRoot} onChange={e=>void move(current.id,e.target.value)}>{tree.filter(n=>n.id!==current.id&&!isBelow(tree,n.id,current.id)).map(n=><option key={n.id} value={n.id}>{breadcrumb(tree,n.id)}</option>)}</select></label>
      {current.kind==='note'&&current.knowledgeSource&&<p className="kg-source">来源 · {current.knowledgeSource.workspaceName}</p>}<div className="kg-preview">{current.kind==='drawing'?<button className="kg-open-preview" onClick={()=>setEditor(current)}><PenTool size={35}/>打开 Excalidraw 画布</button>:knowledgeFormat(current)==='html'?<HtmlPreview title="HTML 内容预览" body={current.body}/>:knowledgeFormat(current)==='mindmap'?<button className="kg-open-preview" onClick={()=>setEditor(current)}><GitBranch size={35}/>打开思维导图</button>:knowledgeFormat(current)==='folder'?<ChildLinks nodes={nodes} id={current.id} onSelect={setSelected}/>:<MarkdownView value={current.body} allowRemoteImages={false} onOpenLink={url=>void ctx.run(()=>api.openExternalUrl(url))}/>}</div><div className="kg-attachments">{ctx.data.attachments.filter(a=>a.entityId===current.id).map(file=><button key={file.id} onClick={()=>void ctx.run(()=>api.openAttachment(file.id))}>{file.name}</button>)}<button onClick={()=>void ctx.addFiles(current.id)}>+ 添加附件</button></div></>:<><h2>{selectedNode.title}</h2><ChildLinks nodes={nodes} id={selectedNode.id} onSelect={setSelected}/></>}
    </aside>}</div>
    {editor&&<Suspense fallback={<div className="kg-editor">正在打开内容…</div>}>{editor.kind==='drawing'?<DrawingEditor initial={editor} theme={theme} onClose={()=>{setEditor(null);void ctx.refresh();}}/>:<ContentEditor initial={editor} onClose={()=>{setEditor(null);void ctx.refresh();}}/>}</Suspense>}
    {deleteItem&&<Modal title="删除知识条目" onClose={()=>{if(!ctx.busy)setDeleteItem(null);}}>
      <p className="confirm-copy">将永久删除「{deleteItem.title}」。</p>
      {ctx.data.records.some(record=>record.id!==deleteItem.id&&record.knowledgeParentId===deleteItem.id)&&<p className="small muted">下级内容将移到上一级。</p>}
      {ctx.data.attachments.some(file=>file.entityId===deleteItem.id)&&<p className="small muted">附件将保留在文件柜。</p>}
      <div className="modal-footer"><button className="button" data-autofocus disabled={ctx.busy} onClick={()=>setDeleteItem(null)}>取消</button><button className="button danger" disabled={ctx.busy} onClick={()=>void confirmDelete()}>永久删除</button></div>
    </Modal>}
  </section>;
}
function isBelow(nodes:MindNode[],id:string,parentId:string){let parent=nodes.find(n=>n.id===id)?.parentId;const seen=new Set<string>();while(parent&&!seen.has(parent)){if(parent===parentId)return true;seen.add(parent);parent=nodes.find(n=>n.id===parent)?.parentId;}return false;}
function breadcrumb(nodes:MindNode[],id:string):string {const node=nodes.find(n=>n.id===id);return node?node.parentId&&node.parentId!==knowledgeRoot?breadcrumb(nodes,node.parentId)+' / '+node.title:node.title:'';}
function ChildLinks({nodes,id,onSelect}:{nodes:MindNode[];id:string;onSelect:(id:string)=>void}){return <div className="kg-children">{nodes.filter(n=>n.parentId===id).map(n=><button key={n.id} onClick={()=>onSelect(n.id)}>{n.title}<ChevronRight size={14}/></button>)}</div>;}
function KnowledgeCanvas({nodes,collapsed,selected,onSelect,onOpen,onFold,onAdd,onMove,records,busy,onDelete}:{nodes:MindNode[];collapsed:string[];selected:string|null;onSelect:(id:string)=>void;onOpen:(id:string)=>void;onFold?:(id:string)=>void;onAdd:(id:string)=>void;onMove:(id:string,target:string)=>void;records:KnowledgeRecord[];busy:boolean;onDelete:(record:KnowledgeRecord)=>void}){
  const frame=useRef<HTMLDivElement>(null);const positions=useMemo(()=>placeNodes(nodes,collapsed),[nodes,collapsed]);const [camera,setCamera]=useState({x:0,y:0,zoom:1});const [drop,setDrop]=useState<string|null>(null);const drag=useRef<{id?:string;x:number;y:number;camera:typeof camera;active:boolean;target?:string}|null>(null);const skipClick=useRef(false);const latest=useRef(camera);latest.current=camera;
  const [menu,setMenu]=useState<{id:string;x:number;y:number;keyboard:boolean}|null>(null);
  const menuRecord=menu?records.find(record=>record.id===menu.id):undefined;
  function fit(){const element=frame.current;if(!element?.clientWidth||!element.clientHeight||!positions.length)return;const left=Math.min(...positions.map(p=>p.x-p.width/2)),right=Math.max(...positions.map(p=>p.x+p.width/2)),top=Math.min(...positions.map(p=>p.y-p.height/2)),bottom=Math.max(...positions.map(p=>p.y+p.height/2));const zoom=Math.max(.15,Math.min(1,(element.clientWidth-100)/(right-left),(element.clientHeight-120)/(bottom-top)));setCamera({x:-(left+right)/2*zoom,y:-(top+bottom)/2*zoom,zoom});}
  const fitRef=useRef(fit);fitRef.current=fit;useEffect(()=>{fit();},[nodes.length]);useEffect(()=>{const element=frame.current!;const observer=new ResizeObserver(()=>{if(element.clientWidth&&element.clientHeight)fitRef.current();});observer.observe(element);const wheel=(event:WheelEvent)=>{event.preventDefault();setCamera(old=>event.ctrlKey?{...old,zoom:Math.max(.15,Math.min(2,old.zoom+(event.deltaY>0?-.05:.05)))}:{...old,x:old.x-event.deltaX,y:old.y-event.deltaY});};element.addEventListener('wheel',wheel,{passive:false});return()=>{observer.disconnect();element.removeEventListener('wheel',wheel);};},[]);
  return <div className="kg-canvas" ref={frame} aria-label="知识层级图" onPointerDown={e=>{if(e.button!==0||(e.target as Element).closest('button'))return;const id=(e.target as Element).closest<HTMLElement>('[data-knowledge-id]')?.dataset.knowledgeId;drag.current={id:id!==knowledgeRoot?id:undefined,x:e.clientX,y:e.clientY,camera:latest.current,active:false};}} onPointerMove={e=>{const d=drag.current;if(!d)return;if(!d.active&&Math.hypot(e.clientX-d.x,e.clientY-d.y)<6)return;d.active=true;e.currentTarget.setPointerCapture(e.pointerId);if(!d.id)setCamera({...d.camera,x:d.camera.x+e.clientX-d.x,y:d.camera.y+e.clientY-d.y});else{const element=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-knowledge-id]');const target=element?.dataset.knowledgeId;d.target=target&&target!==d.id&&!isBelow(nodes,target,d.id)?target:undefined;setDrop(d.target||null);}}} onPointerUp={e=>{const d=drag.current;if(d?.active){if(d.id&&d.target)onMove(d.id,d.target);skipClick.current=true;setTimeout(()=>skipClick.current=false,0);e.preventDefault();}drag.current=null;setDrop(null);}} onPointerCancel={()=>{drag.current=null;setDrop(null);}}>
    <div className="kg-canvas-content" style={{transform:`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`}}><svg className="kg-edges" aria-hidden="true">{positions.slice(1).map(p=>{const parent=positions.find(n=>n.node.id===p.node.parentId);if(!parent)return null;const x1=parent.x+parent.width/2,x2=p.x-p.width/2,m=(x1+x2)/2;return <path key={p.node.id} d={`M${x1},${parent.y} C${m},${parent.y} ${m},${p.y} ${x2},${p.y}`}/>;})}</svg>{positions.map(p=>{const record=records.find(r=>r.id===p.node.id),children=nodes.filter(n=>n.parentId===p.node.id);const format=record?knowledgeFormat(record):'folder';return <div className={`kg-node ${selected===p.node.id?'selected':''} ${drop===p.node.id?'drop':''}`} data-knowledge-id={p.node.id} key={p.node.id} style={{left:p.x-p.width/2,top:p.y-p.height/2,width:p.width,minHeight:p.height}} tabIndex={0} aria-keyshortcuts={record?'Delete':undefined} onClick={event=>{if(!skipClick.current){event.currentTarget.focus({preventScroll:true});onSelect(p.node.id);}}} onDoubleClick={()=>onOpen(p.node.id)}
      onContextMenu={event=>{
        if(!record)return;
        event.preventDefault();event.stopPropagation();
        event.currentTarget.focus({preventScroll:true});
        setMenu({id:record.id,x:event.clientX,y:event.clientY,keyboard:false});
      }}
      onKeyDown={event=>{
        if(event.target!==event.currentTarget||event.nativeEvent.isComposing)return;
        if(event.key==='Enter'){onSelect(p.node.id);return;}
        if(!record)return;
        if(event.key==='Delete'&&!event.repeat&&!busy){
          event.preventDefault();event.stopPropagation();onDelete(record);
        }else if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){
          event.preventDefault();event.stopPropagation();
          const rect=event.currentTarget.getBoundingClientRect();
          setMenu({id:record.id,x:rect.left+8,y:rect.top+8,keyboard:true});
        }
      }}><NodeDot kind={format}/><span>{p.node.title}{record&&format!=='folder'&&<small>{knowledgeLabels[format]}</small>}</span>{onFold&&children.length>0&&<button className="kg-fold" aria-label={`${collapsed.includes(p.node.id)?'展开':'收起'}${p.node.title}`} onClick={e=>{e.stopPropagation();onFold(p.node.id);}}>{collapsed.includes(p.node.id)?'+':'−'}</button>}<button className="kg-add" aria-label={`在${p.node.title}下新建内容`} onClick={e=>{e.stopPropagation();onAdd(p.node.id);}}><Plus size={13}/></button></div>;})}</div><span className="kg-hint">右击或按 Delete 删除条目 · 拖动整理层级 · Ctrl 滚轮缩放</span><div className="kg-tools"><button aria-label="缩小知识图" onClick={()=>setCamera(c=>({...c,zoom:Math.max(.15,c.zoom-.1)}))}><Minus size={14}/></button><span>{Math.round(camera.zoom*100)}%</span><button aria-label="放大知识图" onClick={()=>setCamera(c=>({...c,zoom:Math.min(2,c.zoom+.1)}))}><Plus size={14}/></button><button onClick={fit}>适合画布</button></div>
    {menu&&menuRecord&&createPortal(<ManagementMenu x={menu.x} y={menu.y} keyboard={menu.keyboard}
      onClose={()=>setMenu(null)} actions={[{label:'删除',icon:Trash2,shortcut:'Delete',danger:true,disabled:busy,run:()=>onDelete(menuRecord)}]}/>,document.body)}
  </div>;
}
