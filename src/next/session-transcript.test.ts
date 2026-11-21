import {describe,it,expect} from 'vitest';
import {activityByMessage,reuseMessages,SessionTranscripts} from './session-transcript';
import type {Message, Run, RunActivity} from './core';
const message=(id:string,text=id):Message=>({id,role:'assistant',text,at:1});
describe('per-session transcript frames',()=>{
  it('retains settled row identity and isolates subscriptions from other sessions',()=>{
    const store=new SessionTranscripts(),history=[message('a'),message('b')];let calls=0,other=0;
    store.replace('chat',1,history);store.replace('other',1,[]);
    store.subscribe('chat',()=>calls++);store.subscribe('other',()=>other++);
    expect(store.apply({id:'chat',baseRevision:1,revision:3,messages:[message('b','stream'),message('c')]})).toBe(true);
    expect(store.get('chat')!.messages[0]).toBe(history[0]);expect(calls).toBe(1);expect(other).toBe(0);
    expect(store.get('chat')!.messages.map(m=>m.text)).toEqual(['a','stream','c']);
  });
  it('recovers a missed structural snapshot, rejects late frames and does not duplicate replies',()=>{
    const store=new SessionTranscripts();store.replace('chat',2,[message('a')]);
    expect(store.apply({id:'chat',baseRevision:4,revision:5,messages:[message('b')]})).toBe(false);
    store.replace('chat',4,[message('a'),message('b')]);
    store.apply({id:'chat',baseRevision:4,revision:8,messages:[message('b','final words')]});
    store.apply({id:'chat',baseRevision:4,revision:7,messages:[message('b','late')]});
    const before=store.get('chat')!.messages;
    store.replace('chat',9,[message('a'),message('b','final words')]);
    expect(store.get('chat')!.messages).toBe(before);
    store.apply({id:'chat',baseRevision:4,revision:8,messages:[message('b','late')]});
    expect(store.get('chat')!.messages[1].text).toBe('final words');
    expect(reuseMessages(before,before.map(m=>({...m})))).toBe(before);
  });
  it('clears stream revisions when restoring workspace state',()=>{
    const store=new SessionTranscripts();store.replace('chat',50,[message('old')]);store.clear();
    store.replace('chat',2,[message('restored')]);expect(store.get('chat')!.messages[0].text).toBe('restored');
    expect(store.apply({id:'chat',baseRevision:2,revision:3,messages:[message('next')]})).toBe(true);
  });
  it('overlays output for the running step and lets the settled snapshot win',()=>{
    const store = new SessionTranscripts();
    const step: RunActivity = {id:'command', kind:'command', title:'执行命令', status:'running', afterMessageId:'intro'};
    const run: Run = {id:'run', sessionId:'chat', state:'running', startedAt:0, dueAt:0, activity:[step]};
    store.replace('chat', 1, [message('intro')]);
    store.apply({id:'chat', baseRevision:1, revision:2, messages:[], activity:{runId:run.id, items:[{...step,output:'partial'}]}});
    const progress = store.get('chat')?.activity;
    expect(activityByMessage([run], progress).get('intro')?.[0].item.output).toBe('partial');
    expect(activityByMessage([{...run, id:'other'}], progress).get('intro')?.[0].item.output).toBeUndefined();
    const final = {...step, status:'completed' as const, output:'final'};
    expect(activityByMessage([{...run, state:'succeeded', activity:[final]}], progress).get('intro')?.[0].item).toBe(final);
    store.replace('chat', 3, [message('intro')]);
    expect(store.get('chat')?.activity).toBeUndefined();
  });
});
