import {memo,useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Send,Square} from 'lucide-react';
import type {AgentSession} from './core';
import type {ChangeState} from './Sessions';
import {changeQueuedMessage,pauseChatQueue,resumeChatQueue} from './chat-queue';
import {useSessionFiles} from './SessionFiles';
import type {ChatFile} from './session-files';
import './session-queue.css';

const draftKey=(id:string)=>`northstar-session-draft:${id}`;
const noFiles:ChatFile[]=[];
function readDraft(session:AgentSession){try{return localStorage.getItem(draftKey(session.id))??session.draft;}catch{return session.draft;}}

export const SessionComposer=memo(function SessionComposer({session,change,active,busy,stopping,disabled,canSend,onSend,onStop,options,queueEnabled=false}:{
  session:AgentSession;change:ChangeState;active:boolean;busy:boolean;stopping:boolean;
  disabled:boolean;canSend:boolean;onSend:(text:string,files:ChatFile[])=>boolean|void;onStop:()=>void;
  options?:ReactNode;
  queueEnabled?:boolean;
}){
  const [draft,setDraft]=useState(()=>readDraft(session));
  const [draftError,setDraftError]=useState('');
  const local=useRef({value:draft,committed:session.draft,dirty:draft!==session.draft});
  const input=useRef<HTMLTextAreaElement>(null),composing=useRef(false);
  const files=session.draftFiles??noFiles;
  const messages=session.queuedMessages??[];
  const queueing=queueEnabled&&(busy||messages.length>0);
  const emptyDraft=!draft.trim()&&!files.length;
  const [editing,setEditing]=useState<{id:string;text:string}|null>(null);
  const updateFiles=useCallback((draftFiles:ChatFile[])=>{
    change(state=>({...state,sessions:state.sessions.map(item=>item.id===session.id?{...item,draftFiles}:item)}));
  },[change,session.id]);
  const updateDraft=useCallback((value:string)=>{
    local.current.value=value;local.current.dirty=true;setDraft(value);
    try{localStorage.setItem(draftKey(session.id),value);setDraftError('');}catch{setDraftError('草稿暂存在当前窗口，请勿关闭');}
  },[session.id]);
  const fileControls=useSessionFiles({id:session.id,enabled:active&&!disabled&&queueEnabled&&canSend,files,onChangeFiles:updateFiles,value:draft,onChangeValue:updateDraft,input});
  const flush=useCallback(()=>{
    if(!local.current.dirty)return;
    const value=local.current.value;local.current.committed=value;local.current.dirty=false;
    change(state=>{
      const target=state.sessions.find(s=>s.id===session.id);
      return !target||target.draft===value?state:{...state,sessions:state.sessions.map(s=>s.id===session.id?{...s,draft:value}:s)};
    });
  },[change,session.id]);
  useEffect(()=>{
    if(!local.current.dirty&&session.draft!==local.current.committed){local.current={value:session.draft,committed:session.draft,dirty:false};setDraft(session.draft);try{localStorage.removeItem(draftKey(session.id));}catch{/* The canonical draft remains in workspace storage. */}}
  },[session.draft]);
  useEffect(()=>{if(!local.current.dirty)return;const timer=setTimeout(flush,180);return()=>clearTimeout(timer);},[draft,flush]);
  useEffect(()=>{
    const visibility=()=>{if(document.visibilityState==='hidden')flush();};
    window.addEventListener('pagehide',flush);document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('pagehide',flush);document.removeEventListener('visibilitychange',visibility);flush();};
  },[flush]);
  useEffect(()=>{if(active&&!(document.activeElement as HTMLElement|null)?.closest('[role="tablist"]'))input.current?.focus();else if(!active)flush();},[active,flush]);
  useLayoutEffect(()=>{const element=input.current;if(element){element.style.height='0px';element.style.height=`${Math.min(220,Math.max(55,element.scrollHeight))}px`;}},[draft]);
  function send(){
    const text=local.current.value;if((busy&&!queueing)||!canSend||(!text.trim()&&!files.length)||composing.current)return;
    if(onSend(text,files)===false)return;
    local.current={value:'',committed:'',dirty:false};setDraft('');try{localStorage.removeItem(draftKey(session.id));}catch{/* Workspace and provider records remain authoritative. */}
  }
  return <form className="session-composer isolated-composer" onSubmit={event=>{event.preventDefault();send();}}>
    {!!messages.length&&<section className="chat-queue" aria-label="消息队列">
      <header><span role="status">{session.queuePaused?'队列已暂停':'排队中'} · {messages.length} 条</span>
        {session.queuePaused&&<button type="button" className="text-button" disabled={!canSend||busy||!!editing} onClick={()=>change(state=>resumeChatQueue(state,session.id))}>继续发送</button>}
      </header>
      <ol>{messages.map(message=><li key={message.id}>
        {editing?.id===message.id?<>
          <textarea aria-label="编辑排队消息" maxLength={20000} autoFocus value={editing.text} onChange={event=>setEditing({id:message.id,text:event.target.value})}/>
          <button type="button" className="text-button" disabled={(!editing.text.trim()&&!message.files?.length)||!canSend} onClick={()=>{change(state=>changeQueuedMessage(state,session.id,message.id,editing.text));setEditing(null);}}>保存</button>
          <button type="button" className="text-button" onClick={()=>setEditing(null)}>取消</button>
        </>:<>
          <span className="chat-queue-preview" title={message.text}>{message.text}{message.files?.length ? <small>{message.files.map(file=>file.name).join('、')}</small>:null}</span>
          <button type="button" className="text-button" disabled={!canSend||!!editing} onClick={()=>{change(state=>pauseChatQueue(state,session.id));setEditing({id:message.id,text:message.text});}}>编辑</button>
          <button type="button" className="text-button" disabled={!canSend||!!editing} onClick={()=>change(state=>changeQueuedMessage(state,session.id,message.id))}>移除</button>
        </>}
      </li>)}</ol>
    </section>}
    {fileControls.chips}
    {fileControls.suggestions}
    <textarea ref={input} {...fileControls.textareaProps} aria-label="会话消息" placeholder={queueing?'输入下一条消息，按 Enter 加入队列':busy?'先写下下一步，草稿会保留':'在这里输入消息…'} value={draft} maxLength={20000} disabled={disabled}
      onBlur={()=>{fileControls.onBlur();flush();}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onChange={event=>updateDraft(event.target.value)}
      onKeyDown={event=>{
        if(event.nativeEvent.isComposing||composing.current||event.nativeEvent.keyCode===229||fileControls.handleKeyDown(event))return;
        if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}
      }}/>
    <div className="composer-toolbar chat-composer-actions">{fileControls.picker}{options}<span className="composer-key-hint" role={draftError?'alert':undefined}>{draftError||'Shift + Enter 换行'}</span>
      {queueing&&<button type="button" className="outline-button chat-queue-add" disabled={emptyDraft||!canSend} onClick={send}>加入队列</button>}
      {busy&&<button type="button" className="icon-button stop-button" disabled={disabled||stopping} aria-label="停止生成" onClick={onStop}><Square size={14}/></button>}
      {!busy&&!queueing&&<button type="button" className="send-button" aria-label="发送消息" disabled={emptyDraft||!canSend} onClick={send}><Send size={15}/></button>}
    </div>
  </form>;
});
