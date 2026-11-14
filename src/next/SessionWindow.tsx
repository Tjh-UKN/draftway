import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject} from 'react';
import {Grip, Maximize2, Minimize2, Minus, X} from 'lucide-react';
import {fitWidgetWindow, type WidgetWindowRect} from '../workspace-layout';
import type {Workspace} from './core';

export function SessionWindow({title, boundary, window, onChange, onClose, children}: {
  title: string; boundary: RefObject<HTMLDivElement | null>; window: Workspace['sessionWindow'];
  onChange: (value: Workspace['sessionWindow']) => void; onClose: () => void; children: ReactNode;
}) {
  const [viewport, setViewport] = useState({width: 1000, height: 700});
  const [rect, setRect] = useState(window.rect);
  const latest = useRef(rect);
  const gesture = useRef<{mode: 'move' | 'resize'; x: number; y: number; origin: WidgetWindowRect} | null>(null);
  const minimum = {width: 430, height: 340};
  const shown = fitWidgetWindow(window.maximized ? {x: 16, y: 48, width: viewport.width, height: viewport.height} : rect, viewport, minimum);
  useEffect(() => {
    const element = boundary.current;
    if (!element) return;
    const update = () => setViewport({width: element.clientWidth, height: element.clientHeight});
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [boundary]);
  function update(value: WidgetWindowRect, save = false) {
    const fitted = fitWidgetWindow(value, viewport, minimum);
    latest.current = fitted; setRect(fitted);
    if (save) onChange({...window, rect: fitted});
  }
  function keyboard(event: KeyboardEvent, mode: 'move' | 'resize') {
    const dx = event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0;
    const dy = event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0;
    if ((!dx && !dy) || window.maximized) return;
    event.preventDefault(); event.stopPropagation();
    update(mode === 'move' ? {...shown, x: shown.x + dx, y: shown.y + dy} : {...shown, width: shown.width + dx, height: shown.height + dy}, true);
  }
  return <section className="floating-session" role="dialog" aria-modal="false" aria-label={`会话窗口：${title}`} style={{left: shown.x, top: shown.y, width: shown.width, height: shown.height}}
    onPointerDownCapture={event => {
      const target = event.target as HTMLElement;
      const mode = target.closest('[data-session-resize]') ? 'resize' : target.closest('[data-session-move]') || (target.closest('.floating-titlebar') && !target.closest('button')) ? 'move' : null;
      if (!mode || window.maximized || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {mode, x: event.clientX, y: event.clientY, origin: shown};
    }}
    onPointerMove={event => {
      const active = gesture.current; if (!active) return;
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      update(active.mode === 'move' ? {...active.origin, x: active.origin.x + dx, y: active.origin.y + dy} : {...active.origin, width: active.origin.width + dx, height: active.origin.height + dy});
    }}
    onPointerUp={() => {if (gesture.current) {gesture.current = null; onChange({...window, rect: latest.current});}}}
    onPointerCancel={() => {if (gesture.current) {update(gesture.current.origin); gesture.current = null;}}}>
    <header className="floating-titlebar"><button className="icon-button" data-session-move aria-label="移动会话窗口" title="拖动标题栏，或用方向键移动" onKeyDown={event => keyboard(event, 'move')}><Grip size={14}/></button><strong>{title}</strong><button className="icon-button" aria-label="收起会话窗口" onClick={onClose}><Minus size={15}/></button><button className="icon-button" aria-label={window.maximized ? '还原会话窗口' : '最大化会话窗口'} onClick={() => onChange({...window, maximized: !window.maximized})}>{window.maximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button><button className="icon-button" aria-label="关闭会话窗口" onClick={onClose}><X size={16}/></button></header>
    <div className="floating-session-body">{children}</div>
    {!window.maximized && <button data-session-resize className="floating-resize" aria-label="调整会话窗口大小" title="拖动或使用方向键调整大小" onKeyDown={event => keyboard(event, 'resize')}><span/></button>}
  </section>;
}
