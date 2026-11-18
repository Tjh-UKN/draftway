import {describe,expect,it} from 'vitest';
import manifest from '../../examples/plugins/note-tools/northstar-plugin.json';
import {applyPluginOperation,emptyPlugins,parsePlugin,pluginPath,readPluginFolder} from './manifest';
import {notePluginCall,pluginPeer,type PluginNote,type NotePluginHost} from './runtime';
import {pluginAsset} from './frame-document';
import {noteToolsPlugin} from './starter';

const sample=()=>({...noteToolsPlugin(),enabled:true});
describe('plugin installation and lifetime',()=>{
  it('validates capabilities, contribution points and package paths',()=>{
    const plugin=sample();expect(plugin.manifest.contributes.panels).toHaveLength(1);
    for(const path of ['../entry.js','C:/entry.js','folder/../entry.js','CON.js','https://example.com/main.js'])expect(pluginPath(path)).toBe(false);
    expect(()=>parsePlugin({...plugin,manifest:{...manifest,execution:'trusted-worker'}})).toThrow();
    expect(()=>parsePlugin({...plugin,manifest:{...manifest,capabilities:['filesystem.read']}})).toThrow();
    expect(()=>parsePlugin({...plugin,files:{}})).toThrow();
    expect(()=>parsePlugin({...plugin,manifest:{...manifest,contributes:{...manifest.contributes,hooks:[]}}})).toThrow();
    expect(()=>pluginAsset('panel.html','https://example.com/main.js')).toThrow();expect(pluginAsset('view/panel.html','./main.js')).toBe('view/main.js');
  });
  it('requires enable after installation/update and preserves private data on uninstall',()=>{
    let registry=applyPluginOperation(emptyPlugins(),{kind:'install',plugin:sample()});expect(registry.plugins[0].enabled).toBe(false);
    registry=applyPluginOperation(registry,{kind:'enable',id:manifest.id,enabled:true});registry=applyPluginOperation(registry,{kind:'storage.set',id:manifest.id,key:'choice',value:'keep'});
    expect(()=>applyPluginOperation(registry,{kind:'storage.set',id:manifest.id,key:'bad',value:undefined})).toThrow('JSON');
    registry=applyPluginOperation(registry,{kind:'install',plugin:sample()});expect(registry.plugins[0].enabled).toBe(false);expect(()=>applyPluginOperation(registry,{kind:'storage.set',id:manifest.id,key:'choice',value:'overwrite'})).toThrow();
    registry=applyPluginOperation(registry,{kind:'uninstall',id:manifest.id});expect(registry.plugins).toHaveLength(0);expect(registry.data[manifest.id].choice).toBe('keep');
  });
  it('keeps both installations and does not mutate the previous snapshot',()=>{
    const first=applyPluginOperation(emptyPlugins(),{kind:'install',plugin:sample()});const second=sample();second.manifest.id='local.second';const next=applyPluginOperation(first,{kind:'install',plugin:second});expect(next.plugins).toHaveLength(2);expect(first.plugins).toHaveLength(1);
  });
  it('imports a folder package using paths relative to its manifest',async()=>{
    const plugin=sample();const files=[new File([JSON.stringify(manifest)],'northstar-plugin.json'),...Object.entries(plugin.files).map(([path,body])=>new File([body],path))];
    for(const file of files)Object.defineProperty(file,'webkitRelativePath',{value:'note-tools/'+file.name});
    const imported=await readPluginFolder(files);expect(imported.files).toEqual(plugin.files);expect(imported.enabled).toBe(false);await expect(readPluginFolder(files.slice(1))).rejects.toThrow('northstar-plugin.json');
  });
});
describe('scoped editor API',()=>{
  function fixture(){let note:PluginNote={id:'note-one',title:'Title',text:'abc',revision:1,selection:{from:0,to:0,text:''}};let readonly=false;const host:NotePluginHost={read:()=>note,edit:(from,to,text)=>{note={...note,text:note.text.slice(0,from)+text+note.text.slice(to),revision:note.revision+1};},select:(from,to)=>{note={...note,selection:{from,to,text:note.text.slice(from,to)}};},readOnly:()=>readonly};return {host,read:()=>note,lock:()=>readonly=true};}
  it('applies a revision-checked edit only to the bound note',()=>{
    const {host,read}=fixture();const plugin=sample();notePluginCall(plugin,host,'note.edit',{from:1,to:2,text:'B',revision:1});expect(read()).toMatchObject({id:'note-one',text:'aBc',revision:2});
    expect(()=>notePluginCall(plugin,host,'note.edit',{from:0,to:1,text:'X',revision:1})).toThrow('笔记已更新');expect(read().text).toBe('aBc');
    expect(()=>notePluginCall(plugin,host,'note.edit',{from:0,to:1,text:'X',revision:2,noteId:'other-note'})).toThrow();
  });
  it('rejects missing permissions, invalid ranges, read-only and disabled plugins',()=>{
    const {host,lock}=fixture();const plugin=sample();const edit={from:0,to:3,text:'new',revision:1};
    expect(()=>notePluginCall(plugin,host,'note.edit',{...edit,to:9})).toThrow();expect(()=>notePluginCall(plugin,host,'filesystem.read',{})).toThrow();
    const limited=sample();limited.manifest.capabilities=['note.read'];expect(()=>notePluginCall(limited,host,'note.edit',edit)).toThrow('权限');lock();expect(()=>notePluginCall(plugin,host,'note.edit',edit)).toThrow('只读');plugin.enabled=false;expect(()=>notePluginCall(plugin,host,'note.read',{})).toThrow('停用');
  });
  it('runs the external example through its public API and preserves fenced code',async()=>{
    const {host,read}=fixture();host.edit(0,3,'# Heading\n\n\n\ntext\n\n```js\na\n\n\nb\n```');const plugin=sample();let command:(()=>Promise<void>)|undefined;
    new Function('northstar',plugin.files['main.js'])({commands:{register:(_id:string,run:()=>Promise<void>)=>command=run},note:{read:async()=>read(),edit:async(params:unknown)=>notePluginCall(plugin,host,'note.edit',params)}});await command!();expect(read().text).toBe('# Heading\n\ntext\n\n```js\na\n\n\nb\n```');
  });
  it('uses separate message ports and cancels a pending command on disposal',async()=>{
    const channel=new MessageChannel();const calls:string[]=[];const peer=pluginPeer(channel.port1,method=>{calls.push(method);return 'ok';});
    channel.port2.postMessage({type:'ready'});await peer.ready;
    const response=new Promise<unknown>(resolve=>{channel.port2.onmessage=event=>{if(event.data.type==='response')resolve(event.data.value);};});channel.port2.postMessage({type:'call',id:1,method:'note.read',params:{}});expect(await response).toBe('ok');expect(calls).toEqual(['note.read']);
    const command=peer.command('wait');await Promise.resolve();peer.dispose();await expect(command).rejects.toThrow('停止');channel.port2.close();
  });
});
