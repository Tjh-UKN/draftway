import {useEffect, useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {Copy, Minus, Square, X} from 'lucide-react';

export function DesktopWindowControls() {
  const [visible, setVisible] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let active = true;
    const sync = () => {
      void window.isMaximized().then(value => {if (active) setMaximized(value);}).catch(console.error);
    };
    void window.isDecorated().then(decorated => {if (active) setVisible(!decorated);}).catch(console.error);
    sync();
    const listener = window.onResized(sync);
    void listener.catch(console.error);
    return () => {
      active = false;
      void listener.then(unlisten => unlisten(), () => {});
    };
  }, []);

  if (!visible) return null;
  const window = getCurrentWindow();
  const maximizeLabel = maximized ? '还原窗口' : '最大化窗口';
  return <div className="desktop-window-controls" role="group" aria-label="窗口控制">
    <button type="button" aria-label="最小化窗口" title="最小化窗口" onClick={() => void window.minimize().catch(console.error)}><Minus size={15}/></button>
    <button type="button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => void window.toggleMaximize().catch(console.error)}>
      {maximized ? <Copy size={13}/> : <Square size={13}/>}
    </button>
    <button type="button" className="desktop-window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void window.close().catch(console.error)}><X size={16}/></button>
  </div>;
}
