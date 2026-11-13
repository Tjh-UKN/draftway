export const MAX_SCENE_BYTES = 20_000_000;
export function parseDrawingScene(value:string) {
  if(new TextEncoder().encode(value).length>MAX_SCENE_BYTES)throw new Error('画板超过 20 MB，请减少图片或拆成多个画板。');
  const scene=JSON.parse(value);
  if(!scene||scene.type!=='excalidraw'||scene.version!==2||!Array.isArray(scene.elements)||scene.elements.length>20000||!scene.appState||typeof scene.appState!=='object'||Array.isArray(scene.appState)||!scene.files||typeof scene.files!=='object'||Array.isArray(scene.files))throw new Error('请选择有效的 Excalidraw 画板文件（.excalidraw）。');
  if(scene.elements.some((e:unknown)=>!e||typeof e!=='object'||Array.isArray(e)||typeof (e as {id?:unknown}).id!=='string'||typeof (e as {type?:unknown}).type!=='string'))throw new Error('画板中的图形格式无效。');
  if(scene.libraryItems!==undefined&&!Array.isArray(scene.libraryItems))throw new Error('画板素材库格式无效。');
  for(const file of Object.values(scene.files)) {
    const item=file as {id?:unknown;dataURL?:unknown;mimeType?:unknown};
    if(!item||typeof item.id!=='string'||typeof item.dataURL!=='string'||!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(item.dataURL)||typeof item.mimeType!=='string')throw new Error('画板图片需要内嵌在文件中。');
  }
  return scene;
}
export function drawingFileName(title:string,extension:string){return (title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,80)||'画板')+'.'+extension;}
