import {describe,it,expect} from 'vitest';
import {makeRecord,type Note} from './domain';
import {NoteDraft} from './note-draft';

const initial=()=>({...makeRecord('note'),title:'笔记',version:1,body:'原文',tags:['原标签'],projectId:'project',taskId:'task'} as Note);
describe('note autosave',()=>{
  it('serializes edits during an in-flight save and retains relationships',async()=>{
    const calls:Note[]=[];let release!:()=>void;
    const draft=new NoteDraft(initial(),async note=>{calls.push(note);if(calls.length===1)await new Promise<void>(resolve=>release=resolve);return {...note,version:note.version+1};});
    draft.patch({body:'第一段'});const saving=draft.flush();draft.patch({body:'最新内容'});expect(draft.flush()).toBe(saving);release();await saving;
    expect(calls.map(note=>[note.body,note.version])).toEqual([['第一段',1],['最新内容',2]]);
    expect(draft.dirty).toBe(false);expect(draft.note).toMatchObject({body:'最新内容',version:3,tags:['原标签'],projectId:'project',taskId:'task'});
  });
  it('keeps the draft after failure and retries with the same version',async()=>{
    let fail=true;const draft=new NoteDraft(initial(),async note=>{if(fail)throw Error('保存失败');return {...note,version:2};});
    draft.patch({body:'不能丢'});await expect(draft.flush()).rejects.toThrow('保存失败');expect(draft.dirty).toBe(true);expect(draft.note.version).toBe(1);
    fail=false;await draft.flush();expect(draft.note.body).toBe('不能丢');expect(draft.error).toBe('');expect(draft.dirty).toBe(false);
  });
  it('creates untitled notes without requiring a title form and skips archived writes',async()=>{
    const calls:Note[]=[];const save=async(note:Note)=>{calls.push(note);return {...note,version:1};};
    const draft=new NoteDraft({...initial(),version:0,title:''},save);await draft.flush();draft.patch({title:''});await draft.flush();
    expect(calls.every(note=>note.title==='未命名笔记')).toBe(true);
    const archived=new NoteDraft({...initial(),archived:true},save);archived.patch({body:'修改'});await archived.flush();expect(calls).toHaveLength(2);
  });
  it('recovers a matching draft and rejects drafts based on an older revision',()=>{
    const note=initial();const save=async(note:Note)=>note;
    expect(new NoteDraft(note,save,{...note,body:'恢复的草稿'}).note.body).toBe('恢复的草稿');
    expect(new NoteDraft(note,save,{...note,version:0,body:'旧草稿'}).note.body).toBe('原文');
  });
});
