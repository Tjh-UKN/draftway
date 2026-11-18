const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
let playwright;try{playwright=require('playwright');}catch{playwright=require(require.resolve('playwright',{paths:[path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node')]}));}
const source='# Markdown 笔记\n\n**重点**与*强调*，还有 ~~删除线~~。\n\n## 行动清单\n\n- [x] 完成编辑器\n- [ ] 验证桌面预览\n\n> 保留做事的过程。\n\n```ts\nconst ready = true;\nconsole.log(ready);\n```\n\n| 模块 | 状态 |\n| --- | --- |\n| 笔记 | 已完成 |\n\n[文档](https://example.com/docs)\n\n旧文本第一行\n旧文本第二行\n\n脚注示例[^note]\n\n[^note]: 这里是脚注。';
(async()=>{
 const browser=await playwright.chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto('http://127.0.0.1:1420/?embed=knowledge&view=markdown-check');
  await page.getByRole('button',{name:'新建笔记',exact:true}).first().click();
  assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByLabel('笔记标题',{exact:true}).fill('Markdown 完整验证');
  await page.getByRole('tab',{name:'源码',exact:true}).click();
  const body=page.getByLabel('笔记正文',{exact:true});await body.fill(source);
  await page.getByRole('tab',{name:'阅读',exact:true}).click();
  await page.locator('.note-reading h1').filter({hasText:'Markdown 笔记'}).waitFor();
  assert.equal(await page.locator('.note-reading table').count(),1);
  assert.equal(await page.locator('.note-reading pre code').innerText(),'const ready = true;\nconsole.log(ready);\n');
  await page.getByRole('tab',{name:'源码',exact:true}).click();
  await body.press('Control+End');await body.press('End');await body.press('Shift+Home');await body.press('Control+b');
  const finalSource=source.replace('[^note]: 这里是脚注。','**[^note]: 这里是脚注。**');
  const readSource=async()=> (await body.locator('.cm-line').allTextContents()).join('\n');
  assert.equal(await readSource(),finalSource);
  await body.press('Control+s');await page.getByRole('status').filter({hasText:'已保存'}).waitFor();
  await page.getByRole('button',{name:'欢迎来到北极星',exact:false}).click();
  await page.getByRole('button',{name:'Markdown 完整验证',exact:false}).click();
  await page.getByRole('tab',{name:'源码',exact:true}).click();assert.equal(await readSource(),finalSource);
  await page.reload();await page.getByRole('button',{name:'Markdown 完整验证',exact:false}).click();
  await page.getByRole('tab',{name:'源码',exact:true}).click();assert.equal(await readSource(),finalSource);
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出笔记',exact:true}).click();const download=await downloaded;assert.equal(fs.readFileSync(await download.path(),'utf8'),finalSource);assert.equal(download.suggestedFilename(),'Markdown 完整验证.md');
  for(const width of [1440,1024,768]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('tab',{name:'实时预览',exact:true}).click();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/note-editor-check.png'});
  await page.getByRole('button',{name:'归档笔记',exact:true}).click();await page.getByRole('button',{name:'Markdown 完整验证',exact:false}).waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:'direct writing, live/source/reading modes, formatting, autosave, switch/reload persistence, exact export and archive',runtimeErrors:errors}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
