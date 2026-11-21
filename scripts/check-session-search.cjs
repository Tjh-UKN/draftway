const assert = require('node:assert/strict');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); } catch {
  playwright = require(require.resolve('playwright', {paths: [path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node')]}));
}

(async () => {
  const browser = await playwright.chromium.launch({headless: true, channel: 'msedge'});
  const page = await browser.newPage({viewport: {width: 1440, height: 940}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const saved = () => page.locator('.shell-status').getByText('已保存到本机', {exact: true}).waitFor();
  const activeChat = page.getByLabel('会话：会话内查找', {exact: true});
  const otherChat = page.getByLabel('会话：另一分屏', {exact: true});
  const log = activeChat.getByRole('log');
  const composer = activeChat.getByRole('textbox', {name: '会话消息'});
  const search = activeChat.getByRole('search');
  const query = search.getByRole('textbox', {name: '查找会话内容'});
  const count = text => search.getByRole('status').getByText(text, {exact: true}).waitFor();
  const highlighted = (id, text) => page.waitForFunction(({id, text}) => {
    const match = [...(CSS.highlights?.get('draftway-search-current') ?? [])][0];
    const message = match?.startContainer.parentElement?.closest('[data-message-id]');
    const viewport = message?.closest('[role="log"]')?.getBoundingClientRect();
    const rect = match?.getBoundingClientRect();
    return message?.dataset.messageId === id && match.toString() === text &&
      rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
  }, {id, text});

  try {
    await page.goto(process.env.NORTHSTAR_URL || 'http://127.0.0.1:1420/next.html');
    await saved();
    await page.evaluate(async () => {
      const core = await import('/src/next/core.ts');
      const docking = await import('/src/next/docking.ts');
      let state = core.initialWorkbench();
      state = core.createSession(state, 'design', null, 'history', 1, 'codex', '会话内查找');
      state = core.createSession(state, 'design', null, 'other', 2, 'pi', '另一分屏');
      const space = state.spaces.find(item => item.id === 'design');
      space.dock = docking.selectDockTab(docking.moveDockTab(space.dock, 'other', 'main', undefined, 'right', 'other-pane'), 'history');
      const history = state.sessions.find(item => item.id === 'history');
      history.messages = Array.from({length: 90}, (_, index) => ({
        id: 'row-' + index, role: index % 2 ? 'assistant' : 'user',
        at: index + 1, text: '普通消息 ' + index,
      }));
      history.messages[0].text = 'NEEDLE [x]，然后还有 needle [x]';
      history.messages[35].text = ('较长 Markdown 回答，中间保留原本格式。\n\n').repeat(140) + '**Needle [x]**';
      history.messages[50].files = [{kind: 'reference', name: '需求记录.md', path: 'C:/test/需求记录.md'}];
      history.messages[87].text = '最后的 needle [x]';
      state.sessions.find(item => item.id === 'other').messages = [{id: 'other-1', role: 'assistant', at: 1, text: '另一分屏的 needle [x]'}];
      localStorage.setItem(core.shellStorageKey, JSON.stringify(state));
    });

    await page.reload();
    await saved();
    await log.locator('[data-message-id="row-89"]').waitFor();
    assert.equal(await log.locator('[data-message-id="row-0"]').count(), 0);
    await composer.fill('查找过程中保留这段草稿');
    await page.keyboard.press('Control+f');
    await query.waitFor();
    assert.equal(await query.evaluate(input => document.activeElement === input), true);
    await query.fill('needle [x]');
    await count('1 / 4');
    await highlighted('row-0', 'NEEDLE [x]');
    await query.press('Enter');
    await count('2 / 4');
    await highlighted('row-0', 'needle [x]');
    await search.getByRole('button', {name: '下一个匹配'}).click();
    await count('3 / 4');
    await highlighted('row-35', 'Needle [x]');
    assert.equal(await log.locator('[data-message-id="row-35"] strong').textContent(), 'Needle [x]');
    await query.press('Enter');
    await count('4 / 4');
    await highlighted('row-87', 'needle [x]');
    await query.press('Enter');
    await count('1 / 4');
    await query.press('Shift+Enter');
    await count('4 / 4');
    await highlighted('row-87', 'needle [x]');

    await query.fill('不存在的词');
    await count('无匹配');
    assert.equal(await search.getByRole('button', {name: '下一个匹配'}).isDisabled(), true);
    await query.fill('需求记录.md');
    await count('1 / 1');
    await highlighted('row-50', '需求记录.md');
    await query.press('Escape');
    await search.waitFor({state: 'hidden'});
    assert.equal(await composer.inputValue(), '查找过程中保留这段草稿');
    assert.equal(await composer.evaluate(input => document.activeElement === input), true);
    await activeChat.getByRole('button', {name: '回到最新消息'}).click();
    await log.locator('[data-message-id="row-89"]').waitFor();

    await otherChat.getByRole('textbox', {name: '会话消息'}).focus();
    await page.keyboard.press('Control+f');
    await otherChat.getByRole('search').getByRole('textbox').fill('needle [x]');
    await otherChat.getByRole('status').getByText('1 / 1', {exact: true}).waitFor();
    await search.waitFor({state: 'hidden'});
    await page.getByRole('button', {name: '自定工作区', exact: true}).focus();
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('.transcript-search input:focus').count(), 0);

    await page.reload();
    await saved();
    await page.getByRole('tab', {name: 'Codex：会话内查找', exact: true}).focus();
    await page.keyboard.press('Control+f');
    await query.fill('needle [x]');
    await count('1 / 4');
    await highlighted('row-0', 'NEEDLE [x]');
    assert.deepEqual(errors, []);
    console.log('PASS: per-chat search, pane focus, virtualized history, repeated and literal matches, Markdown, file names, draft and reload');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
