import {LoaderCircle} from 'lucide-react';
import type {Run} from './core';
import type {TranscriptActivity} from './session-transcript';
import './run-activity.css';

type Activity = NonNullable<Run['activity']>[number];

const phaseLabels: Record<NonNullable<Run['phase']>, string> = {
  sending: '正在发送…',
  connecting: '正在连接执行器…',
  submitting: '正在提交消息…',
  executing: '执行器处理中…',
  responding: '正在回复…',
};

const activityLabels: Record<Activity['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};

function ActivityRow({item, live, waiting}: {item: Activity; live: boolean; waiting: boolean}) {
  const thinking = item.kind === 'thinking';
  const running = item.status === 'running';
  const label = running && waiting ? '等待你的操作' : running && !live ? '状态未确认' : activityLabels[item.status];
  return <li className="run-activity-row">
    <div className="run-activity-line">
      {running && live && !waiting && <LoaderCircle className="spinning" size={14} aria-hidden="true"/>}
      <span>{thinking ? '思考' : item.title}</span>
      <small>{label}</small>
    </div>
    {!thinking && item.detail && <pre>{item.detail}</pre>}
  </li>;
}

export function TranscriptActivities({entries}: {entries: readonly TranscriptActivity[]}) {
  return <ul className="run-activity-list transcript-activities" aria-label="执行步骤">
    {entries.map(({item, runId, live, waiting}) =>
      <ActivityRow key={`${runId}-${item.kind}-${item.id}`} item={item} live={live} waiting={waiting}/>)}
  </ul>;
}

export function RunActivity({run, placedInTranscript = false}: {run: Run; placedInTranscript?: boolean}) {
  const waiting = run.state === 'needs_input';
  const live = run.state === 'running' || waiting;
  const activity = run.activity || [];
  const running = live ? activity.filter(item => item.status === 'running') : [];
  const hasActiveTool = running.some(item => item.kind !== 'thinking');
  const visible = hasActiveTool ? running.filter(item => item.kind !== 'thinking') : running;
  const history = live ? activity.filter(item => item.status !== 'running') : activity;
  const status = run.stopping ? '正在停止…' :
    run.state === 'running' && !visible.length ? (run.phase ? phaseLabels[run.phase] : '执行器处理中…') : null;

  if (!status && (placedInTranscript || (!visible.length && !history.length))) return null;
  return <section className="run-activity" aria-label="本轮执行进度">
    {status && <div className="run-progress" role="status"><LoaderCircle size={15} className="spinning" aria-hidden="true"/><span>{status}</span></div>}
    {!placedInTranscript && !!visible.length && <ul className="run-activity-list" aria-label="当前步骤">
      {visible.map(item => <ActivityRow key={item.id} item={item} live waiting={waiting}/>)}
    </ul>}
    {!placedInTranscript && !!history.length && <details className="run-activity-history">
      <summary>执行记录（{history.length}）</summary>
      <ul className="run-activity-list">
        {history.map(item => <ActivityRow key={item.id} item={item} live={false} waiting={false}/>)}
      </ul>
    </details>}
  </section>;
}
