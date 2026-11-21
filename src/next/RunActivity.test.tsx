import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {RunActivity, TranscriptActivities} from './RunActivity';
import {SessionTranscript} from './SessionTranscript';
import type {AgentSession, Message, Run} from './core';
import {activityByMessage} from './session-transcript';

const run: Run = {id: 'run', sessionId: 'session', state: 'running', startedAt: 0, dueAt: 0};

it('describes the current phase before the reply arrives', () => {
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'sending'}}/>)).toContain('正在发送…');
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'connecting'}}/>)).toContain('正在连接执行器…');
  expect(renderToStaticMarkup(<RunActivity run={{...run, phase: 'submitting'}}/>)).toContain('正在提交消息…');
});

it('shows actual tool steps and withholds private reasoning text', () => {
  const activity: Run['activity'] = [
    {id: 'thought', kind: 'thinking', title: 'private reasoning title', status: 'running', detail: 'private reasoning text'},
    {id: 'command', kind: 'command', title: '执行命令', detail: 'git status', status: 'running', output: 'first line\nworking tree clean'},
    {id: 'read', kind: 'files', title: '读取文件', status: 'completed', detail: 'README.md'},
  ];
  const live = {...run, phase: 'executing' as const, activity};
  const html = renderToStaticMarkup(<TranscriptActivities entries={activityByMessage([live]).get('run-user')!}/>);
  expect(html).toContain('git status');
  expect(html).toContain('README.md');
  expect(html).toContain('<details class="activity-detail">');
  expect(html).toContain('class="activity-live-output">working tree clean');
  expect(renderToStaticMarkup(<RunActivity run={live}/>)).toBe('');
  expect(html).not.toContain('private reasoning');

  const settled = renderToStaticMarkup(<TranscriptActivities entries={activityByMessage([{...live, state: 'cancelled'}]).get('run-user')!}/>);
  expect(settled).toContain('working tree clean');
  expect(settled).not.toContain('activity-live-output');
  expect(settled).not.toContain('spinning');
  expect(settled).not.toContain('private reasoning');
});

it('places activity between its original messages and groups adjacent web actions', () => {
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
    {id: 'query', kind: 'search', title: '搜索网页', detail: 'wearable data', status: 'completed', afterMessageId: 'before-tool'},
    {id: 'page', kind: 'search', title: '打开网页', detail: 'https://example.com/source', status: 'completed', afterMessageId: 'before-tool'},
  ]};
  const html = renderToStaticMarkup(<SessionTranscript session={session} provider="Pi" demo={false} visible activityRuns={[
    {...run, id: 'old', state: 'succeeded', activity: [{id: 'list', kind: 'tool', title: '列出文件', status: 'completed'}]},
    live,
  ]}>
    <RunActivity run={live}/>
  </SessionTranscript>);
  const order = ['旧问题', '列出文件', '旧回答', '新问题', '我先查看目录。', '读取目录', '网页活动', 'wearable data', 'https://example.com/source', '<strong>结果</strong>'];
  expect(order.reduce((previous, fragment) => {
    const index = html.indexOf(fragment);
    expect(index).toBeGreaterThan(previous);
    return index;
  }, -1)).toBeGreaterThan(0);
  expect(html.match(/读取目录/g)).toHaveLength(1);
  expect(html).not.toContain('Private');
});
