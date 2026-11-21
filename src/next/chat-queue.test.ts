import {expect,it} from 'vitest';
import {beginNativeSend,mergeNativeSession,rejectNativeSend,type NativeSession} from './agent-state';
import {canStartQueuedMessage,changeQueuedMessage,enqueueChatMessage,isChatQueue,pauseChatQueue,resumeChatQueue} from './chat-queue';
import {createSession,initialWorkbench,parseWorkbench,type Run} from './core';
import {durableWorkbench} from './persistence';

const file = {kind:'attachment' as const, path:'C:/project/screenshot.png', name:'screenshot.png'};
const first = {id:'queued-first', text:'Check this image', files:[file], model:'chosen-model', effort:'high'};
const second = {id:'queued-second', text:'Continue with this'};

function setup() {
  let state = createSession(initialWorkbench(),'design',null,'a',1);
  state = createSession(state,'design',null,'b',2);
  state.sessions[0] = {...state.sessions[0], integrationId:'codex', nativeRevision:1, draft:first.text, draftFiles:[file]};
  state.sessions[1].draft = 'other conversation';
  const current: Run = {id:'current', sessionId:'a', state:'running', startedAt:3, dueAt:3};
  state.runs.push(current);
  return state;
}

it('captures queue entries in order and waits for the current turn and its permission requests',()=>{
  let state = enqueueChatMessage(setup(),'a',first);
  state = enqueueChatMessage(state,'a',second);
  expect(state.sessions[0]).toMatchObject({draft:'',draftFiles:[],queuedMessages:[first,second]});
  expect(state.sessions[1].draft).toBe('other conversation');
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(false);
  state.runs[0].state = 'needs_input';
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(false);
  state.runs[0].state = 'succeeded';
  state.sessions[0].requests = [{id:'request',kind:'approval',title:'Approval',payload:{},sourceId:null}];
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(false);
  state.sessions[0].requests = [];
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(true);
  expect(canStartQueuedMessage(state,'a',second.id)).toBe(false);
  expect(canStartQueuedMessage(state,'b',first.id)).toBe(false);
});

it('keeps order and attachment settings during edits without changing the independent composer draft',()=>{
  let state = enqueueChatMessage(enqueueChatMessage(setup(),'a',first),'a',second);
  state.sessions[0].draft = 'separate unsent draft';
  state = changeQueuedMessage(state,'a',first.id,'Edited message');
  expect(state.sessions[0]).toMatchObject({draft:'separate unsent draft',queuedMessages:[{...first,text:'Edited message'},second]});
  state = changeQueuedMessage(state,'a',first.id);
  expect(state.sessions[0].queuedMessages).toEqual([second]);
});

it('restores pending queue entries paused and resumes only in the original native chat',()=>{
  let state = enqueueChatMessage(setup(),'a',first);
  state.runs[0].state = 'cancelled';
  state = pauseChatQueue(state,'a');
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(false);
  state = resumeChatQueue(state,'a');
  expect(canStartQueuedMessage(state,'a',first.id)).toBe(true);
  const restored = parseWorkbench(JSON.parse(JSON.stringify(durableWorkbench(state))));
  expect(restored.sessions[0]).toMatchObject({queuedMessages:[first],queuePaused:true});
  restored.sessions[0].nativeRevision = 1;
  expect(canStartQueuedMessage(restored,'a',first.id)).toBe(false);
  expect(canStartQueuedMessage(resumeChatQueue(restored,'a'),'a',first.id)).toBe(true);
});

it('pauses an enqueue that reached state after a failure and validates optional file-only queue entries',()=>{
  const state = setup();
  state.runs[0].state = 'failed';
  const added = enqueueChatMessage(state,'a',{...first,text:''});
  expect(added.sessions[0].queuePaused).toBe(true);
  expect(isChatQueue(added.sessions[0].queuedMessages)).toBe(true);
  expect(isChatQueue([{...first,text:'',files:[]}])).toBe(false);
  expect(isChatQueue([first,first])).toBe(false);
});

it('dequeues only the head when the send begins and retains both drafts on rejection',()=>{
  let state = enqueueChatMessage(enqueueChatMessage(setup(),'a',first),'a',second);
  state.runs[0].state = 'succeeded';
  state.sessions[0].draft = 'currently composing';
  expect(beginNativeSend(state,'a',second.id,second.text,4,false,[],true)).toBe(state);
  state = beginNativeSend(state,'a',first.id,first.text,4,false,first.files,true);
  expect(state.sessions[0]).toMatchObject({draft:'currently composing',queuedMessages:[second]});
  expect(canStartQueuedMessage(state,'a',second.id)).toBe(false);
  state = rejectNativeSend(state,'a',first.id,'not received');
  expect(state.runs.at(-1)).toMatchObject({id:first.id,state:'failed',pendingText:first.text,pendingFiles:[file]});
  expect(state.sessions[0]).toMatchObject({draft:'currently composing',queuedMessages:[second],queuePaused:true});
});

it('reconciles a pre-dispatch snapshot without sending a native run that already exists',()=>{
  const state = enqueueChatMessage(enqueueChatMessage(setup(),'a',first),'a',second);
  state.runs[0].state = 'succeeded';
  const restored = parseWorkbench(JSON.parse(JSON.stringify(durableWorkbench(state))));
  const native: NativeSession = {id:'a',workspaceId:'design',nodeId:null,backend:'codex',title:'Chat',cwd:'C:/project',sourceId:null,
    createdAt:1,revision:2,messages:[{id:`${first.id}-user`,role:'user',text:first.text,files:[file],at:4}],
    runs:[{id:first.id,state:'succeeded',startedAt:4,finishedAt:5,error:null}],requests:[],error:null};
  const hydrated = mergeNativeSession(restored,native);
  expect(hydrated.sessions[0]).toMatchObject({queuedMessages:[second],queuePaused:true});
  expect(hydrated.sessions[0].messages).toEqual(native.messages);
});
