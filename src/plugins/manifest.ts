export type PluginCapability='note.read'|'note.edit'|'storage.own';
export interface PluginManifest {
  manifestVersion:1;execution:'sandboxed-ui';id:string;name:string;version:string;description?:string;
  capabilities:PluginCapability[];main?:string;
  contributes:{commands:{id:string;title:string}[];panels:{id:string;title:string;entry:string}[]};
}
export interface PluginPackage {manifest:PluginManifest;files:Record<string,string>;enabled:boolean}
export interface PluginRegistry {format:1;revision:number;plugins:PluginPackage[];data:Record<string,Record<string,unknown>>}
export type PluginOperation={kind:'install';plugin:PluginPackage}|{kind:'enable';id:string;enabled:boolean}|{kind:'uninstall';id:string}|{kind:'storage.set';id:string;key:string;value:unknown};
export const emptyPlugins=():PluginRegistry=>({format:1,revision:0,plugins:[],data:{}});
const token=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z\d.-]{0,79}$/.test(value)&&!['constructor','prototype'].includes(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const size=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
export function pluginPath(value:unknown):value is string {
  return typeof value==='string'&&value.length<=180&&value.split('/').every(part=>/^[a-z\d_.-]+$/i.test(part)&&!['.','..'].includes(part)&&!part.endsWith('.')&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function parsePlugin(value:unknown):PluginPackage {
  if(!object(value)||!object(value.manifest)||!object(value.files)||typeof value.enabled!=='boolean'||size(value)>800_000)throw Error('插件包格式无效或超过 800 KB');
  const manifest=value.manifest;
  if(manifest.manifestVersion!==1||manifest.execution!=='sandboxed-ui'||!token(manifest.id)||typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>80||typeof manifest.version!=='string'||manifest.version.length>80||!/^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i.test(manifest.version)||manifest.description!==undefined&&(typeof manifest.description!=='string'||manifest.description.length>500))throw Error('插件声明无效');
  const supported=['note.read','note.edit','storage.own'];
  if(!Array.isArray(manifest.capabilities)||manifest.capabilities.length>3||new Set(manifest.capabilities).size!==manifest.capabilities.length||manifest.capabilities.some(cap=>!supported.includes(String(cap))))throw Error('插件申请了当前版本不支持的能力');
  const contributes=manifest.contributes;
  if(!object(contributes)||Object.keys(contributes).some(key=>!['commands','panels'].includes(key)))throw Error('当前支持命令和面板扩展');
  const commands=contributes.commands??[],panels=contributes.panels??[];
  if(!Array.isArray(commands)||commands.length>32||!Array.isArray(panels)||panels.length>8||!commands.length&&!panels.length)throw Error('插件需要声明命令或面板');
  const ids=new Set<string>();
  for(const entry of [...commands,...panels]){if(!object(entry)||!token(entry.id)||ids.has(entry.id)||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>80)throw Error('插件贡献点无效或重名');ids.add(entry.id);}
  const files:Record<string,string>={};
  if(Object.keys(value.files).length>32)throw Error('插件文件超过 32 个');
  for(const [path,text] of Object.entries(value.files)){if(!pluginPath(path)||! /\.(js|html|css|json)$/i.test(path)||typeof text!=='string')throw Error('插件文件路径或类型无效');files[path]=text;}
  if(manifest.main!==undefined&&(!pluginPath(manifest.main)||!manifest.main.endsWith('.js')||!Object.hasOwn(files,manifest.main))||commands.length&&!manifest.main)throw Error('插件命令需要有效的 main.js 入口');
  for(const panel of panels)if(!pluginPath(panel.entry)||!panel.entry.endsWith('.html')||!Object.hasOwn(files,panel.entry))throw Error('插件面板需要有效的 HTML 入口');
  const parsed:PluginManifest={manifestVersion:1,execution:'sandboxed-ui',id:manifest.id,name:manifest.name.trim(),version:manifest.version,capabilities:manifest.capabilities as PluginCapability[],contributes:{commands:commands as PluginManifest['contributes']['commands'],panels:panels as PluginManifest['contributes']['panels']}};
  if(manifest.main)parsed.main=manifest.main as string;if(manifest.description)parsed.description=manifest.description as string;
  return {manifest:parsed,files,enabled:value.enabled};
}
export function parsePluginRegistry(value:unknown):PluginRegistry {
  if(!object(value)||value.format!==1||!Number.isSafeInteger(value.revision)||Number(value.revision)<0||!Array.isArray(value.plugins)||value.plugins.length>12||!object(value.data)||size(value)>12_000_000)throw Error('插件存储无效，已停止加载');
  const plugins=value.plugins.map(parsePlugin);
  if(new Set(plugins.map(plugin=>plugin.manifest.id)).size!==plugins.length)throw Error('插件标识重复');
  for(const [id,data] of Object.entries(value.data))if(!token(id)||!object(data)||size(data)>64_000)throw Error('插件私有数据无效或超过 64 KB');
  return {format:1,revision:value.revision as number,plugins,data:value.data as PluginRegistry['data']};
}
export function applyPluginOperation(current:PluginRegistry,operation:PluginOperation):PluginRegistry {
  const next=structuredClone(current);
  if(operation.kind==='install'){
    const plugin=parsePlugin(operation.plugin);plugin.enabled=false;
    next.plugins=next.plugins.filter(old=>old.manifest.id!==plugin.manifest.id).concat(plugin);
  }else if(operation.kind==='storage.set'){
    if(!next.plugins.some(plugin=>plugin.manifest.id===operation.id&&plugin.enabled&&plugin.manifest.capabilities.includes('storage.own')))throw Error('插件未启用或没有存储权限');
    if(!token(operation.key))throw Error('存储键无效');
    const encoded=JSON.stringify(operation.value);if(encoded===undefined)throw Error('插件数据需要 JSON 值');
    next.data[operation.id]={...next.data[operation.id],[operation.key]:JSON.parse(encoded)};
  }else if(operation.kind==='uninstall')next.plugins=next.plugins.filter(plugin=>plugin.manifest.id!==operation.id);
  else if(operation.kind==='enable'){
    const plugin=next.plugins.find(plugin=>plugin.manifest.id===operation.id);if(!plugin)throw Error('插件不存在');plugin.enabled=operation.enabled;
  }else throw Error('插件操作无效');
  next.revision++;return parsePluginRegistry(next);
}
export async function readPluginFolder(files:FileList|File[]):Promise<PluginPackage>{
  const list=Array.from(files);const manifests=list.filter(file=>file.name==='northstar-plugin.json');
  if(manifests.length!==1)throw Error('请选择含一个 northstar-plugin.json 的插件文件夹');
  const manifestFile=manifests[0];const path=manifestFile.webkitRelativePath||manifestFile.name;const prefix=path.slice(0,-manifestFile.name.length);
  if(manifestFile.size>32_000)throw Error('插件声明超过 32 KB');
  const contents:Record<string,string>={};let bytes=0;
  for(const file of list){const relative=(file.webkitRelativePath||file.name).slice(prefix.length);if(!(file.webkitRelativePath||file.name).startsWith(prefix)||relative==='northstar-plugin.json'||! /\.(js|html|css|json)$/i.test(relative))continue;bytes+=file.size;if(bytes>800_000)throw Error('插件文件超过 800 KB');contents[relative]=await file.text();}
  return parsePlugin({manifest:JSON.parse(await manifestFile.text()),files:contents,enabled:false});
}
