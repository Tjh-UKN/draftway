import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Bold,Italic,Link2,List} from 'lucide-react';
import {Compartment,EditorState} from '@codemirror/state';
import {Decoration,EditorView,keymap,placeholder,ViewPlugin,type DecorationSet,type ViewUpdate} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {HighlightStyle,syntaxHighlighting,syntaxTree} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {highlightSelectionMatches,searchKeymap} from '@codemirror/search';
import MarkdownView from './MarkdownView';
import {insertMarkdown,type MarkdownAction} from './markdown';
import {markdownDecorations} from './markdown-live';
import './note-editor.css';
import {useNotePlugins} from './plugins/NotePlugins';

const noteHighlight=HighlightStyle.define([{tag:tags.heading,fontWeight:'600',color:'var(--text)'},{tag:tags.strong,fontWeight:'600'},{tag:tags.emphasis,fontStyle:'italic'},{tag:tags.strikethrough,textDecoration:'line-through'},{tag:[tags.monospace,tags.url],fontFamily:'Consolas,monospace',color:'var(--muted)'},{tag:tags.link,textDecoration:'underline'},{tag:tags.processingInstruction,color:'var(--faint)'}]);

const livePreview=ViewPlugin.fromClass(class {
 decorations:DecorationSet;
 constructor(view:EditorView){this.decorations=this.build(view);}
 update(update:ViewUpdate){if(update.docChanged||update.selectionSet||update.viewportChanged||update.focusChanged||syntaxTree(update.startState)!==syntaxTree(update.state))this.decorations=this.build(update.view);}
 build(view:EditorView){return Decoration.set(markdownDecorations(view.state,view.hasFocus,view.visibleRanges).map(range=>range.line?Decoration.line({class:range.className}).range(range.from):Decoration.replace({}).range(range.from,range.to)),true);}
},{decorations:plugin=>plugin.decorations});

