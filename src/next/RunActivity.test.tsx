import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {RunActivity} from './RunActivity';
import {SessionTranscript} from './SessionTranscript';
import type {AgentSession, Message, Run} from './core';

const run: Run = {id: 'run', sessionId: 'session', state: 'running', startedAt: 0, dueAt: 0};

it('describes the current phase before the reply arrives', () => {
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'sending'}}/>)).toContain('正在发送…');
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'connecting'}}/>)).toContain('正在连接执行器…');
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'submitting'}}/>)).toContain('正在提交消息…');
});

it('shows actual tool steps and withholds private reasoning text', () => {
  const activity: Run['activity'] = [
    {id: 'thought', kind: 'thinking', title: 'private reasoning title', status: 'running', detail: 'private reasoning text'},
    {id: 'command', kind: 'command', title: 'git status', status: 'running'},
    {id: 'read', kind: 'files', title: 'Read README.md', status: 'completed', detail: 'README.md'},
  ];
  const html = renderToStaticMarkup(<RunActivity run={{...run, phase: 'executing', activity}}/>);
  expect(html).toContain('git status');
  expect(html).toContain('执行记录（1）');
  expect(html).toContain('<details class="run-activity-history">');
  expect(html).not.toContain('执行器处理中…');
  expect(html).not.toContain('private reasoning');

  const settled = renderToStaticMarkup(<RunActivity run={{...run, state: 'cancelled', activity}}/>);
  expect(settled).toContain('执行记录（3）');
  expect(settled).not.toContain('spinning');
  expect(settled).not.toContain('private reasoning');
});

it('places Pi activities between their original messages and keeps earlier turns in history', () => {
  const messages: Message[] = [
    {id: 'old-user', role: 'user', text: '旧问题', at: 1},
    {id: 'old-reply', role: 'assistant', text: '旧回答', at: 2},
    {id: 'run-user', role: 'user', text: '新问题', at: 3},
    {id: 'before-tool', role: 'assistant', text: '我先查看目录。', at: 4},
    {id: 'after-tool', role: 'assistant', text: '**结果**', at: 5},
  ];
  const session: AgentSession = {
    id: run.sessionId, workspaceId: 'work', nodeId: null, integrationId: 'pi',
    title: 'Pi', messages, draft: '', unread: false, createdAt: 0,
  };
  const live: Run = {...run, state: 'running', activity: [
    {id: 'think', kind: 'thinking', title: 'Private title', detail: 'Private detail', status: 'completed', afterMessageId: 'run-user'},
    {id: 'read', kind: 'tool', title: '读取目录', status: 'running', afterMessageId: 'before-tool'},
  ]};
  const html = renderToStaticMarkup(<SessionTranscript session={session} provider="Pi" demo={false} visible activityRuns={[
    {...run, id: 'old', state: 'succeeded', activity: [{id: 'list', kind: 'tool', title: '列出文件', status: 'completed'}]},
    live,
  ]}>
    <RunActivity run={live} placedInTranscript/>
  </SessionTranscript>);
  const order = ['旧问题', '列出文件', '旧回答', '新问题', '思考', '我先查看目录。', '读取目录', '<strong>结果</strong>'];
  expect(order.reduce((previous, fragment) => {
    const index = html.indexOf(fragment);
    expect(index).toBeGreaterThan(previous);
    return index;
  }, -1)).toBeGreaterThan(0);
  expect(html.match(/读取目录/g)).toHaveLength(1);
  expect(html).not.toContain('Private');
});
