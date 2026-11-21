import {useState} from 'react';
import {Pencil, Trash2} from 'lucide-react';
import type {AgentSession, WorkbenchState} from './core';
import {SessionRow} from './Sessions';
import {Dialog, Empty} from './ui';

export function SessionManagement({state, workspaceId, disabled, onOpen, onRename, onDelete}: {state: WorkbenchState; workspaceId: string; disabled: boolean; onOpen: (id: string) => void; onRename: (id: string, title: string) => Promise<void>; onDelete: (session: AgentSession) => void}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AgentSession | null>(null);
  const sessions = state.sessions.filter(session => session.workspaceId === workspaceId);
  const needle = query.trim().toLocaleLowerCase();
  const visible = sessions.filter(session => !needle || `${session.title} ${session.agentId || ''}`.toLocaleLowerCase().includes(needle) || session.messages.some(message => message.text.toLocaleLowerCase().includes(needle))).sort((a, b) => b.createdAt - a.createdAt);
  return <><input className="search-field" aria-label="搜索会话" placeholder="搜索会话名称、后端或内容" value={query} onChange={event => setQuery(event.target.value)}/><div className="workspace-session-list">{visible.map(session => <div className="managed-session-row" key={session.id} data-session-id={session.id}><SessionRow state={state} session={session} onOpen={() => onOpen(session.id)}/><div className="session-row-actions"><button className="icon-button" disabled={disabled} aria-label={`重命名会话：${session.title}`} title="重命名会话" onClick={() => setEditing(session)}><Pencil size={14}/></button><button className="icon-button danger-text" disabled={disabled} aria-label={`删除会话：${session.title}`} title="删除会话" onClick={() => onDelete(session)}><Trash2 size={14}/></button></div></div>)}{!visible.length && <Empty title={sessions.length ? '没有匹配的会话' : '还没有会话'}><p>{sessions.length ? '试试其他关键词。' : '点“＋”选择后端开始。'}</p></Empty>}</div>{editing && <RenameSessionDialog session={editing} onClose={() => setEditing(null)} onSave={onRename}/>}</>;
}

export function RenameSessionDialog({session, onClose, onSave}: {session: AgentSession; onClose: () => void; onSave: (id: string, title: string) => Promise<void>}) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title="重命名会话" onClose={() => {if (!busy) onClose();}}><form onSubmit={event => {event.preventDefault(); if (busy || !title.trim()) return; setBusy(true); setError(''); void onSave(session.id, title.trim()).then(onClose).catch(error => {setError(String(error)); setBusy(false);});}}><label className="field">会话名称<input autoFocus required maxLength={100} disabled={busy} value={title} onChange={event => setTitle(event.target.value)}/></label>{error && <p className="tool-error" role="alert">{error}</p>}<footer><button type="button" className="outline-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !title.trim()}>{busy ? '正在保存…' : '保存名称'}</button></footer></form></Dialog>;
}

export function DeleteDialog({title, description, onClose, onDelete}: {title: string; description: string; onClose: () => void; onDelete: () => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={title} onClose={() => {if (!busy) onClose();}}><p className="muted">{description}</p><p className="quiet-note">删除后无法撤销。工作目录文件、原始材料和个人工作台业务记录保留。</p>{error && <p className="tool-error" role="alert">{error}</p>}<footer><button className="outline-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button danger-button" disabled={busy} onClick={() => {setBusy(true); setError(''); void onDelete().then(onClose).catch(error => {setError(String(error)); setBusy(false);});}}>{busy ? '正在删除…' : '确认删除'}</button></footer></Dialog>;
}
