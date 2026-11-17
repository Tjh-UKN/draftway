import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionComposer} from './SessionComposer';
import {createSession,initialWorkbench} from './core';

it('stopping a turn cannot turn the clicked button into a native form submission',()=>{
  const state=createSession(initialWorkbench(),'design',null,'chat',1);
  for(const busy of [true,false]){
    const html=renderToStaticMarkup(<SessionComposer session={state.sessions[0]} change={()=>{}} active={false} busy={busy} stopping={false} disabled={false} canSend onSend={()=>{}} onStop={()=>{}}/>);
    const buttons=html.match(/<button\b[^>]*>/g)||[];
    expect(buttons.length).toBe(1);
    expect(buttons.every(button=>button.includes('type="button"'))).toBe(true);
  }
});
