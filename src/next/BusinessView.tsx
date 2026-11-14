import {useEffect,useRef,useState} from 'react';
import {businessComponents,isBusinessPage} from '../business-components';
import type {DockTab} from './docking';
export function BusinessView({tab,active,onChange,workspaceId}:{workspaceId:string;tab:Extract<DockTab,{kind:'business'}>;active:boolean;onChange:(tab:DockTab)=>void}) {
  const frame=useRef<HTMLIFrameElement>(null);const [overlay,setOverlay]=useState(false);
  const current=useRef({tab,active,onChange});current.current={tab,active,onChange};
  const [entry]=useState(tab.page);
  useEffect(()=>{
    const notify=()=>frame.current?.contentWindow?.postMessage({type:'northstar-business-refresh'},location.origin);
    const message=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow || event.origin!==location.origin || !event.data || typeof event.data!=='object')return;
      if(event.data.type==='northstar-business-overlay')setOverlay(!!event.data.open);
      if(event.data.type==='northstar-business-changed')window.dispatchEvent(new Event('northstar-business-changed'));
      if(event.data.type==='northstar-business-page' && isBusinessPage(event.data.page)){const old=current.current.tab;current.current.onChange({...old,page:event.data.page,title:businessComponents.find(item=>item.id===event.data.page)!.title});}
      if(event.data.type==='northstar-business-shortcut' && current.current.active){const key=event.data.key;if(typeof key==='string' && ((event.data.altKey && /^[1-9]$/.test(key)) || (event.data.ctrlKey && key==='Tab')))document.dispatchEvent(new KeyboardEvent('keydown',{key,altKey:!!event.data.altKey,ctrlKey:!!event.data.ctrlKey,shiftKey:!!event.data.shiftKey,bubbles:true,cancelable:true}));}
    };
    window.addEventListener('message',message);window.addEventListener('northstar-business-changed',notify);return()=>{window.removeEventListener('message',message);window.removeEventListener('northstar-business-changed',notify);};
  },[]);
  useEffect(()=>{frame.current?.contentWindow?.postMessage({type:'northstar-business-active',active},location.origin);},[active]);
  return <div className={`business-view ${overlay?'business-overlay-open':''}`}><iframe ref={frame} title={tab.title} src={`/?embed=${encodeURIComponent(entry)}&view=${encodeURIComponent(workspaceId+':'+tab.id)}`} onLoad={()=>frame.current?.contentWindow?.postMessage({type:'northstar-business-active',active:current.current.active},location.origin)}/></div>;
}
