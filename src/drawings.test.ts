import {describe,it,expect} from 'vitest';
import {makeRecord,recordText,archiveClosure,type Drawing} from './domain';
import {parseDrawingScene,drawingFileName} from './drawings';
describe('persistent Excalidraw scenes',()=>{
 it('round-trips diagrams, handwriting, embedded images and canvas preferences',()=>{
  const drawing=makeRecord('drawing') as Drawing;const scene=parseDrawingScene(drawing.scene);
  scene.elements=[{id:'text1',type:'text',text:'问题排查 → 解决方案',x:10,y:20},{id:'old',type:'text',text:'已删除的内容',isDeleted:true}];
  scene.files={image1:{id:'image1',mimeType:'image/png',dataURL:'data:image/png;base64,aGVsbG8='}};scene.appState={viewBackgroundColor:'#ffffff'};
  drawing.scene=JSON.stringify(scene);drawing.title='设计稿';
  expect(parseDrawingScene(drawing.scene)).toEqual(scene);
  expect(recordText(drawing)).toContain('问题排查');expect(recordText(drawing)).not.toContain('已删除的内容');expect(recordText(drawing)).not.toContain('base64');
 });
 it('rejects non-scenes, malformed elements and external image files',()=>{
  for(const data of ['null','{}','not json',JSON.stringify({type:'excalidraw',version:2,elements:[null],appState:{},files:{}})])expect(()=>parseDrawingScene(data)).toThrow();
  const d=makeRecord('drawing') as Drawing;const scene=parseDrawingScene(d.scene);scene.files={external:{id:'external',mimeType:'image/png',dataURL:'https://example.com/private.png'}};expect(()=>parseDrawingScene(JSON.stringify(scene))).toThrow('内嵌');
 });
 it('keeps project archive relationships and usable Windows export names',()=>{
  const d=makeRecord('drawing') as Drawing;d.projectId='project';expect(archiveClosure([d],'project')).toContain(d.id);expect(drawingFileName('结构图/第一版:草稿','excalidraw')).toBe('结构图_第一版_草稿.excalidraw');
 });
});
