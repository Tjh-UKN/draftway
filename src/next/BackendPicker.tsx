import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronRight, Link, Plus, Terminal} from 'lucide-react';
import type {AgentSession} from './core';
import {agentNames} from './integrations';
import {useAgentRuntime} from './NativeAgents';

export function BackendPicker({label, text, onChoose, onOpen, onLink}: {label: string; text?: string; onChoose: (agent: AgentSession['agentId']) => void; onOpen: () => void; onLink?: () => void}) {
  const agents = useAgentRuntime();
  const [position, setPosition] = useState<{left: number; top: number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: Event) => {if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null);};
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', dismiss); document.addEventListener('focusin', dismiss); window.addEventListener('resize', close);
    return () => {document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); window.removeEventListener('resize', close);};
  }, [position]);
  return <><button ref={trigger} className={text ? 'primary-button node-session-create' : 'icon-button'} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!position} onClick={() => {
    if (position) {setPosition(null); return;}
    onOpen(); const rect = trigger.current!.getBoundingClientRect(); const height = onLink ? 220 : 176;
    setPosition({left: Math.max(8, Math.min(innerWidth - 204, rect.left)), top: rect.bottom + height < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height)});
  }}><Plus size={16}/>{text && <span>{text}</span>}</button>{position && createPortal(<div className="backend-menu" ref={menu} role="menu" aria-label="选择会话后端" style={{position: 'fixed', left: position.left, top: position.top, zIndex: 1000}} onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus(); return;}
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus();
  }}>{Object.entries(agentNames).map(([id, name]) => <button key={id} role="menuitem" disabled={!!agents && !agents.backends.some(backend => backend.id === id && backend.available)} onClick={() => {setPosition(null); onChoose(id as AgentSession['agentId']);}}><Terminal size={16}/><span>{name}</span><ChevronRight size={13}/></button>)}{onLink && <button role="menuitem" onClick={() => {setPosition(null); onLink();}}><Link size={15}/><span>关联已有会话</span></button>}<span className="backend-menu-note">{agents ? '使用本机执行器' : '浏览器模拟模式'}</span></div>, document.body)}</>;
}
