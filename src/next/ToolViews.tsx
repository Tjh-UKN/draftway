import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, ExternalLink, FileCode2, Globe, RotateCw, Upload, X} from 'lucide-react';
import {diffLines} from 'diff';
import {browserUrl, type DockTab, type ReviewFile} from './docking';
import type {NativeBrowserHost} from './native-browser';
import {invoke, isTauri} from '@tauri-apps/api/core';

export function BrowserView({tab, active, onChange, native}: {tab: Extract<DockTab, {kind: 'browser'}>; active: boolean; onChange: (tab: DockTab) => void; native?: NativeBrowserHost | null}) {
  const [address, setAddress] = useState(tab.url);
  const [error, setError] = useState('');
  const [history, setHistory] = useState({urls: [tab.url], index: 0});
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const status = native?.statuses[tab.id];
  useEffect(() => {if (active && !tab.url) input.current?.focus();}, [active, tab.id]);
  useEffect(() => {if (document.activeElement !== input.current) setAddress(tab.url);}, [tab.url]);
  function visit(url: string, index?: number) {
    setAddress(url); setError('');
    setHistory(h => index === undefined ? {urls: [...h.urls.slice(0, h.index + 1), url], index: h.index + 1} : {...h, index});
    onChange({...tab, url, title: url ? new URL(url).host : '新标签页'});
  }
  return <div className="browser-view"><form className="browser-addressbar" onSubmit={event => {event.preventDefault(); const url = browserUrl(address); if (url === null) setError('请输入 HTTP 或 HTTPS 地址'); else if (url === tab.url) {if (native) native.action(tab.id, 'reload'); else setReload(n => n + 1);} else visit(url);}}>
    <button type="button" className="icon-button" aria-label="后退" disabled={native ? !status?.back : !history.index} onClick={() => native ? native.action(tab.id, 'back') : visit(history.urls[history.index - 1], history.index - 1)}><ArrowLeft size={15}/></button>
    <button type="button" className="icon-button" aria-label="前进" disabled={native ? !status?.forward : history.index === history.urls.length - 1} onClick={() => native ? native.action(tab.id, 'forward') : visit(history.urls[history.index + 1], history.index + 1)}><ArrowRight size={15}/></button>
    <button type="button" className="icon-button" aria-label="刷新网页" disabled={!tab.url} onClick={() => native ? native.action(tab.id, 'reload') : setReload(n => n + 1)}><RotateCw size={14} className={status?.loading ? 'spinning' : ''}/></button>
    <label><Globe size={13}/><input ref={input} data-browser-address={tab.id} aria-label="网页地址" placeholder="输入网址，按 Enter 打开" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()}/></label>
    {tab.url && <a className="icon-button" href={tab.url} target="_blank" rel="noreferrer" title="在浏览器打开" aria-label="在浏览器打开" onClick={event => {if (native) {event.preventDefault(); native.external(tab.url);}}}><ExternalLink size={14}/></a>}
  </form>{error && <p className="tool-error" role="alert">{error}</p>}
    {/* shortcut: iframe cannot host sites that refuse embedding; use a native WebView in the desktop host. */}
    {tab.url ? native ? <div className="native-browser-slot" data-native-browser-id={tab.id} aria-label={`原生网页：${tab.url}`}>{status?.error ? <div className="tool-empty" role="alert"><p>{status.error}</p></div> : !status?.ready && <div className="tool-empty"><p>正在打开网页…</p></div>}</div> : <iframe key={`${tab.url}-${reload}`} title={`网页：${tab.url}`} src={tab.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer"/> : <div className="tool-empty"><Globe size={26} strokeWidth={1.2}/><h2>打开网页</h2><p>输入网址，在分区内查看。</p></div>}
    {tab.url && <div className="browser-frame-note">{native ? '内置浏览器' : '网页预览'}{!native && <a href={tab.url} target="_blank" rel="noreferrer">页面拒绝嵌入？在浏览器打开 <ExternalLink size={10}/></a>}</div>}
  </div>;
}

export function reviewLines(files: ReviewFile[]) {
  if (files.length < 2) return null;
  return diffLines(files[0].text, files[1].text, {stripTrailingCr: true, timeout: 150});
}
export async function readReviewFile(file: File): Promise<ReviewFile> {
  if (file.size > 262144) throw new Error('当前预览支持 256 KB 以内的文本文件');
  const text = await file.text();
  if (text.includes('\0') || text.split('\n').length > 5000) throw new Error('请选择 5000 行以内的代码或文本文件');
  return {name: file.name, text};
}
export function ReviewView({tab, onChange, workspaceId}: {tab: Extract<DockTab, {kind: 'review'}>; onChange: (tab: DockTab) => void; workspaceId?: string}) {
  const [error, setError] = useState(''); const [reading, setReading] = useState(false);
  const [changed, setChanged] = useState<string[] | null>(null);
  async function gitFiles() {setReading(true);setError('');try {setChanged(await invoke<string[]>('git_changed_files',{workspaceId}));}catch(e){setError(String(e));}finally{setReading(false);}}
  async function gitDiff(file: string) {setReading(true);setError('');try {const files=await invoke<ReviewFile[]>('git_file_diff',{workspaceId,file});onChange({...tab,files,title:file});}catch(e){setError(String(e));}finally{setReading(false);}}
  const primary = useRef<HTMLInputElement>(null); const comparison = useRef<HTMLInputElement>(null);
  const diff = useMemo(() => reviewLines(tab.files), [tab.files]);
  const rows = useMemo(() => {
    let oldLine = 0; let newLine = 0;
    return diff?.flatMap(part => {
      const lines = part.value.split('\n'); if (lines.at(-1) === '') lines.pop();
      return lines.map(text => ({text: text.replace(/\r$/, ''), old: part.added ? null : ++oldLine, next: part.removed ? null : ++newLine, type: part.added ? 'added' : part.removed ? 'removed' : 'same'}));
    });
  }, [diff]);
  async function load(file: File | undefined, compare: boolean) {
    if (!file) return; setReading(true); setError('');
    try {const content = await readReviewFile(file); const files = compare ? [tab.files[0], content] : [content]; onChange({...tab, files, title: compare ? `${files[0].name} ↔ ${content.name}` : content.name});}
    catch (e) {setError(e instanceof Error ? e.message : '读取文件失败');}
    finally {setReading(false);}
  }
  return <div className="review-view"><input type="file" hidden ref={primary} aria-label="选择代码文件" onChange={event => {void load(event.target.files?.[0], false); event.target.value = '';}}/><input type="file" hidden ref={comparison} aria-label="选择对比文件" onChange={event => {void load(event.target.files?.[0], true); event.target.value = '';}}/>
    <header className="review-toolbar"><FileCode2 size={15}/><span>{tab.files[0]?.name || '文件审查'}</span>{tab.files[1] && <><small>↔ {tab.files[1].name}</small><button className="icon-button" aria-label="移除对比文件" onClick={() => onChange({...tab, files: tab.files.slice(0, 1), title: tab.files[0].name})}><X size={12}/></button></>}<div/>{isTauri() && workspaceId && <button className="text-button" disabled={reading} onClick={() => {void gitFiles();}}>Git 改动</button>}<button className="text-button" disabled={reading} onClick={() => primary.current?.click()}>{tab.files.length ? '更换文件' : '打开文件'}</button>{!!tab.files.length && <button className="text-button" disabled={reading} onClick={() => comparison.current?.click()}>＋ 对比文件</button>}</header>
    {error && <p className="tool-error" role="alert">{error}</p>}{changed && <div className="git-file-list"><header><strong>工作目录与 HEAD 比较</strong><button className="icon-button" aria-label="收起 Git 改动" onClick={() => setChanged(null)}><X size={13}/></button></header>{changed.map(file => <button className="text-button" key={file} disabled={reading} onClick={() => {void gitDiff(file);}}>{file}</button>)}{!changed.length && <p className="quiet-note">没有未提交的改动</p>}</div>}
    {!tab.files.length ? <div className="tool-empty"><FileCode2 size={27} strokeWidth={1.2}/><h2>查看代码，比较改动</h2><button className="outline-button" disabled={reading} onClick={() => primary.current?.click()}><Upload size={14}/>打开文件</button><p>只读查看，原文件保持原样。</p></div> : tab.files.length === 2 ? rows ? <div className="code-scroll" aria-label="代码差异"><div className="diff-summary"><span>+{rows.filter(r => r.type === 'added').length}</span><span>−{rows.filter(r => r.type === 'removed').length}</span>{!rows.some(r => r.type !== 'same') && <small>文件内容相同</small>}</div><pre className="code-lines diff-lines">{rows.map((row, i) => <div key={i} className={`code-line ${row.type}`}><span>{row.old}</span><span>{row.next}</span><i>{row.type === 'added' ? '+' : row.type === 'removed' ? '−' : ' '}</i><code>{row.text || ' '}</code></div>)}</pre></div> : <div className="tool-empty"><p>差异过多，计算已停止。可移除对比文件查看原文。</p></div> : <div className="code-scroll" aria-label="代码内容"><pre className="code-lines">{tab.files[0].text.split('\n').map((line, i) => <div key={i} className="code-line"><span>{i + 1}</span><code>{line || ' '}</code></div>)}</pre></div>}
    {!!tab.files.length && <footer className="review-status">只读 · 文件快照已保存在当前工作区</footer>}
  </div>;
}
