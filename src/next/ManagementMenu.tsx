import {useEffect, useLayoutEffect, useRef} from 'react';
import type {LucideIcon} from 'lucide-react';
import './management-menu.css';

export interface ManagementAction {label: string; icon?: LucideIcon; separatorBefore?: boolean; shortcut?: string; disabled?: boolean; danger?: boolean; run: () => void}
export function ManagementMenu({x, y, keyboard, actions, onClose}: {x: number; y: number; keyboard?: boolean; actions: ManagementAction[]; onClose: () => void}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const menu = ref.current!;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    if (keyboard) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); else menu.focus();
  }, [x, y, keyboard]);
  useEffect(() => {
    const menu = ref.current!;
    const pointer = (event: PointerEvent) => {if (!ref.current?.contains(event.target as Node)) close.current();};
    const dismiss = () => close.current();
    document.addEventListener('pointerdown', pointer, true);
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    return () => {document.removeEventListener('pointerdown', pointer, true); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); if (menu.contains(document.activeElement) || document.activeElement === document.body) previousFocus.current?.focus();};
  }, []);
  return <div ref={ref} role="menu" tabIndex={-1} aria-label="管理菜单" className="management-context-menu" style={{left: x, top: y}} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const shortcut = actions.find(action => !action.disabled && action.shortcut === event.key);
    if (shortcut) {event.preventDefault(); event.stopPropagation(); onClose(); shortcut.run(); return;}
    if (event.key === 'Escape' || event.key === 'Tab') {event.preventDefault(); event.stopPropagation(); onClose(); return;}
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' || (index < 0 && event.key === 'ArrowUp') ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>{actions.map(action => <div key={action.label} role="none">{action.separatorBefore && <div role="separator" className="management-menu-separator"/>}<button role="menuitem" aria-label={action.label} aria-keyshortcuts={action.shortcut} className={action.danger ? 'danger-text' : ''} disabled={action.disabled} onPointerMove={event => {if (!action.disabled) event.currentTarget.focus();}} onPointerLeave={() => ref.current?.focus()} onClick={() => {onClose(); action.run();}}>{action.icon && <action.icon size={15} strokeWidth={1.5}/>}<span>{action.label}</span>{action.shortcut && <span className="management-menu-shortcut">{action.shortcut}</span>}</button></div>)}</div>;
}
