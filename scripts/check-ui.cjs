const path=require('node:path');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let playwright;
try{playwright=require('playwright');}catch{playwright=require(require.resolve('playwright',{paths:[path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node')]}));}
(async()=>{
 const browser=await playwright.chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error('Runtime error',e.message);});
 await page.goto(process.env.NORTHSTAR_URL||'http://127.0.0.1:1420/');
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'总览',exact:true}).click();await page.locator('.dashboard-intro h1').waitFor();
 fs.mkdirSync('artifacts',{recursive:true});
 await page.screenshot({path:'artifacts/dashboard.png',fullPage:true});
 const nav=label=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:new RegExp('^'+label)});
 const create=async(kind,title)=>{
   await page.getByRole('button',{name:'新建',exact:false}).first().click();
   const dialog=page.getByRole('dialog');await dialog.locator('.type-picker').getByRole('button',{name:kind,exact:true}).click();
   await dialog.getByRole('textbox',{name:/^标题/}).fill(title);return dialog;
 };
 let dialog=await create('目标','验证年度目标');await dialog.getByLabel('说明').fill('建立可靠的工作流');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 dialog=await create('项目','验证关联项目');await dialog.getByLabel('关联目标').selectOption({label:'验证年度目标'});await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 dialog=await create('任务','验证持久化任务');await dialog.getByLabel('所属项目').selectOption({label:'验证关联项目'});await dialog.getByLabel('优先级').selectOption({label:'优先推进'});await dialog.getByLabel('截止时间').fill('2026-10-03T15:30');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await nav('事项备忘').click();await page.locator('.task-title:visible').filter({hasText:'验证持久化任务'}).waitFor();
 await page.getByRole('button',{name:'完成：验证持久化任务',exact:true}).click();await page.getByRole('button',{name:'重新打开：验证持久化任务',exact:true}).waitFor();
 await page.getByRole('button',{name:'看板视图',exact:true}).click();await page.getByRole('combobox',{name:'验证持久化任务的状态'}).selectOption('doing');await page.waitForTimeout(250);
 await page.keyboard.press('Control+k');await page.getByLabel('搜索工作台内容').fill('验证持久化任务');await page.locator('.search-results button').first().click();
 dialog=page.getByRole('dialog');await dialog.getByRole('textbox',{name:/^标题/}).fill('修改后的持久化任务');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.reload();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'总览',exact:true}).click();await page.locator('.dashboard-intro h1').waitFor();await nav('事项备忘').click();await page.locator('.task-title:visible').filter({hasText:'修改后的持久化任务'}).waitFor();
 dialog=await create('节点','验证项目验收');await dialog.getByLabel('所属项目').selectOption({label:'验证关联项目'});await dialog.getByLabel('节点日期').fill('2026-10-16');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await nav('日历与节点').click();await page.locator('.node-list h3').filter({hasText:'验证项目验收'}).waitFor();
 dialog=await create('笔记','验证关联笔记');await dialog.getByLabel('所属项目').selectOption({label:'验证关联项目'});await dialog.getByLabel('笔记正文').fill('关于目标与任务的验证记录\n第二段内容');await dialog.getByLabel('标签').fill('验证，项目');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await nav('知识整理').click();await page.locator('.note-title').filter({hasText:'验证关联笔记'}).waitFor();
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'添加附件',exact:true}).click();const file=await chooser;await file.setFiles({name:'验证附件.txt',mimeType:'text/plain',buffer:Buffer.from('attachment contents')});await page.locator('.file-chip').filter({hasText:'验证附件.txt'}).waitFor();
 await nav('文件柜').click();await page.locator('.file-name').filter({hasText:'验证附件.txt'}).waitFor();
 await nav('发展规划').click();await page.getByRole('button',{name:'验证年度目标',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'归档',exact:true}).click();await dialog.waitFor({state:'hidden'});await nav('归档').click();assert.equal(await page.locator('.archive-row').count(),5);
 await page.locator('.archive-row').filter({hasText:'验证年度目标'}).getByRole('button',{name:'恢复',exact:true}).click();await page.waitForTimeout(300);assert.equal(await page.locator('.archive-row').count(),0);
 await nav('设置').click();await page.getByLabel('如何称呼你').fill('测试用户');await page.getByLabel('主题',{exact:true}).selectOption('light');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForTimeout(250);assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.getByLabel('主题',{exact:true}).selectOption('dark');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForTimeout(250);
 await nav('总览').click();await page.getByRole('button',{name:'规划助手',exact:true}).click();await page.getByRole('button',{name:'生成复盘笔记',exact:true}).click();await page.getByRole('dialog').getByLabel('笔记正文').waitFor();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'收起规划助手'}).click();
 const layout=[];
 for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:960});
  for(const name of ['总览','发展规划','事项备忘','日历与节点','知识整理','文件柜','归档','设置']){
    await nav(name).click();const size=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));layout.push({width,page:name,...size});assert.ok(size.scroll<=size.w+1,`Overflow at ${width}: ${name}`);
  }
 }
 await page.setViewportSize({width:1440,height:960});await nav('总览').click();await page.screenshot({path:'artifacts/dashboard-verified.png',fullPage:true});await nav('日历与节点').click();await page.screenshot({path:'artifacts/calendar-verified.png',fullPage:true});
 assert.deepEqual(errors,[]);await browser.close();console.log(JSON.stringify({passed:'create/edit/persist, task state, search, calendar, note attachments, cascade archive/restore, settings, assistant, responsive pages',layouts:layout.length,runtimeErrors:errors}));
})().catch(e=>{console.error(e);process.exit(1);});
