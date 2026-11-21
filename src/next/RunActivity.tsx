import {ChevronRight, Ellipsis, FileText, Globe, ListChecks, LoaderCircle, Terminal, Wrench} from 'lucide-react';
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

const activityIcons = {command: Terminal, files: FileText, search: Globe, tool: Wrench, thinking: Ellipsis, plan: ListChecks};

function ActivityRow({item, live, waiting}: {item: Activity; live: boolean; waiting: boolean}) {
  const thinking = item.kind === 'thinking';
  const running = item.status === 'running';
  const label = running && waiting ? '等待你的操作' : running && !live ? '状态未确认' : activityLabels[item.status];
  const detail = thinking ? undefined : item.detail;
  const subject = thinking ? undefined : item.subject || detail?.split('\n')[0];
  const output = thinking ? undefined : item.output;
  const exitCode = thinking ? undefined : item.exitCode;
  const Icon = running && live && !waiting ? LoaderCircle : activityIcons[item.kind];
  const expandable = !!detail || !!output || exitCode !== undefined;
  const line = <>
    <Icon className={Icon === LoaderCircle ? 'spinning' : undefined} size={14} aria-hidden="true"/>
    <span className="activity-title">{thinking ? '思考' : item.title}</span>
    {subject && item.kind !== 'plan' && <span className="activity-target" title={subject}>{subject}</span>}
    <small data-status={item.status}>{label}</small>
  </>;
  const latest = live && running && output?.trim().split('\n').at(-1);
  return <li className="run-activity-row">
    {expandable ? <details className="activity-detail" open={item.kind === 'plan' && running ? true : undefined}>
      <summary className="run-activity-line">{line}<ChevronRight size={13} className="activity-chevron" aria-hidden="true"/></summary>
      {detail && <pre>{detail}</pre>}
      {output && <><span className="activity-output-label">输出摘录</span><pre>{output}</pre></>}
      {exitCode !== undefined && <span className="activity-output-label">退出码 {exitCode}</span>}
    </details> : <div className="run-activity-line">{line}</div>}
    {latest && <code className="activity-live-output">{latest}</code>}
  </li>;
}

export function TranscriptActivities({entries}: {entries: readonly TranscriptActivity[]}) {
  const groups: TranscriptActivity[][] = [];
  for (const entry of entries) {
    const group = groups.at(-1);
    if (entry.item.kind === 'search' && group?.[0].item.kind === 'search' && group[0].runId === entry.runId) group.push(entry);
    else groups.push([entry]);
  }
  const row = ({item, runId, live, waiting}: TranscriptActivity) =>
    <ActivityRow key={`${runId}-${item.kind}-${item.id}`} item={item} live={live} waiting={waiting}/>;
  return <ul className="run-activity-list transcript-activities" aria-label="执行步骤">
    {groups.map(group => group.length === 1 ? row(group[0]) :
      <li key={`search-${group[0].runId}-${group[0].item.id}`} className="activity-search-group">
        <details open>
          <summary><Globe size={14} aria-hidden="true"/>网页活动 {group.length} 项</summary>
          <ul className="run-activity-list">{group.map(row)}</ul>
        </details>
      </li>)}
  </ul>;
}

export function RunActivity({run}: {run: Run}) {
  const activeStep = run.activity?.some(item => item.status === 'running');
  const status = run.stopping ? '正在停止…' :
    run.state === 'running' && !activeStep ? (run.phase ? phaseLabels[run.phase] : '执行器处理中…') : null;

  if (!status) return null;
  return <section className="run-activity" aria-label="本轮执行进度">
    <div className="run-progress" role="status"><LoaderCircle size={15} className="spinning" aria-hidden="true"/><span>{status}</span></div>
  </section>;
}
