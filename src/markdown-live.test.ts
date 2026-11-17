import {EditorState} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {describe,it,expect} from 'vitest';
import {markdownDecorations} from './markdown-live';
describe('live Markdown formatting',()=>{
 const document='# 标题\n\n**加粗**和*斜体*\n\n`代码`\n\n```ts\nconst a=1\n```';
 const state=(anchor=0)=>EditorState.create({doc:document,selection:{anchor},extensions:[markdown({base:markdownLanguage})]});
 it('conceals formatting delimiters and keeps fenced code intact',()=>{
  const ranges=markdownDecorations(state(),false).filter(range=>!range.line);expect(ranges.map(r=>document.slice(r.from,r.to))).toEqual(['# ','**','**','*','*','`','`']);expect(markdownDecorations(state(),false).find(r=>r.line)?.className).toBe('note-heading-1');
 });
 it('reveals the active line and never changes stored Markdown',()=>{
  const source=state(8);const ranges=markdownDecorations(source,true).filter(range=>!range.line);expect(ranges.map(r=>document.slice(r.from,r.to))).toEqual(['# ','`','`']);expect(source.doc.toString()).toBe(document);
 });
});