export default function MarkdownEditor({value,onChange,onOpenLink,readOnly=false,allowRemoteImages=true,autoFocus=false,documentId='',title='',heading}:{value:string;onChange:(value:string)=>void;onOpenLink:(url:string)=>void;readOnly?:boolean;allowRemoteImages?:boolean;autoFocus?:boolean;documentId?:string;title?:string;heading?:ReactNode}){
 const [mode,setMode]=useState<'live'|'source'|'reading'>(readOnly?'reading':'live');const host=useRef<HTMLDivElement>(null);const reading=useRef<HTMLDivElement>(null);const priorMode=useRef(mode);const view=useRef<EditorView|null>(null);const options=useRef({onChange,readOnly});options.current={onChange,readOnly};const live=useRef(new Compartment());const readonly=useRef(new Compartment());
 const revision=useRef(0);const metadata=useRef({id:documentId,title});metadata.current={id:documentId,title};
 const plugins=useNotePlugins({
  read:()=>{const editor=view.current;if(!editor)throw Error('编辑器尚未就绪');const selection=editor.state.selection.main;return {...metadata.current,text:editor.state.doc.toString(),revision:revision.current,selection:{from:selection.from,to:selection.to,text:editor.state.sliceDoc(selection.from,selection.to)}};},
  edit:(from,to,text)=>{const editor=view.current!;editor.dispatch({changes:{from,to,insert:text},selection:{anchor:from+text.length},scrollIntoView:true});editor.focus();},
  select:(from,to)=>{const editor=view.current!;editor.dispatch({selection:{anchor:from,head:to},scrollIntoView:true});editor.focus();},
  readOnly:()=>options.current.readOnly,
 },value,!!documentId);
 function insert(action:MarkdownAction){const editor=view.current;if(!editor||options.current.readOnly)return;const selection=editor.state.selection.main;const next=insertMarkdown(editor.state.doc.toString(),selection.from,selection.to,action);editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:next.value},selection:{anchor:next.start,head:next.end},scrollIntoView:true});editor.focus();}
 useEffect(()=>{
  const editor=new EditorView({parent:host.current!,state:EditorState.create({doc:value,extensions:[history(),markdown({base:markdownLanguage}),syntaxHighlighting(noteHighlight),EditorView.lineWrapping,highlightSelectionMatches(),EditorState.phrases.of({'Find':'查找','Replace':'替换','next':'下一个','previous':'上一个','all':'全部','match case':'区分大小写','regexp':'正则表达式','by word':'全词匹配','replace':'替换','replace all':'全部替换','close':'关闭','No matches':'没有匹配项','replaced $ matches':'已替换 $ 处'}),EditorView.contentAttributes.of({'aria-label':'笔记正文','aria-multiline':'true',spellcheck:'false'}),placeholder('开始写作…'),readonly.current.of(EditorState.readOnly.of(readOnly)),live.current.of(readOnly?[]:livePreview),keymap.of([{key:'Mod-b',run:()=>{insert('bold');return true;}},{key:'Mod-i',run:()=>{insert('italic');return true;}},...defaultKeymap,...historyKeymap,...searchKeymap,indentWithTab]),EditorView.updateListener.of(update=>{if(update.docChanged){revision.current++;options.current.onChange(update.state.doc.toString());}})]})});view.current=editor;
  if(autoFocus&&!readOnly)editor.focus();
  return()=>{view.current=null;editor.destroy();};
 },[]);
 useEffect(()=>{const editor=view.current;if(editor&&value!==editor.state.doc.toString())editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:value}});},[value]);
 useEffect(()=>{view.current?.dispatch({effects:[live.current.reconfigure(mode==='live'?livePreview:[]),readonly.current.reconfigure(EditorState.readOnly.of(readOnly))]});if(mode!=='reading')view.current?.requestMeasure();},[mode,readOnly]);
 useEffect(()=>{if(mode!==priorMode.current){if(mode==='reading')reading.current?.focus();else view.current?.focus();priorMode.current=mode;}},[mode]);
 return <section className={`note-markdown-editor ${mode}`} aria-label="Markdown 笔记编辑器" onKeyDown={event=>{if(event.currentTarget.querySelector('dialog[open]'))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='e'){event.preventDefault();setMode(old=>old==='reading'?(readOnly?'source':'live'):'reading');}}}>
  <div className="note-plugin-workarea"><div className="note-writing-surface">
  <header className="note-writing-tools"><div className="note-mode-tabs" role="tablist" aria-label="笔记编辑模式">{([['live','实时预览'],['source','源码'],['reading','阅读']] as const).filter(([key])=>!readOnly||key!=='live').map(([key,label])=><button type="button" role="tab" aria-selected={mode===key} key={key} onClick={()=>setMode(key)}>{label}</button>)}</div><div className="note-tools-right">{mode!=='reading'&&!readOnly&&<div className="note-format-tools">{([{action:'bold',label:'加粗',icon:Bold},{action:'italic',label:'斜体',icon:Italic},{action:'list',label:'列表',icon:List},{action:'link',label:'链接',icon:Link2}] as const).map(({action,label,icon:Icon})=><button type="button" title={label} aria-label={label} key={action} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(action)}><Icon size={14}/></button>)}</div>}{plugins.controls}</div></header>
  {heading}
  <div ref={host} className="note-cm-host" hidden={mode==='reading'}/>
  {mode==='reading'&&<div ref={reading} className="note-reading" tabIndex={0}>{value?<MarkdownView value={value} allowRemoteImages={allowRemoteImages} onOpenLink={onOpenLink}/>:<p className="muted">空白笔记</p>}</div>}
  </div>{plugins.panel}</div>{plugins.runner}
  <footer className="note-writing-status"><span>Ctrl E 切换阅读 · Ctrl F 查找</span><span>{value.length.toLocaleString()} 字符</span></footer>
 </section>;
}
