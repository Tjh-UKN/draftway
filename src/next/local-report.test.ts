import {describe,it,expect} from 'vitest';
import {initialWorkbench,parseWorkbench} from './core';
import {focusedGroup,validateDock} from './docking';
import {browserTabs} from './native-browser';
import {isHtmlReport,openLocalReport} from './local-report';
const path=String.raw`C:\reports\PR 检视报告.html`;
describe('local report browser tabs',()=>{
  it('opens HTML in the owning workspace and reloads the same tab on a second click',()=>{
    const initial=initialWorkbench();const next=openLocalReport(initial,'design',path,'local-report');
    const tab=next.spaces[0].dock.tabs.find(tab=>tab.id==='local-report')!;
    expect(tab).toMatchObject({kind:'browser',title:'PR 检视报告.html',url:'',localFile:{workspaceId:'design',path}});
    expect(focusedGroup(next.spaces[0].dock).activeId).toBe(tab.id);
    const reopened=openLocalReport({...next,activeId:'review'},'design',path.toLowerCase(),'duplicate');
    expect(reopened.activeId).toBe('design');expect(reopened.spaces[0].dock.tabs).toHaveLength(next.spaces[0].dock.tabs.length);
    expect(focusedGroup(reopened.spaces[0].dock).activeId).toBe('local-report');
    expect(reopened.spaces[0].dock.tabs[1]).not.toBe(tab);
    expect(next.spaces[0].nodes).toBe(initial.spaces[0].nodes);
  });
  it('restores the file identity and keeps private local pages out of the HTTP webview host',()=>{
    const state=openLocalReport(initialWorkbench(),'design',path,'local-report');
    const restored=parseWorkbench(JSON.parse(JSON.stringify(state)));
    expect(restored.spaces[0].dock.tabs[1]).toMatchObject({localFile:{path}});
    expect(browserTabs(restored)).toEqual([]);
    const invalid=structuredClone(restored.spaces[0].dock);(invalid.tabs[1] as {url:string}).url='https://example.com';
    expect(()=>validateDock(invalid,[])).toThrow();
    expect(openLocalReport(state,'design','javascript:alert(1)')).toBe(state);
    expect(isHtmlReport('document.pdf')).toBe(false);
  });
});
