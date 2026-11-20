import type {Message, Run, RunActivity} from './core';

export interface TranscriptFrame {id:string;baseRevision:number;revision:number;messages:Message[]}
export interface TranscriptSnapshot {revision:number;messages:Message[]}

export interface TranscriptActivity {
  item: RunActivity;
  runId: string;
  live: boolean;
  waiting: boolean;
}

export function activityByMessage(runs?: readonly Run[]): Map<string, TranscriptActivity[]> {
  const groups = new Map<string, TranscriptActivity[]>();
  for (const run of runs ?? []) {
    const waiting = run.state === 'needs_input';
    const live = run.state === 'running' || waiting;
    for (const item of run.activity ?? []) {
      const anchor = item.afterMessageId ?? `${run.id}-user`;
      const entry = {item, runId: run.id, live, waiting};
      const group = groups.get(anchor);
      if (group) group.push(entry);
      else groups.set(anchor, [entry]);
    }
  }
  return groups;
}

export function reuseMessages(previous:Message[],next:Message[]):Message[] {
  const byId=new Map(previous.map(message=>[message.id,message]));
  const reused=next.map(message=>{
    const old=byId.get(message.id);
    return old&&old.role===message.role&&old.text===message.text&&old.at===message.at?old:message;
  });
  return reused.length===previous.length&&reused.every((message,i)=>message===previous[i])?previous:reused;
}

// Stream frames belong to one session; typing and other workspaces never subscribe to them.
export class SessionTranscripts {
  private values=new Map<string,TranscriptSnapshot>();
  private bases=new Map<string,number>();
  private listeners=new Map<string,Set<()=>void>>();
  get(id:string){return this.values.get(id);}
  clear(){this.values.clear();this.bases.clear();this.listeners.forEach(listeners=>listeners.forEach(listener=>listener()));}
  subscribe(id:string,listener:()=>void){
    let listeners=this.listeners.get(id);
    if(!listeners)this.listeners.set(id,listeners=new Set());
    listeners.add(listener);
    return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(id);};
  }
  private publish(id:string,value:TranscriptSnapshot){this.values.set(id,value);this.listeners.get(id)?.forEach(listener=>listener());}
  replace(id:string,revision:number,messages:Message[]){
    this.bases.set(id,Math.max(this.bases.get(id)||0,revision));
    const old=this.values.get(id);
    if(old&&old.revision>revision)return messages;
    const reused=reuseMessages(old?.messages||[],messages);
    if(!old||revision!==old.revision)this.publish(id,{revision,messages:reused});
    return reused;
  }
  apply(frame:TranscriptFrame):boolean {
    const old=this.values.get(frame.id);
    if(!old||(this.bases.get(frame.id)||0)<frame.baseRevision)return false;
    if(old.revision>=frame.revision)return true;
    const updates=new Map(frame.messages.map(message=>[message.id,message]));
    const combined=old.messages.map(message=>{const update=updates.get(message.id);updates.delete(message.id);return update||message;});
    combined.push(...updates.values());
    this.publish(frame.id,{revision:frame.revision,messages:reuseMessages(old.messages,combined)});
    return true;
  }
}
