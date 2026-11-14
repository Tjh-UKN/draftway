import {useEffect, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {ExternalLink, RotateCw} from 'lucide-react';
import MarkdownView from '../MarkdownView';
import type {DockTab} from './docking';
export function MaterialView({workspaceId, tab}: {workspaceId: string; tab: Extract<DockTab, {kind: 'material'}>}) {
  const [file, setFile] = useState<{name: string; path: string; text: string} | null>(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const args = {workspaceId, nodeId: tab.nodeId, materialId: tab.materialId};
  useEffect(() => {let alive = true; setFile(null); setError(''); if (!isTauri()) {setError('本机材料请在 Windows 版中打开。'); return;}
    const timer = setTimeout(() => {void invoke<{name: string; path: string; text: string}>('read_material', args).then(value => {if (alive) setFile(value);}).catch(e => {if (alive) setError(String(e));});}, 250);return () => {alive=false;clearTimeout(timer);};
  }, [workspaceId, tab.nodeId, tab.materialId, reload]);
  return <div className="report-view"><header className="report-toolbar"><span>{file?.name || tab.title} · 只读</span><button className="text-button" onClick={() => setReload(n => n + 1)}><RotateCw size={14}/>重新读取</button><button className="text-button" disabled={!isTauri()} onClick={() => {void invoke('open_material', args).catch(e => setError(String(e)));}}><ExternalLink size={14}/>用原应用打开</button></header><article className="report-document">{error ? <p className="tool-error" role="alert">{error}</p> : !file ? <p className="quiet-note">正在读取材料…</p> : <><p className="quiet-note">{file.path}</p>{/\.md$/i.test(file.name) ? <MarkdownView value={file.text} onOpenLink={url => {void invoke('open_external_url', {url}).catch(e => setError(String(e)));}}/> : <pre className="material-text">{file.text}</pre>}</>}</article></div>;
}
