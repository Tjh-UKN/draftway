import {useEffect, useRef} from 'react';
import {MessageSquare, Network, Terminal, X} from 'lucide-react';
import {latestRun, statusNames, type WorkbenchState, type Workspace} from './core';
import {agentNames} from './integrations';

export function SessionTabs({state, space, onSelect, onClose, onReorder}: {
  state: WorkbenchState; space: Workspace; onSelect: (id: string) => void;
  onClose: (id: string) => void; onReorder: (id: string, beforeId?: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});}, [space.sessionTabs.activeId, space.sessionTabs.ids.length]);
  return <div className="workspace-tab-strip" ref={strip} role="tablist" aria-label="工作区页签" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus(); tabs[next].click();
  }} onDragOver={event => {if (event.dataTransfer.types.includes('application/x-northstar-session')) event.preventDefault();}} onDrop={event => {event.preventDefault(); onReorder(event.dataTransfer.getData('application/x-northstar-session'));}}>
    <button className="workspace-map-tab" role="tab" id={`workspace-tab-${space.id}`} aria-selected={space.sessionTabs.activeId === 'workspace'} aria-controls={`map-panel-${space.id}`} tabIndex={space.sessionTabs.activeId === 'workspace' ? 0 : -1} onClick={() => onSelect('workspace')}><Network size={16}/><span>工作区</span></button>
    {space.sessionTabs.ids.map(id => {
      const session = state.sessions.find(s => s.id === id)!;
      const provider = agentNames[session.agentId || 'codex'];
      const status = latestRun(state, id)?.state || 'idle';
      const active = space.sessionTabs.activeId === id;
      return <div key={id} className={`workspace-session-tab ${active ? 'active' : ''}`} draggable onDragStart={event => {event.dataTransfer.setData('application/x-northstar-session', id); event.dataTransfer.effectAllowed = 'move';}} onDragOver={event => {if (event.dataTransfer.types.includes('application/x-northstar-session')) event.preventDefault();}} onDrop={event => {event.preventDefault(); event.stopPropagation(); onReorder(event.dataTransfer.getData('application/x-northstar-session'), id);}}>
        <button role="tab" id={`session-tab-${id}`} aria-selected={active} aria-controls={`session-panel-${id}`} aria-label={`${provider}：${session.title}`} tabIndex={active ? 0 : -1} title={`${provider} · ${session.title} · ${statusNames[status]}`} onClick={() => onSelect(id)} onAuxClick={event => {if (event.button === 1) {event.preventDefault(); onClose(id);}}}>
          {session.agentId === 'codex' ? <Terminal size={14}/> : <MessageSquare size={14}/>}<span className="session-tab-label"><small>{provider}</small><span>{session.title}</span></span><i className={`tab-run-indicator run-${status} ${session.unread ? 'has-unread' : ''}`} aria-label={session.unread ? '未读结果' : statusNames[status]}/>
        </button><button className="session-tab-close" aria-label={`关闭${provider}：${session.title}页签`} title="关闭页签，保留会话记录" onClick={() => onClose(id)}><X size={12}/></button>
      </div>;
    })}
  </div>;
}
