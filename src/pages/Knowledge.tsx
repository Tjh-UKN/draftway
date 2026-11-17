import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {BookOpen,FileText,Plus,Search} from 'lucide-react';
import {useWorkbench} from '../workbench';
import {dateLabel,type Note} from '../domain';
import {knowledgeFormat,newKnowledge} from '../knowledge-graph';
import type {KnowledgeEditorHandle} from '../KnowledgeEditor';
import '../note-editor.css';
const KnowledgeGraph=lazy(()=>import('./KnowledgeGraph'));
const KnowledgeEditor=lazy(()=>import('../KnowledgeEditor'));
export default function Knowledge({personal=false}:{personal?:boolean}){return personal?<Suspense fallback={<p>正在打开知识图…</p>}><KnowledgeGraph/></Suspense>:<Notes/>;}
function Notes(){
 const ctx=useWorkbench();const [query,setQuery]=useState('');const [selected,setSelected]=useState<string|null>(null);const [created,setCreated]=useState<Note|null>(null);const [switching,setSwitching]=useState(false);const editor=useRef<KnowledgeEditorHandle>(null);const search=useRef<HTMLInputElement>(null);
 const records=ctx.data.records.filter((record):record is Note=>record.kind==='note'&&!record.archived&&knowledgeFormat(record)!=='folder').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const notes=created&&!records.some(note=>note.id===created.id)?[created,...records]:records;
 const matching=notes.filter(note=>`${note.title} ${note.body} ${note.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
 const current=notes.find(note=>note.id===selected)||notes[0];
 async function select(id:string){if(id===current?.id)return;setSwitching(true);try{await editor.current?.flush();setSelected(id);}catch{/* The editor shows the save failure and retains the draft. */}finally{setSwitching(false);}}
 async function create(){setSwitching(true);try{await editor.current?.flush();const note=newKnowledge('markdown') as Note;setCreated(note);setSelected(note.id);setQuery('');}catch{/* Retain the current editor on failure. */}finally{setSwitching(false);}}
 const actions=useRef({create});actions.current={create};
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!(event.ctrlKey||event.metaKey)||document.querySelector('[role="dialog"]'))return;if(event.key.toLowerCase()==='n'){event.preventDefault();event.stopImmediatePropagation();void actions.current.create();}if(event.key.toLowerCase()==='o'){event.preventDefault();search.current?.focus();search.current?.select();}};document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);},[]);
 return <section className="notes-workspace" aria-label="笔记工作区"><aside className="notes-explorer" aria-label="笔记列表"><header><strong>笔记</strong><button className="icon-button" title="新建笔记 Ctrl N" aria-label="新建笔记" disabled={switching} onClick={()=>void create()}><Plus size={17}/></button></header>
  <label className="notes-search"><Search size={14}/><input ref={search} placeholder="搜索笔记…" aria-label="搜索笔记" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&matching[0])void select(matching[0].id);if(event.key==='Escape'){setQuery('');event.currentTarget.blur();}}}/></label>
  <div className="notes-file-list">{matching.map(note=><button key={note.id} className={note.id===current?.id?'selected':''} aria-current={note.id===current?.id?'page':undefined} disabled={switching} onClick={()=>void select(note.id)}><FileText size={14}/><span><strong>{note.title||'未命名笔记'}</strong><small>{dateLabel(note.updatedAt)}</small></span></button>)}{!matching.length&&<p className="notes-empty">{query?'没有匹配的笔记':'还没有笔记'}</p>}</div>
  <footer>Ctrl N 新建 · Ctrl O 查找</footer>
 </aside><div className="notes-document-pane">{current?<Suspense fallback={<p className="notes-empty">正在打开笔记…</p>}><KnowledgeEditor key={current.id} ref={editor} initial={current} inline onClose={()=>{setCreated(null);setSelected(null);}}/></Suspense>:<div className="notes-blank"><BookOpen size={24}/><p>写下一个想法</p><button className="button" onClick={()=>void create()}><Plus size={14}/>新建笔记</button></div>}</div></section>;
}
