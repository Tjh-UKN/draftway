import {useEffect,useMemo,useRef,useState} from 'react';
import {collectKnowledge} from '../api';
import {knowledgeCandidates} from '../knowledge';
import type {WorkbenchState} from './core';

export function useKnowledgeCollection(state:WorkbenchState,enabled:boolean) {
  const signature=useMemo(()=>JSON.stringify(knowledgeCandidates(state)),[state.spaces]);const completed=useRef('');
  const [attempt,setAttempt]=useState(0);const [error,setError]=useState('');
  useEffect(()=>{
    if(!enabled||completed.current===signature)return;
    let alive=true;
    void collectKnowledge(JSON.parse(signature)).then(count=>{if(count)window.dispatchEvent(new Event('northstar-business-changed'));if(!alive)return;completed.current=signature;setError('');}).catch(error=>{if(alive)setError('知识库入库失败：'+String(error));});
    return()=>{alive=false;};
  },[signature,enabled,attempt]);
  return {error,retry:()=>{completed.current='';setAttempt(value=>value+1);}};
}
