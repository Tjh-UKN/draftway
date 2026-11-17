import {describe,expect,it} from 'vitest';
import {initialWorkbench,placeArtifact,createSession,startDemoRun,advanceDemoRuns} from './next/core';
import {knowledgeCandidates,knowledgeNote,knowledgeSourceKey,refreshKnowledgeNote} from './knowledge';

describe('personal knowledge collection',()=>{
  it('collects retained artifacts and documents but never ordinary nodes or unretained chat replies',()=>{
    let state=createSession(initialWorkbench(),'design','think','s',1);
    state=advanceDemoRuns(startDemoRun(state,'s','ordinary conversation','succeeded','r',1),10000);
    const before=knowledgeCandidates(state);
    expect(before.some(item=>item.source.category==='artifact')).toBe(false);
    state=placeArtifact(state,'r-artifact',10001);
    state.spaces[0].nodes.push({id:'doc',parentId:'think',side:1,kind:'document',title:'Design',body:'Original document',progress:0,due:''});
    const candidates=knowledgeCandidates(state);
    expect(candidates.filter(item=>item.source.category==='artifact')).toHaveLength(1);
    expect(candidates.find(item=>item.source.id==='doc')).toMatchObject({title:'Design',body:'Original document',source:{workspaceId:'design',category:'document'}});
    expect(candidates.some(item=>item.source.id==='think')).toBe(false);
  });
  it('does not collect the same legacy workspace note twice and keeps distinct note views',()=>{
    const state=initialWorkbench();const space=state.spaces[0];
    space.surfaces=[{id:'first',integrationId:'note',title:'First',text:space.notes},{id:'second',integrationId:'note',title:'Second',text:'A distinct note'}];
    const notes=knowledgeCandidates(state).filter(item=>item.source.workspaceId===space.id&&item.source.kind==='note');
    expect(notes).toHaveLength(2);expect(notes.map(item=>item.source.id)).toEqual(['first','second']);
    expect(knowledgeSourceKey(notes[0].source)).not.toBe(knowledgeSourceKey({...notes[0].source,workspaceId:'other'}));
    expect(knowledgeSourceKey(notes[0].source)).toBe(knowledgeSourceKey({...notes[0].source,workspaceName:'renamed'}));
  });
  it('creates an independent normal note with unchanged content and preserved provenance',()=>{
    const candidate=knowledgeCandidates(initialWorkbench())[0];const note=knowledgeNote(candidate);
    expect(note).toMatchObject({kind:'note',projectId:null,taskId:null,body:candidate.body,knowledgeSource:candidate.source,tags:[],version:0});
    note.body='Edited in the library';expect(candidate.body).not.toBe(note.body);
    expect(()=>knowledgeNote({...candidate,body:'中'.repeat(400000)})).toThrow('1 MB');
  });
  it('refreshes automatic entries until a person edits or archives the knowledge note',()=>{
    const candidate=knowledgeCandidates(initialWorkbench())[0];const note={...knowledgeNote(candidate),version:1};
    const changed={...candidate,body:'The finished document'};const next=refreshKnowledgeNote(note,changed);
    expect(next).toMatchObject({id:note.id,body:changed.body,version:2,knowledgeSource:{autoUpdate:true}});
    expect(refreshKnowledgeNote(next,changed)).toBe(next);
    const edited={...next,body:'My own curation',knowledgeSource:{...next.knowledgeSource!,autoUpdate:false}};
    expect(refreshKnowledgeNote(edited,candidate)).toBe(edited);
    const archived={...next,archived:true};expect(refreshKnowledgeNote(archived,candidate)).toBe(archived);
  });
});
