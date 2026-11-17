import {memo,useCallback,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {ArrowDown} from 'lucide-react';
import {observeElementRect,useVirtualizer,type Rect,type Virtualizer} from '@tanstack/react-virtual';
import MarkdownView from '../MarkdownView';
import type {AgentSession,Message} from './core';
import type {SessionTranscripts} from './session-transcript';
import CopyButton from '../CopyButton';
const MessageRow=memo(function MessageRow({message,provider,demo,onOpenLink}:{message:Message;provider:string;demo:boolean;onOpenLink?: (url:string)=>void}){
  return <article className={`message message-${message.role}`} data-message-id={message.id}>
    <span className="message-role">{message.role==='user'?'你':`${provider}${demo?' · 模拟回复':''}`}</span>
    {message.role==='assistant'?<MarkdownView value={message.text} onOpenLink={onOpenLink} allowRemoteImages={false} codeActions/>:<div>{message.text}</div>}
    <CopyButton text={message.text} label={message.role==='user'?'复制消息':'复制回复'}/>
  </article>;
});
export const SessionTranscript=memo(function SessionTranscript({session,store,provider,demo,visible,onOpenLink,children}:{
  session:AgentSession;store?:SessionTranscripts;provider:string;demo:boolean;visible:boolean;onOpenLink?:(url:string)=>void;children:ReactNode;
}){
  const subscribe=useCallback((listener:()=>void)=>visible?store?.subscribe(session.id,listener)||(()=>{}):()=>{},[store,session.id,visible]);
  const snapshot=useCallback(()=>store?.get(session.id),[store,session.id]);
  const live=useSyncExternalStore(subscribe,snapshot,snapshot);
  const messages=live&&live.revision>(session.nativeRevision||0)?live.messages:session.messages;
  const userId=messages.reduce<string|undefined>((id,message)=>message.role==='user'?message.id:id,undefined);
  const previousUser=useRef(userId);
  const scroller=useRef<HTMLDivElement>(null),follow=useRef(true),offset=useRef(0),wasVisible=useRef(false);
  const [detached,setDetached]=useState(false);
  const windowed=messages.length>40;
  const latest=useRef(messages);latest.current=messages;
  const sizes=useRef(new Map<string,number>());
  const key=useCallback((index:number)=>latest.current[index]?.id||'transcript-footer',[]);
  const estimate=useCallback((index:number)=>Math.min(1200,Math.max(100,Math.ceil((latest.current[index]?.text.length||100)/75)*24+75)),[]);
  // display:none must not replace retained row measurements with zero-sized estimates.
  const observe=useCallback((instance:Virtualizer<HTMLDivElement,HTMLDivElement>,callback:(rect:Rect)=>void)=>observeElementRect(instance,rect=>{if(rect.width&&rect.height)callback(rect);}),[]);
  const measure=useCallback((element:HTMLDivElement)=>{const index=Number(element.dataset.index),id=key(index),height=element.getBoundingClientRect().height;if(height)sizes.current.set(id,height);return height||sizes.current.get(id)||estimate(index);},[key,estimate]);
  const virtualizer=useVirtualizer<HTMLDivElement,HTMLDivElement>({count:windowed?messages.length+1:0,getScrollElement:()=>scroller.current,getItemKey:key,estimateSize:estimate,overscan:5,enabled:windowed,initialOffset:()=>offset.current,anchorTo:'end',followOnAppend:false,scrollEndThreshold:-1,observeElementRect:observe,measureElement:measure});
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange=(item,_delta,instance)=>follow.current||item.end<=(instance.scrollOffset||0);
  const total=virtualizer.getTotalSize();
  const toEnd=useCallback(()=>{
    if(windowed)virtualizer.scrollToEnd({behavior:'auto'});else if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;
  },[virtualizer,windowed]);
  useLayoutEffect(()=>{
    const element=scroller.current;if(!element||!visible)return;
    const observer=new ResizeObserver(()=>{if(follow.current)toEnd();});observer.observe(element);return()=>observer.disconnect();
  },[visible,toEnd]);
  useLayoutEffect(()=>{
    if(userId!==previousUser.current){follow.current=true;setDetached(false);previousUser.current=userId;}
    if(visible){if(follow.current)toEnd();else if(!wasVisible.current){if(windowed)virtualizer.scrollToOffset(offset.current);else if(scroller.current)scroller.current.scrollTop=offset.current;}}
    wasVisible.current=visible;
  },[visible,messages,total,children,toEnd,virtualizer,windowed,userId]);
  function readScroll(){const element=scroller.current;if(!element||!visible)return;const top=element.scrollTop,distance=element.scrollHeight-top-element.clientHeight;
    if(top<offset.current-2&&distance>60)follow.current=false;
    if(top>offset.current&&distance<16)follow.current=true;
    offset.current=top;setDetached(!follow.current&&distance>24);
  }
  const row=(message:Message)=><MessageRow message={message} provider={provider} demo={demo} onOpenLink={onOpenLink}/>;
  return <div className="transcript-host"><div className={`transcript ${windowed?'windowed-transcript':''}`} ref={scroller} role="log" aria-label="会话记录" aria-live="off" onScroll={readScroll}
    onWheel={event=>{if(event.deltaY<0)follow.current=false;}} onTouchStart={()=>{follow.current=false;}}
    onKeyDown={event=>{if(['PageUp','Home','ArrowUp'].includes(event.key))follow.current=false;}}>
    {windowed?<div className="transcript-sizer" style={{height:total}}>{virtualizer.getVirtualItems().map(item=><div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="transcript-row" style={{transform:`translateY(${item.start}px)`}}>{item.index<messages.length?row(messages[item.index]):children}</div>)}</div>:
      <>{messages.map(message=><div className="transcript-flow-row" key={message.id}>{row(message)}</div>)}{children}</>}
  </div>{detached&&<button className="jump-to-latest" aria-label="回到最新消息" onClick={()=>{follow.current=true;setDetached(false);toEnd();}}><ArrowDown size={14}/>回到最新</button>}</div>;
});
