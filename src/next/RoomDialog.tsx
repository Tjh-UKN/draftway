import {useEffect, useMemo, useRef, useState, type FormEvent, type RefObject} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Dialog} from './ui';
import {conversationMap, sessionLabel, type RoomView} from './room-map';
import './room-dialog.css';

// A switchboard room (pip package `switchboard-room`) is for Claude Code sessions on several machines to message each
// other. Draftway only watches it: who is there, what they are doing and who has talked to whom.

const kindLabel: Record<string, string> = {ask: '提问', reply: '回复', auto: '自动'};
const time = (at: number) => new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
const stateLabel: Record<string, string> = {live: '在线', quiet: '静默', exited: '已退出'};
// The same short ages `room who` prints.
export function ago(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}

export function RoomDialog({onOpenSession, onClose}: {onOpenSession: (id: string) => void; onClose: () => void}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({url: '', token: ''});
  const [focus, setFocus] = useState<string | null>(null);
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

  return <Dialog title="协作室" onClose={onClose}><RoomBody view={view} focus={focus} setFocus={setFocus} thread={thread} onOpenSession={onOpenSession} onDisconnect={() => void disconnect()}/></Dialog>;
}

function RoomBody({view, focus, setFocus, thread, onOpenSession, onDisconnect}: {view: RoomView; focus: string | null; setFocus: (id: string | null) => void; thread: RefObject<HTMLOListElement | null>; onOpenSession: (id: string) => void; onDisconnect: () => void}) {
  const map = useMemo(() => conversationMap(view), [view]);
  const at = Object.fromEntries(map.nodes.map(node => [node.id, node]));
  const most = Math.max(1, ...map.edges.map(edge => edge.count));
  const touches = (a: string, b: string | null) => !focus || a === focus || b === focus;
  const messages = view.messages.filter(message => touches(message.sender, message.target));
  const focused = focus && map.nodes.find(node => node.id === focus);
  const live = view.sessions.filter(s => s.state === 'live').length;
  return <div className="room-dialog">
    <header className="room-identity"><span>{view.url}</span><button type="button" className="text-button" onClick={onDisconnect}>断开</button></header>
    <section aria-label="会话">
      <div className="section-label">会话（在线 {live} / 共 {view.sessions.length}）</div>
      {!view.sessions.length ? <p className="quiet-note">协作室里暂时没有会话。</p> : <table className="room-who"><tbody>{view.sessions.map(session =>
        <tr key={session.id} className={`${session.state}${focus === session.id ? ' focused' : ''}`} onClick={() => setFocus(focus === session.id ? null : session.id)}>
          <td><i className={`room-state ${session.state}`}/><strong title={session.title ? sessionLabel(session) : undefined}>{session.title || sessionLabel(session)}</strong></td>
          <td className="mono">{session.id.slice(0, 8)}</td><td>{session.repo || '-'}</td><td className="mono">{session.version || '?'}</td>
          <td>{stateLabel[session.state] ?? session.state}</td><td className="mono" title={new Date(session.lastSeen).toLocaleString()}>{ago(session.lastSeen)}</td>
          <td className="room-extra">
            {!!session.unread && <small className="room-badge">✉{session.unread}</small>}
            {session.polling.map(what => <small key={what} className="room-badge">{what === 'listen' ? '待命' : what}</small>)}
            {session.links.map(link => <small key={link} className="room-link">[{link}]</small>)}
            {session.status && <small className="room-status" title={session.status}>{session.status}</small>}
            {session.draftwaySession && <button type="button" className="text-button" onClick={event => {event.stopPropagation(); onOpenSession(session.draftwaySession!);}}>打开会话</button>}
          </td>
        </tr>)}</tbody></table>}
    </section>
    <section aria-label="对话关系">
      <div className="section-label">对话关系（最近 {view.messages.length} 条消息）{focused && <button type="button" className="text-button" onClick={() => setFocus(null)}>显示全部</button>}</div>
      {!map.edges.length ? <p className="quiet-note">最近的消息里还没有会话之间的对话。</p> :
        <svg className="room-map" viewBox="0 0 640 340" role="img" aria-label="会话之间的对话关系">
          {map.edges.map(edge => {const [a, b] = [at[edge.a], at[edge.b]]; const lit = touches(edge.a, edge.b);
            return <line key={`${edge.a}-${edge.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={lit ? 'lit' : 'dim'} strokeWidth={1 + 4 * Math.log2(1 + edge.count) / Math.log2(1 + most)}>
              <title>{`${a.label} ↔ ${b.label}：${edge.count} 条，最近 ${ago(edge.last)} 前`}</title></line>;})}
          {map.nodes.map(node => {const lit = !focus || node.id === focus || map.edges.some(e => (e.a === focus && e.b === node.id) || (e.b === focus && e.a === node.id));
            const dx = node.anchor === 'start' ? 10 : node.anchor === 'end' ? -10 : 0; const dy = node.anchor === 'middle' ? (node.y < 170 ? -12 : 20) : 4;
            return <g key={node.id} className={`room-node ${node.group ? 'group' : node.state}${lit ? '' : ' dim'}${focus === node.id ? ' focused' : ''}`} onClick={() => setFocus(focus === node.id ? null : node.id)}>
              {node.group ? <rect x={node.x - 6} y={node.y - 6} width={12} height={12} rx={3}/> : <circle cx={node.x} cy={node.y} r={6}/>}
              <text x={node.x + dx} y={node.y + dy} textAnchor={node.anchor}>{node.label.length > 26 ? node.label.slice(0, 25) + '…' : node.label}</text>
              <title>{node.label}</title>
            </g>;})}
        </svg>}
    </section>
    <section aria-label="消息">
      <div className="section-label">消息{focused ? `：${focused.label}` : ''}</div>
      {!messages.length ? <p className="quiet-note">还没有消息。</p> : <ol className="room-thread" ref={thread}>{messages.map(message =>
        <li key={message.id}>
          <div><strong>{message.from}</strong><span>→ {message.link ? `#${message.link}` : message.to}</span>{kindLabel[message.kind] && <em>{kindLabel[message.kind]}{message.replyTo ? ` #${message.replyTo}` : ''}</em>}<time>#{message.id} · {time(message.at)}</time></div>
          <p>{message.body}</p>
        </li>)}</ol>}
    </section>
  </div>;
}
