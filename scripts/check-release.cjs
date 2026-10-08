const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');const crypto=require('node:crypto');
let playwright;try{playwright=require('playwright');}catch{playwright=require(require.resolve('playwright',{paths:[path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node')]}));}
(async()=>{
 const exe=path.resolve('artifacts/北极星.exe');let startupLog='';let startupExit=null;const app=spawn(exe,[],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9240'},stdio:['ignore','pipe','pipe']});app.stdout.on('data',value=>startupLog+=value);app.stderr.on('data',value=>startupLog+=value);app.on('exit',code=>startupExit=code);app.on('error',error=>startupLog+=error.message);
 try{
  let browser,page;
  for(let i=0;i<40;i++){try{browser=await playwright.chromium.connectOverCDP('http://127.0.0.1:9240');page=browser.contexts()[0].pages()[0];await page.locator('.dashboard-intro h1').waitFor({timeout:1000});break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!page)throw new Error(`Release app did not start (exit=${startupExit}): ${startupLog}`);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const work=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('load_workspace',{}));
  assert.ok(work.dataPath.endsWith('com.northstar.workbench'));assert.ok(work.records.every(r=>r.version>=1));
  const canonical=value=>JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])));
  const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
  const beforePath='artifacts/pre-upgrade-metadata.json';
  if(fs.existsSync(beforePath)){
   const before=JSON.parse(fs.readFileSync(beforePath,'utf8'));
   for(const old of before.records){const current=work.records.find(r=>r.id===old.id);assert.ok(current,`Missing record ${old.id}`);assert.equal(digest(Object.fromEntries(old.keys.map(k=>[k,current[k]]))),old.digest,`Changed legacy content ${old.id}`);}
   for(const old of before.attachments){const current=work.attachments.find(r=>r.id===old.id);assert.ok(current,`Missing attachment ${old.id}`);assert.equal(digest(Object.fromEntries(old.keys.map(k=>[k,current[k]]))),old.digest);}
   if(before.settingsDigest)assert.equal(digest(work.settings),before.settingsDigest);
  }
  await page.getByRole('button',{name:'新建',exact:false}).first().click();
  await page.getByRole('dialog').getByRole('textbox',{name:/^标题/}).fill('正式版新建草稿验证');
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'知识整理',exact:true}).click();
  await page.getByRole('button',{name:'新建笔记',exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox',{name:/^标题/}).fill('Markdown 正式版草稿验证');
  await page.getByRole('dialog').getByLabel('笔记正文').fill('# Markdown 已启用\n\n**重点**\n\n| 模块 | 状态 |\n| --- | --- |\n| 笔记 | 完成 |');
  await page.getByRole('dialog').getByRole('tab',{name:'预览',exact:true}).click();
  await page.getByRole('dialog').locator('.markdown-content h1').filter({hasText:'Markdown 已启用'}).waitFor();await page.getByRole('dialog').locator('.markdown-content table').waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'总览',exact:true}).click();
  const release=JSON.parse(fs.readFileSync('package.json','utf8')).version;
  await page.screenshot({path:`artifacts/v${release}-正式版界面.png`});
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'问题跟踪',exact:true}).click();await page.getByRole('heading',{name:'问题跟踪',exact:true}).waitFor();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'工作记录',exact:true}).click();await page.getByRole('heading',{name:'工作记录',exact:true}).waitFor();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'习惯养成',exact:true}).click();await page.getByRole('heading',{name:'习惯养成',exact:true}).waitFor();await page.getByRole('button',{name:'新建习惯',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:/^标题/}).fill('正式版习惯草稿验证');await page.getByRole('dialog').getByLabel('开始日期').waitFor();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'设置',exact:true}).click();await page.locator('.data-path code').waitFor();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'健康记录',exact:true}).click();await page.getByRole('heading',{name:'健康记录',exact:true}).waitFor();await page.getByRole('button',{name:'记录睡眠',exact:true}).first().click();await page.getByRole('dialog').getByLabel('入睡时间').waitFor();await page.getByRole('dialog').getByLabel('起床时间').waitFor();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('quit_app',{})).catch(()=>{});
  fs.writeFileSync(`artifacts/verification-v${release}.json`,JSON.stringify({release,dataPath:work.dataPath,recordCount:work.records.length,runtimeErrors:errors,legacyContentVerified:true,verifiedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({passed:'packaged release startup without dev server, native database, new-record dialog and settings page',dataPath:work.dataPath}));
 }finally{if(app.exitCode===null)app.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
