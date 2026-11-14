import {useEffect, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {ExternalLink, RotateCw} from 'lucide-react';
import MarkdownView from '../MarkdownView';
import type {DockTab} from './docking';
interface Report {repository?: string; round_status?: string; started_at?: string; counts?: {approved?: number; posted?: number}; pulls?: {pr: number; title?: string; status: string; approved?: {body?: string; path?: string; line?: number}[]; errors?: string[]}[]}
export function ReportView({workspaceId, tab, onDashboard}: {workspaceId: string; tab: Extract<DockTab, {kind: 'report'}>; onDashboard: () => void}) {
  const [report, setReport] = useState<Report | null>(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {let alive = true; setError(''); setReport(null); if (!isTauri()) {setError('请在 Windows 版中读取本机检视报告。'); return;}
    void invoke<Report>('review_report', {workspaceId, file: tab.file, url: tab.url}).then(value => {if (!value || !Array.isArray(value.pulls)) throw new Error('报告格式不兼容，请打开原看板查看。'); if (alive) setReport(value);}).catch(e => {if (alive) setError(String(e));}); return () => {alive = false;};
  }, [workspaceId, tab.url, tab.file, reload]);
  return <div className="report-view"><header className="report-toolbar"><span>检视报告 · 只读</span><button className="text-button" onClick={() => setReload(n => n + 1)}><RotateCw size={14}/>刷新</button><button className="text-button" onClick={onDashboard}><ExternalLink size={14}/>打开原看板</button></header><article className="report-document">
    {error ? <p className="tool-error" role="alert">{error}</p> : !report ? <p className="quiet-note">正在读取报告…</p> : <><h1>{report.repository || 'PR 检视报告'}</h1><p className="muted">{report.started_at} · {report.round_status === 'in_progress' ? '阶段结果' : report.round_status === 'failed' ? '检视失败' : ['completed', 'noop'].includes(report.round_status || '') ? '检视完成' : '状态待确认'}</p><p className="quiet-note">{report.pulls?.length || 0} 个 PR · 通过质量门控的意见 {report.counts?.approved || 0} 条 · 已发布 {report.counts?.posted || 0} 条</p>{report.pulls?.map(pr => <section key={pr.pr}><h2>#{pr.pr} · {pr.title || '未命名 PR'}</h2><p className="quiet-note">{pr.status === 'complete' ? 'Review 完成' : 'Review 未完成'}</p>{pr.approved?.map((finding, i) => <div className="report-finding" key={i}>{finding.path && <code>{finding.path}{finding.line ? `:${finding.line}` : ''}</code>}<MarkdownView value={finding.body || ''} onOpenLink={url => {void invoke('open_external_url', {url}).catch(e => setError(String(e)));}}/></div>)}{!pr.approved?.length && <p className="quiet-note">{pr.status === 'complete' ? '没有通过质量门控的意见。' : '没有可展示的检视意见。'}</p>}{pr.errors?.map((text, i) => <p className="tool-error" key={i}>{text}</p>)}</section>)}</>}
  </article></div>;
}
