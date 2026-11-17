import {memo,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Send,Square} from 'lucide-react';
import type {AgentSession} from './core';
import type {ChangeState} from './Sessions';
const draftKey=(id:string)=>`northstar-session-draft:${id}`;
function readDraft(session:AgentSession){try{return localStorage.getItem(draftKey(session.id))??session.draft;}catch{return session.draft;}}

export const SessionComposer=memo(function SessionComposer({session,change,active,busy,stopping,disabled,canSend,onSend,onStop}:{
  session:AgentSession;change:ChangeState;active:boolean;busy:boolean;stopping:boolean;
  disabled:boolean;canSend:boolean;onSend:(text:string)=>void;onStop:()=>void;
}){
  const [draft,setDraft]=useState(()=>readDraft(session));
  const [draftError,setDraftError]=useState('');
  const local=useRef({value:draft,committed:session.draft,dirty:draft!==session.draft});
  const input=useRef<HTMLTextAreaElement>(null),composing=useRef(false);
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
    const text=local.current.value;if(busy||!canSend||!text.trim()||composing.current)return;
    local.current={value:'',committed:'',dirty:false};setDraft('');try{localStorage.removeItem(draftKey(session.id));}catch{/* Workspace and provider records remain authoritative. */}onSend(text);
  }
  return <form className="session-composer isolated-composer" onSubmit={event=>{event.preventDefault();send();}}>
    <textarea ref={input} aria-label="会话消息" placeholder={busy?'先写下下一步，草稿会保留':'在这里输入消息…'} value={draft} maxLength={20000} disabled={disabled}
      onBlur={flush} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onChange={event=>{const value=event.target.value;local.current.value=value;local.current.dirty=true;setDraft(value);try{localStorage.setItem(draftKey(session.id),value);setDraftError('');}catch{setDraftError('草稿暂存在当前窗口，请勿关闭');}}}
      onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!composing.current&&event.nativeEvent.keyCode!==229){event.preventDefault();send();}}}/>
    <div className="composer-toolbar chat-composer-actions"><span className="composer-key-hint" role={draftError?'alert':undefined}>{draftError||'Shift + Enter 换行'}</span>{busy?
      <button type="button" className="icon-button stop-button" disabled={disabled||stopping} aria-label="停止生成" onClick={onStop}><Square size={14}/></button>:
      <button type="button" className="send-button" aria-label="发送消息" disabled={!draft.trim()||!canSend} onClick={send}><Send size={15}/></button>}
    </div>
  </form>;
});
