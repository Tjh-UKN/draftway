import { useDeferredValue,useId,useRef,useState,type KeyboardEvent } from 'react';
import { Bold, CheckSquare, Code2, Heading2, Italic, Link2, List, Quote, Table2 } from 'lucide-react';
import MarkdownView from './MarkdownView';
import {insertMarkdown,type MarkdownAction} from './markdown';
const actions=[{action:'heading',label:'插入标题',icon:Heading2},{action:'bold',label:'加粗',icon:Bold},{action:'italic',label:'斜体',icon:Italic},{action:'list',label:'无序列表',icon:List},{action:'checklist',label:'任务列表',icon:CheckSquare},{action:'quote',label:'引用',icon:Quote},{action:'code',label:'代码块',icon:Code2},{action:'link',label:'链接',icon:Link2},{action:'table',label:'表格',icon:Table2}] as const;
export default function MarkdownEditor({value,onChange,onOpenLink,readOnly=false}:{value:string;onChange:(value:string)=>void;onOpenLink:(url:string)=>void;readOnly?:boolean}){
 const [mode,setMode]=useState<'edit'|'preview'|'split'>(readOnly?'preview':'edit');const textarea=useRef<HTMLTextAreaElement>(null);const deferred=useDeferredValue(value);const id=useId();
 function insert(action:MarkdownAction){if(readOnly)return;const el=textarea.current;const next=insertMarkdown(value,el?.selectionStart??value.length,el?.selectionEnd??value.length,action);onChange(next.value);requestAnimationFrame(()=>{textarea.current?.focus();textarea.current?.setSelectionRange(next.start,next.end);});}
 function keys(e:KeyboardEvent<HTMLTextAreaElement>){if(!(e.ctrlKey||e.metaKey))return;const key=e.key.toLowerCase();if(key==='b'||key==='i'){e.preventDefault();insert(key==='b'?'bold':'italic');}}
 return <section className="markdown-editor" aria-label="Markdown 笔记编辑器"><div className="markdown-editor-header"><span>Markdown</span><div className="markdown-mode-tabs" role="tablist" aria-label="笔记编辑模式">{([['edit','编辑'],['preview','预览'],['split','分屏']] as const).map(([key,label])=><button type="button" id={`${id}-${key}`} role="tab" aria-controls={`${id}-content`} aria-selected={mode===key} className={mode===key?'selected':''} key={key} onClick={()=>setMode(key)}>{label}</button>)}</div></div>
  {mode!=='preview'&&!readOnly&&<div className="markdown-format-toolbar" aria-label="Markdown 格式工具">{actions.map(({action,label,icon:Icon})=><button type="button" className="icon-button" title={label} aria-label={label} key={action} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(action)}><Icon size={15}/></button>)}<span>Ctrl B / Ctrl I</span></div>}
  <div className={`markdown-edit-panes ${mode}`} id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>
   {mode!=='preview'&&<label className="markdown-source-field"><span className="small muted">笔记正文</span><textarea ref={textarea} className="markdown-source note-editor" value={value} onChange={e=>onChange(e.target.value)} onKeyDown={keys} readOnly={readOnly} maxLength={500000} spellCheck={false} placeholder="# 标题\n\n记录想法、过程和经验……" rows={12}/></label>}
   {mode!=='edit'&&<div className="markdown-live-preview" aria-label="Markdown 预览" aria-busy={value!==deferred}>{deferred?<MarkdownView value={deferred} onOpenLink={onOpenLink}/>:<p className="small muted empty-inline">写一点内容，就能看到排版预览。</p>}</div>}
  </div><div className="markdown-editor-status"><span>标题 · 列表 · 代码块 · 表格 · 引用</span><span>{value.length.toLocaleString()} 字符</span></div>
 </section>;
}
