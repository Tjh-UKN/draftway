import {useEffect, useRef, useState, type FormEvent} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Dialog} from './ui';
import './room-dialog.css';

// A switchboard room (pip package `switchboard-room`) is for Claude Code sessions on several machines to message each
// other. Draftway only watches it: who is there, what they are doing and what they said.
export interface RoomSession {id: string; name: string; title: string; host: string; repo: string; state: string; status: string; unread: number; listening: boolean; draftwaySession: string | null}
export interface RoomMessage {id: number; at: number; from: string; to: string; link: string | null; kind: string; body: string; replyTo: number | null}
export interface RoomView {configured: boolean; url: string; sessions: RoomSession[]; messages: RoomMessage[]}

const kindLabel: Record<string, string> = {ask: '提问', reply: '回复', auto: '自动'};
const time = (at: number) => new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

export function RoomDialog({onOpenSession, onClose}: {onOpenSession: (id: string) => void; onClose: () => void}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({url: '', token: ''});
  const thread = useRef<HTMLOListElement>(null);
  const configured = !!view?.configured;

  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {const next = await invoke<RoomView>('room_view'); if (!active) return; setView(next); setError(''); if (!next.configured) return;}
      catch (reason) {if (active) setError(String(reason));}
      if (active) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {active = false; clearTimeout(timer);};
  }, [configured]);
  const lastMessage = view?.messages.at(-1)?.id;
  useEffect(() => {thread.current?.lastElementChild?.scrollIntoView({block: 'end'});}, [lastMessage]);

  async function connect(event?: FormEvent, imported = false) {
    event?.preventDefault(); setBusy(true);
    try {setView(await invoke<RoomView>('room_connect', imported ? {} : form)); setError(''); setForm(f => ({...f, token: ''}));}
    catch (reason) {setError(String(reason));}
    finally {setBusy(false);}
  }
  async function disconnect() {
    try {await invoke('room_disconnect'); setView(v => v && {...v, configured: false, sessions: [], messages: []});} catch (reason) {setError(String(reason));}
  }

  if (!view) return <Dialog title="协作室" onClose={onClose}><p className="quiet-note" role="status">{error || '正在连接…'}</p></Dialog>;
  if (!view.configured) return <Dialog title="协作室" onClose={onClose}>
    <form className="room-setup" onSubmit={event => void connect(event)}>
      <p className="quiet-note">协作室由 switchboard room 服务提供，局域网内多台机器上的 Claude Code 会话在这里互发消息。Draftway 只查看：各会话的状态和它们之间的消息，不发送消息，也不加入协作室。</p>
      <label className="field">服务地址<input required value={form.url} placeholder="http://192.168.1.20:8766" onChange={e => setForm({...form, url: e.target.value})}/></label>
      <label className="field">令牌<input required type="password" autoComplete="off" value={form.token} onChange={e => setForm({...form, token: e.target.value})}/></label>
      <p className="quiet-note">令牌保存在本机数据目录，不进入备份。</p>
      {error && <p className="tool-error" role="alert">{error}</p>}
      <footer><button type="button" className="outline-button" disabled={busy} onClick={() => void connect(undefined, true)} title="读取 room join 写入的 ~/.config/switchboard/room.json">使用本机 room 配置</button><button className="primary-button" disabled={busy}>连接</button></footer>
    </form>
  </Dialog>;

  const live = view.sessions.filter(s => s.state !== 'exited');
  const hosts = [...new Set(live.map(s => s.host))];
  return <Dialog title="协作室" onClose={onClose}>
    <div className="room-dialog">
      <header className="room-identity"><span>{view.url}</span><button type="button" className="text-button" onClick={() => void disconnect()}>断开</button></header>
      <section aria-label="会话">
        <div className="section-label">会话（{live.length}）</div>
        {!live.length && <p className="quiet-note">协作室里暂时没有在线会话。</p>}
        {hosts.map(host => <div key={host} className="room-host"><h3>{host}</h3>{live.filter(s => s.host === host).map(session =>
          <div key={session.id} className="room-session">
            <span className="room-session-label">
              <i className={`room-state ${session.state}`} aria-label={session.state === 'live' ? '在线' : '静默'}/>
              <strong>{session.title || session.name || session.id.slice(0, 8)}</strong><small>{session.repo || '—'}</small>
              {session.status && <small className="room-status">{session.status}</small>}
              {session.listening && <small className="room-badge">待命</small>}{!!session.unread && <small className="room-badge">✉{session.unread}</small>}
            </span>
            {session.draftwaySession && <button type="button" className="text-button" onClick={() => onOpenSession(session.draftwaySession!)}>打开会话</button>}
          </div>)}</div>)}
      </section>
      <section aria-label="消息">
        <div className="section-label">消息</div>
        {!view.messages.length ? <p className="quiet-note">还没有消息。</p> : <ol className="room-thread" ref={thread}>{view.messages.map(message =>
          <li key={message.id}>
            <div><strong>{message.from}</strong><span>→ {message.link ? `#${message.link}` : message.to}</span>{kindLabel[message.kind] && <em>{kindLabel[message.kind]}{message.replyTo ? ` #${message.replyTo}` : ''}</em>}<time>{time(message.at)}</time></div>
            <p>{message.body}</p>
          </li>)}</ol>}
      </section>
    </div>
  </Dialog>;
}
