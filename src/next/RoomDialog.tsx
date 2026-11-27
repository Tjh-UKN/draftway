import {useEffect, useRef, useState, type FormEvent} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CornerUpLeft, Send} from 'lucide-react';
import {Dialog} from './ui';
import './room-dialog.css';

// A switchboard room (pip package `switchboard-room`): Claude Code sessions on several machines share one mailbox.
export interface RoomSession {id: string; name: string; host: string; repo: string; state: string; status: string; unread: number; listening: boolean; draftwaySession: string | null}
export interface RoomMessage {id: number; at: number; from: string; to: string; link: string | null; kind: string; body: string; replyTo: number | null; mine: boolean; toMe: boolean}
export interface RoomView {configured: boolean; url: string; host: string; me: string; sessions: RoomSession[]; messages: RoomMessage[]; links: string[]}

export const roomAddress = (session: RoomSession) => session.name ? `${session.name}@${session.host}` : session.id.slice(0, 8);
const kindLabel: Record<string, string> = {ask: '提问', reply: '回复', auto: '自动'};
const time = (at: number) => new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

export function RoomDialog({onOpenSession, onClose}: {onOpenSession: (id: string) => void; onClose: () => void}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({url: '', token: '', host: ''});
  const [draft, setDraft] = useState({to: '', body: '', ask: false, replyTo: null as number | null});
  const thread = useRef<HTMLOListElement>(null);
  const configured = !!view?.configured;

  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {const next = await invoke<RoomView>('room_view'); if (!active) return; setView(next); setError(''); if (!next.configured) {setForm(f => f.host ? f : {...f, host: next.host}); return;}}
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
  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      await invoke('room_send', {to: draft.to, body: draft.body, ask: draft.ask, replyTo: draft.replyTo});
      setDraft(d => ({...d, body: '', ask: false, replyTo: null})); setError('');
      setView(await invoke<RoomView>('room_view'));
    } catch (reason) {setError(String(reason));}
    finally {setBusy(false);}
  }

  if (!view) return <Dialog title="协作室" onClose={onClose}><p className="quiet-note" role="status">{error || '正在连接…'}</p></Dialog>;
  if (!view.configured) return <Dialog title="协作室" onClose={onClose}>
    <form className="room-setup" onSubmit={event => void connect(event)}>
      <p className="quiet-note">协作室由 switchboard room 服务提供，局域网内多台机器上的 Claude Code 会话在这里互发消息。连接后可查看各会话的状态，并以 draftway@{form.host || '本机'} 的身份发消息。</p>
      <label className="field">服务地址<input required value={form.url} placeholder="http://192.168.1.20:8766" onChange={e => setForm({...form, url: e.target.value})}/></label>
      <label className="field">令牌<input required type="password" autoComplete="off" value={form.token} onChange={e => setForm({...form, token: e.target.value})}/></label>
      <label className="field">本机名称<input required maxLength={40} value={form.host} onChange={e => setForm({...form, host: e.target.value})}/></label>
      <p className="quiet-note">消息会作为上下文进入对方会话，请只连接你信任的协作室。令牌保存在本机数据目录，不进入备份。</p>
      {error && <p className="tool-error" role="alert">{error}</p>}
      <footer><button type="button" className="outline-button" disabled={busy} onClick={() => void connect(undefined, true)} title="读取 room join 写入的 ~/.config/switchboard/room.json">使用本机 room 配置</button><button className="primary-button" disabled={busy}>连接</button></footer>
    </form>
  </Dialog>;

  const live = view.sessions.filter(s => s.state !== 'exited');
  const hosts = [...new Set(live.map(s => s.host))];
  const replying = view.messages.find(m => m.id === draft.replyTo);
  return <Dialog title="协作室" onClose={onClose}>
    <div className="room-dialog">
      <header className="room-identity"><span>{view.me.replace(/^human:/, '')} · {view.url}</span><button type="button" className="text-button" onClick={() => void disconnect()}>断开</button></header>
      <section aria-label="会话">
        <div className="section-label">会话（{live.length}）</div>
        {!live.length && <p className="quiet-note">协作室里暂时没有在线会话。</p>}
        {hosts.map(host => <div key={host} className="room-host"><h3>{host}</h3>{live.filter(s => s.host === host).map(session =>
          <div key={session.id} className={`room-session ${draft.to === roomAddress(session) ? 'selected' : ''}`}>
            <button type="button" title={`发给 ${roomAddress(session)}`} onClick={() => setDraft(d => ({...d, to: roomAddress(session), replyTo: null}))}>
              <i className={`room-state ${session.state}`} aria-label={session.state === 'live' ? '在线' : '静默'}/>
              <strong>{session.name || session.id.slice(0, 8)}</strong><small>{session.repo || '—'}</small>
              {session.status && <small className="room-status">{session.status}</small>}
              {session.listening && <small className="room-badge">待命</small>}{!!session.unread && <small className="room-badge">✉{session.unread}</small>}
            </button>
            {session.draftwaySession && <button type="button" className="text-button" onClick={() => onOpenSession(session.draftwaySession!)}>打开会话</button>}
          </div>)}</div>)}
      </section>
      <section aria-label="消息">
        <div className="section-label">消息</div>
        {!view.messages.length ? <p className="quiet-note">还没有消息。</p> : <ol className="room-thread" ref={thread}>{view.messages.map(message =>
          <li key={message.id} className={message.mine ? 'mine' : message.toMe ? 'to-me' : undefined}>
            <div><strong>{message.mine ? '我' : message.from}</strong><span>→ {message.link ? `#${message.link}` : message.to}</span>{kindLabel[message.kind] && <em>{kindLabel[message.kind]}</em>}<time>{time(message.at)}</time>
              {!message.mine && <button type="button" className="icon-button" aria-label={`回复 #${message.id}`} title="回复" onClick={() => setDraft(d => ({...d, to: message.from, replyTo: message.id}))}><CornerUpLeft size={13}/></button>}</div>
            <p>{message.body}</p>
          </li>)}</ol>}
      </section>
      <form className="room-composer" onSubmit={event => void send(event)}>
        <label className="field">收件人<input required list="room-recipients" value={draft.to} placeholder="name@host、repo:名称、link:名称" onChange={e => setDraft({...draft, to: e.target.value, replyTo: null})}/></label>
        <datalist id="room-recipients">{live.map(s => <option key={s.id} value={roomAddress(s)}/>)}{[...new Set(live.map(s => s.repo).filter(Boolean))].map(repo => <option key={repo} value={`repo:${repo}`}/>)}{view.links.map(link => <option key={link} value={`link:${link}`}/>)}</datalist>
        {replying && <p className="quiet-note">回复 #{replying.id}：{replying.body.slice(0, 60)}<button type="button" className="text-button" onClick={() => setDraft({...draft, replyTo: null})}>取消</button></p>}
        <textarea required aria-label="消息内容" maxLength={4000} rows={3} value={draft.body} onChange={e => setDraft({...draft, body: e.target.value})}
          onKeyDown={e => {if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();}}/>
        {error && <p className="tool-error" role="alert">{error}</p>}
        <footer>{!draft.replyTo && <label><input type="checkbox" checked={draft.ask} onChange={e => setDraft({...draft, ask: e.target.checked})}/> 提问（对方会在本轮内回答）</label>}
          <button className="primary-button" disabled={busy}><Send size={14}/>发送</button></footer>
      </form>
    </div>
  </Dialog>;
}
