import {memo,useCallback,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {ArrowDown,ChevronDown,ChevronUp,FileText,Paperclip,Search,X} from 'lucide-react';
import {observeElementRect,useVirtualizer,type Rect,type Virtualizer} from '@tanstack/react-virtual';
import MarkdownView from '../MarkdownView';
import type {AgentSession,Message,Run} from './core';
import {activityByMessage,type SessionTranscripts} from './session-transcript';
import {TranscriptActivities} from './RunActivity';
import CopyButton from '../CopyButton';
import {createTranscriptSearch,matchingTextRange,transcriptSearchPattern,type TranscriptMatch} from './session-search';
import './session-transcript.css';

const MessageRow=memo(function MessageRow({message,provider,demo,searchCurrent,onOpenLink,onOpenLocalPath}:{message:Message;provider:string;demo:boolean;searchCurrent:boolean;onOpenLink?: (url:string)=>void;onOpenLocalPath?:(path:string)=>void}){
  return <article className={`message message-${message.role}`} data-message-id={message.id} data-search-current={searchCurrent?true:undefined}>
    <span className="message-role">{message.role==='user'?'你':`${provider}${demo?' · 模拟回复':''}`}</span>
    {message.role==='assistant'?<MarkdownView value={message.text} onOpenLink={onOpenLink} onOpenLocalPath={onOpenLocalPath} allowRemoteImages={false} codeActions/>:<div className="message-text">{message.text}</div>}
    {!!message.files?.length&&<ul className="message-files" aria-label="引用和附件">{message.files.map(file=>{
      const attachment=file.kind==='attachment';
      const label=`${attachment?'附件':'引用'}：${file.name}`;
      return <li key={`${file.kind}:${file.path}`} aria-label={label} title={label}>
        {attachment?<Paperclip size={13} aria-hidden="true"/>:<FileText size={13} aria-hidden="true"/>}
        <span className="message-file-name">{file.name}</span>
      </li>;
    })}</ul>}
    <CopyButton text={message.text} label={message.role==='user'?'复制消息':'复制回复'}/>
  </article>;
});
export const SessionTranscript=memo(function SessionTranscript({session,store,provider,demo,active=true,visible,onOpenLink,onOpenLocalPath,activityRuns,children}:{
  session:AgentSession;store?:SessionTranscripts;provider:string;demo:boolean;active?:boolean;visible:boolean;onOpenLink?:(url:string)=>void;onOpenLocalPath?:(path:string)=>void;activityRuns?:readonly Run[];children:ReactNode;
}){
  const subscribe=useCallback((listener:()=>void)=>visible?store?.subscribe(session.id,listener)||(()=>{}):()=>{},[store,session.id,visible]);
  const snapshot=useCallback(()=>store?.get(session.id),[store,session.id]);
  const live=useSyncExternalStore(subscribe,snapshot,snapshot);
  const streamed=live&&live.revision>(session.nativeRevision||0)?live:undefined;
  const messages=streamed?.messages??session.messages;
  const progress=streamed?.activity;
  const activities=useMemo(()=>activityByMessage(activityRuns,progress),[activityRuns,progress]);
  const userId=messages.reduce<string|undefined>((id,message)=>message.role==='user'?message.id:id,undefined);
  const previousUser=useRef(userId);
  const scroller=useRef<HTMLDivElement>(null),follow=useRef(true),offset=useRef(0),wasVisible=useRef(false);
  const [detached,setDetached]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState<TranscriptMatch>();
  const searchInput=useRef<HTMLInputElement>(null);
  const previousFocus=useRef<HTMLElement | null>(null);
  const focusSearch=useRef(false),scrollToMatch=useRef(false);
  const searchVisible=visible&&active&&searchOpen;
  const term=searchVisible?query.trim():'';
  const search=useMemo(()=>createTranscriptSearch(term),[term]);
  const matches=useMemo(()=>search(messages),[search,messages]);
  const matchIndex=Math.max(0,selected?matches.findIndex(match=>match.messageId===selected.messageId&&match.offset===selected.offset):0);
  const match=matches[matchIndex];
  const matchId=match?.messageId, matchRow=match?.row, matchOffset=match?.offset;
  const matchMessage=matchRow===undefined?undefined:messages[matchRow];
  const matchOccurrence=match?.occurrence;
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
  const virtualItems=virtualizer.getVirtualItems();
  const matchMounted=!windowed||virtualItems.some(item=>item.index===matchRow);
  const toEnd=useCallback(()=>{
    if(windowed)virtualizer.scrollToEnd({behavior:'auto'});else if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;
  },[virtualizer,windowed]);
  useLayoutEffect(()=>{
    const element=scroller.current;if(!element||!visible)return;
    const observer=new ResizeObserver(()=>{if(follow.current)toEnd();});observer.observe(element);return()=>observer.disconnect();
  },[visible,toEnd]);
  useLayoutEffect(()=>{
    if(userId!==previousUser.current){if(!matchId){follow.current=true;setDetached(false);}previousUser.current=userId;}
    if(visible){if(follow.current)toEnd();else if(!wasVisible.current){if(windowed)virtualizer.scrollToOffset(offset.current);else if(scroller.current)scroller.current.scrollTop=offset.current;}}
    wasVisible.current=visible;
  },[visible,messages,activities,total,children,toEnd,virtualizer,windowed,userId,matchId]);

  const closeSearch=useCallback(()=>{
    setSearchOpen(false);
    setQuery('');
    setSelected(undefined);
    const element=scroller.current;
    if(element&&element.scrollHeight-element.scrollTop-element.clientHeight<16){
      follow.current=true;
      setDetached(false);
    }
    const previous=previousFocus.current;
    (previous?.isConnected?previous:element)?.focus({preventScroll:true});
    previousFocus.current=null;
  },[]);
  useLayoutEffect(()=>{
    if(!visible||!active||!scroller.current)return;
    const view=scroller.current.closest('.session-view')||scroller.current.parentElement;
    const tabPanel=view?.closest('[role="tabpanel"]');
    function find(event:KeyboardEvent){
      if(event.defaultPrevented||event.isComposing||event.keyCode===229||!(event.target instanceof Element))return;
      const target=event.target;
      const fromView=view?.contains(target);
      const fromTab=tabPanel?.id&&target.closest('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls')===tabPanel.id;
      if(!fromView&&!fromTab)return;
      if(searchVisible&&event.key==='Escape'){
        if(target.closest('textarea[aria-controls], [role="listbox"], [role="menu"]'))return;
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }
      if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||event.key.toLowerCase()!=='f')return;
      event.preventDefault();
      event.stopPropagation();
      if(searchVisible){searchInput.current?.focus({preventScroll:true});searchInput.current?.select();return;}
      previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
      focusSearch.current=true;
      setSearchOpen(true);
    }
    window.addEventListener('keydown',find,true);
    return()=>window.removeEventListener('keydown',find,true);
  },[visible,active,searchVisible,closeSearch]);

  useLayoutEffect(()=>{
    if(searchVisible&&focusSearch.current){searchInput.current?.focus({preventScroll:true});focusSearch.current=false;}
  },[searchVisible]);

  useLayoutEffect(()=>{
    if(matchRow===undefined){scrollToMatch.current=false;return;}
    follow.current=false;
    scrollToMatch.current=true;
    if(windowed&&!scroller.current?.querySelector('[data-search-current]'))virtualizer.scrollToIndex(matchRow,{align:'start',behavior:'auto'});
  },[term,matchId,matchRow,matchOffset,virtualizer,windowed]);

  useLayoutEffect(()=>{
    const element=scroller.current;
    if(!element||!matchMounted||matchOccurrence===undefined)return;
    const message=element.querySelector<HTMLElement>('[data-search-current]');
    if(!message)return;
    const contents=message.querySelectorAll<HTMLElement>(':scope>.message-text,:scope>.markdown-content,.message-file-name');
    const range=matchingTextRange(contents,transcriptSearchPattern(term),matchOccurrence);
    if(range)CSS.highlights?.set('draftway-search-current',new Highlight(range));
    const frame=scrollToMatch.current?requestAnimationFrame(()=>{
      scrollToMatch.current=false;
      const target=(range||message).getBoundingClientRect();
      const top=element.getBoundingClientRect().top;
      const position=Math.max(0,element.scrollTop+target.top-top-Math.max(14,(element.clientHeight-target.height)/2));
      if(windowed)virtualizer.scrollToOffset(position,{behavior:'auto'});else element.scrollTop=position;
    }):0;
    return()=>{
      if(frame)cancelAnimationFrame(frame);
      CSS.highlights?.delete('draftway-search-current');
    };
  },[term,matchMessage,matchMounted,matchOccurrence,matchRow,virtualizer,windowed]);

  function seek(direction:number){
    if(matches.length)setSelected(matches[(matchIndex+direction+matches.length)%matches.length]);
  }
  function readScroll(){const element=scroller.current;if(!element||!visible)return;const top=element.scrollTop,distance=element.scrollHeight-top-element.clientHeight;
    if(top<offset.current-2&&distance>60)follow.current=false;
    if(top>offset.current&&distance<16&&!matchId)follow.current=true;
    offset.current=top;setDetached(!follow.current&&distance>24);
  }
  const row=(message:Message)=>{
    const entries=activities.get(message.id);
    return <>
      <MessageRow message={message} provider={provider} demo={demo} searchCurrent={message.id===matchId} onOpenLink={onOpenLink} onOpenLocalPath={onOpenLocalPath}/>
      {entries && <TranscriptActivities entries={entries}/>}
    </>;
  };
  return <div className="transcript-host">{searchVisible&&<div role="search" aria-label="查找会话内容" className="transcript-search">
    <Search size={15} aria-hidden="true"/>
    <input ref={searchInput} aria-label="查找会话内容" placeholder="查找会话内容" value={query} onChange={event=>{setQuery(event.target.value);setSelected(undefined);}}
      onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();seek(event.shiftKey?-1:1);}}}/>
    <span role="status">{term?(matches.length?`${matchIndex+1} / ${matches.length}`:'无匹配'):' '}</span>
    <button type="button" disabled={!matches.length} aria-label="上一个匹配" title="上一个匹配（Shift + Enter）" onClick={()=>seek(-1)}><ChevronUp size={16}/></button>
    <button type="button" disabled={!matches.length} aria-label="下一个匹配" title="下一个匹配（Enter）" onClick={()=>seek(1)}><ChevronDown size={16}/></button>
    <button type="button" aria-label="关闭查找" title="关闭查找（Esc）" onClick={closeSearch}><X size={16}/></button>
  </div>}<div className={`transcript ${windowed?'windowed-transcript':''}`} ref={scroller} role="log" aria-label="会话记录" aria-live="off" aria-keyshortcuts="Control+F Meta+F" tabIndex={0} onScroll={readScroll}
    onWheel={event=>{if(event.deltaY<0)follow.current=false;}} onTouchStart={()=>{follow.current=false;}}
    onKeyDown={event=>{if(['PageUp','Home','ArrowUp'].includes(event.key))follow.current=false;}}>
    {windowed?<div className="transcript-sizer" style={{height:total}}>{virtualItems.map(item=><div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="transcript-row" style={{transform:`translateY(${item.start}px)`}}>{item.index<messages.length?row(messages[item.index]):children}</div>)}</div>:
      <>{messages.map(message=><div className="transcript-flow-row" key={message.id}>{row(message)}</div>)}{children}</>}
  </div>{detached&&<button className="jump-to-latest" aria-label="回到最新消息" onClick={()=>{follow.current=true;setDetached(false);toEnd();}}><ArrowDown size={14}/>回到最新</button>}</div>;
});
