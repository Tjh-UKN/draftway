import {useEffect, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import type {WorkbenchState} from './core';
import type {MindNode} from './model';
import type {ChangeState} from './Sessions';
export interface MapOperation {seq: number; id: string; workspaceId: string; nodeId: string; sessionId: string; runId: string; kind: 'progress' | 'update' | 'artifact'; payload: {text?: string; title?: string; body?: string; expectedBody?: string}; at: number}
export function applyMapOperations(state: WorkbenchState, operations: MapOperation[]): WorkbenchState {
  let next=state;
  for(const op of operations) {
    if(op.seq<=(next.graphCursor||0))continue;
    next={...next,graphCursor:op.seq,spaces:next.spaces.map(space=>{
      const node=space.nodes.find(n=>n.id===op.nodeId);if(space.id!==op.workspaceId || !node || space.nodes.some(n=>n.updates?.some(u=>u.id===op.id)))return space;
      let text=op.payload.text||'';let body=node.body;const nodes=[...space.nodes];
      if(op.kind==='update'){if(body===op.payload.expectedBody)body=op.payload.body||'';else text=`AI 内容建议（原内容已变化，未覆盖）：\n${op.payload.body||''}`;}
      if(op.kind==='artifact'){
        const id=`artifact-${op.seq}`;
        if(nodes.length>=250)text='AI 产物未放入地图：节点数量已达上限。';
        else {const artifact:MindNode={id,parentId:node.id,side:node.side,kind:'artifact',title:op.payload.title||'AI 产物',body:op.payload.body||'',progress:0,due:'',steps:[],updates:[{id:op.id,text:'从 AI 执行保留产物',at:op.at,sessionId:op.sessionId}]};if(!nodes.some(n=>n.id===id))nodes.push(artifact);text=`保留产物：${artifact.title}`;}
      }
      return {...space,nodes:nodes.map(n=>n.id===node.id?{...n,body,updates:[...(n.updates||[]),{id:op.id,text,at:op.at,sessionId:op.sessionId}]}:n)};
    })};
  }return next;
}
export function useMapOperations(state: WorkbenchState, change: ChangeState, enabled: boolean) {
  const cursor=useRef(state.graphCursor||0);cursor.current=state.graphCursor||0;const [error,setError]=useState('');
  useEffect(()=>{if(!enabled || !isTauri())return;let alive=true;let polling=false;
    const poll=async()=>{if(polling)return;polling=true;try {const ops=await invoke<MapOperation[]>('graph_changes',{after:cursor.current});if(alive){if(ops.length)change(old=>applyMapOperations(old,ops));setError('');}}catch(e){if(alive)setError(`地图同步失败：${String(e)}`);}finally{polling=false;}};
    void poll();const timer=setInterval(()=>{void poll();},1000);window.addEventListener('focus',poll);return()=>{alive=false;clearInterval(timer);window.removeEventListener('focus',poll);};
  },[enabled,change]);return error;
}
