import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionComposer} from './SessionComposer';
import {AgentComposerOptions} from './AgentComposerOptions';
import {createSession,initialWorkbench} from './core';
import type {AgentModelOptions} from './NativeAgents';

it('stopping a turn cannot turn the clicked button into a native form submission',()=>{
  const state=createSession(initialWorkbench(),'design',null,'chat',1);
  for(const busy of [true,false]){
    const html=renderToStaticMarkup(<SessionComposer session={state.sessions[0]} change={()=>{}} active={false} busy={busy} stopping={false} disabled={false} canSend onSend={()=>{}} onStop={()=>{}}/>);
    const buttons=html.match(/<button\b[^>]*>/g)||[];
    expect(buttons.length).toBe(1);
    expect(buttons.every(button=>button.includes('type="button"'))).toBe(true);
  }
});

it('keeps Stop separate from queueing and allows a file-only draft',()=>{
  const state=createSession(initialWorkbench(),'design',null,'chat',1);
  const session={...state.sessions[0],draftFiles:[{kind:'attachment' as const,path:'C:/QA/photo.png',name:'photo.png'}]};
  const html=renderToStaticMarkup(<SessionComposer session={session} change={()=>{}} active={false} busy stopping={false}
    disabled={false} canSend queueEnabled onSend={()=>{}} onStop={()=>{}}/>);
  expect(html).toMatch(/<button type="button" class="outline-button chat-queue-add">加入队列<\/button>/);
  expect(html).toMatch(/<button type="button" class="icon-button stop-button" aria-label="停止生成"/);
});

it('displays the effective Codex settings and the efforts available for that model', () => {
  const options: AgentModelOptions = {
    model: 'model-a', effort: 'low',
    models: [
      {id:'model-a',model:'model-a',displayName:'Model A',isDefault:true,defaultReasoningEffort:'low',
        supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'}]},
      {id:'model-b',model:'model-b',displayName:'Model B',isDefault:false,defaultReasoningEffort:'high',
        supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Deep'}]},
      {id:'model-c',model:'model-c',displayName:'Model C',isDefault:false,defaultReasoningEffort:'none',supportedReasoningEfforts:[]},
    ],
  };
  const html = renderToStaticMarkup(<AgentComposerOptions provider="Codex" options={options} effectiveModel="model-b"
    effectiveEffort="high" disabled={false} onSelect={()=>{}} onRetry={()=>{}}/>);
  expect(html).toContain('value="model-b" selected="">Model B');
  expect(html).toMatch(/<option value="high"[^>]* selected="">高<\/option>/);
  expect(html).toMatch(/<option value="medium"[^>]*>中<\/option>/);
  expect(html).not.toContain('value="low"');
  const switched = renderToStaticMarkup(<AgentComposerOptions provider="Codex" options={options} model="model-c" effectiveModel="model-b"
    effectiveEffort="high" disabled={false} onSelect={()=>{}} onRetry={()=>{}}/>);
  expect(switched).toContain('value="model-c" selected="">Model C');
  expect(switched).toContain('使用 Codex 默认');
  expect(switched).not.toContain('value="high"');
});
