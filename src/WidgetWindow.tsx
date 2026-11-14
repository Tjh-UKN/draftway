import {useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import {Grip, Maximize2, Minimize2, Minus} from 'lucide-react';
import {Modal} from './components';
import {fitWidgetWindow, type WidgetWindowRect} from './workspace-layout';

export default function WidgetWindow({title, initial, preferred, minimum, onChange, onClose, toolbar, children}: {
  title: string; initial?: WidgetWindowRect; preferred: {width: number; height: number}; minimum: {width: number; height: number};
  onChange: (rect: WidgetWindowRect) => void; onClose: () => void; toolbar: ReactNode; children: ReactNode;
}) {
  const [viewport, setViewport] = useState(() => ({width: innerWidth, height: innerHeight}));
  const [rect, setRect] = useState(() => fitWidgetWindow(initial || {...preferred, x: (innerWidth - preferred.width)/2, y: (innerHeight - preferred.height)/2}, viewport, minimum));
  const latest = useRef(rect);
  const [maximized, setMaximized] = useState(false);
  const gesture = useRef<{mode: 'move'|'resize'; x: number; y: number; original: WidgetWindowRect}|null>(null);
  const shown = maximized ? fitWidgetWindow({x:16,y:48,width:viewport.width,height:viewport.height}, viewport, minimum) : fitWidgetWindow(rect, viewport, minimum);

  useEffect(() => {
    const resize = () => setViewport({width: innerWidth, height: innerHeight});
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function update(next: WidgetWindowRect, save = false) {
    const fitted = fitWidgetWindow(next, viewport, minimum);
    latest.current = fitted; setRect(fitted);
    if (save) onChange(fitted);
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const mode = target.closest('[data-widget-resize]') ? 'resize' : target.closest('[data-widget-move]') || (target.closest('.modal-heading') && !target.closest('button')) ? 'move' : null;
    if (!mode || maximized || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {mode, x: event.clientX, y: event.clientY, original: shown};
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    const x = event.clientX - current.x, y = event.clientY - current.y;
    update(current.mode === 'move' ? {...current.original, x: current.original.x + x, y: current.original.y + y}
      : {...current.original, width: current.original.width + x, height: current.original.height + y});
  }

  function finish(cancel = false) {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (cancel) update(current.original); else onChange(latest.current);
  }

  function keyboard(event: KeyboardEvent, mode: 'move'|'resize') {
    const dx = event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0;
    const dy = event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0;
    if ((!dx && !dy) || maximized) return;
    event.preventDefault();
    update(mode === 'move' ? {...shown, x:shown.x+dx, y:shown.y+dy} : {...shown, width:shown.width+dx, height:shown.height+dy}, true);
  }

  return <div className={`widget-window-layer ${maximized ? 'widget-window-maximized' : ''}`}
    style={{'--widget-x':`${shown.x}px`,'--widget-y':`${shown.y}px`,'--widget-width':`${shown.width}px`,'--widget-height':`${shown.height}px`} as CSSProperties}
    onPointerDownCapture={start} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)}>
    <Modal title={title} onClose={onClose} wide>
      <div className="widget-window-toolbar"><button className="icon-button" data-widget-move aria-label="移动组件窗口" title="拖动窗口；也可使用方向键移动" disabled={maximized} onKeyDown={event => keyboard(event, 'move')}><Grip size={15}/></button>
        <span>独立组件</span><div className="widget-window-actions">{toolbar}
          <button className="icon-button" aria-label={maximized ? '还原组件窗口' : '最大化组件窗口'} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>
          <button className="icon-button" aria-label="收起组件窗口" title="收起，保留组件与记录" onClick={onClose}><Minus size={16}/></button>
        </div></div>
      {children}
      {!maximized && <button className="widget-window-resize" data-widget-resize aria-label="调整组件窗口大小" title="拖动调整大小；也可使用方向键" onKeyDown={event => keyboard(event, 'resize')}><span/></button>}
    </Modal>
  </div>;
}
