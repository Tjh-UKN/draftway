import {useEffect, useRef, type ReactNode} from 'react';
import {BookOpen, Code2, X} from 'lucide-react';
import type {Space} from './model';

export function Star({size = 22}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2 19.5 12.5 30 16 19.5 19.5 16 30 12.5 19.5 2 16 12.5 12.5Z" fill="currentColor"/></svg>;
}
export function SpaceSymbol({space, size = 17}: {space: Pick<Space, 'symbol'>; size?: number}) {
  return space.symbol === 'star' ? <Star size={size}/> : space.symbol === 'code' ? <Code2 size={size}/> : <BookOpen size={size}/>;
}
export function Dialog({title, children, onClose}: {title: string; children: ReactNode; onClose: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {const element = ref.current!; element.showModal(); element.querySelector<HTMLElement>('input, textarea, select')?.focus(); return () => element.close();}, []);
  return <dialog ref={ref} className="shell-dialog" aria-label={title} onCancel={onClose} onClick={event => {if (event.target === event.currentTarget) onClose();}}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={17}/></button></header>{children}</dialog>;
}
export function Empty({title, children}: {title: string; children?: ReactNode}) {
  return <div className="empty-state"><Star size={26}/><h2>{title}</h2>{children}</div>;
}
