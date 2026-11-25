import {useEffect, useMemo, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {BookOpen, Check, Copy, ExternalLink, FileText, Globe, Plus, X} from 'lucide-react';
import type {AgentSession} from './core';
import type {MindNode} from './model';
import {materialTargetKey, nodeMaterialLimit, parseMaterialTarget, type NodeMaterial} from './material-target';
import {addNodeOutput, nodeSessionMaterials, type SessionMaterial} from './session-materials';
import {boundedText} from './text';
import './node-materials.css';

type Material = NodeMaterial | SessionMaterial;
type MaterialUpdate = (materials: NodeMaterial[]) => NodeMaterial[];
const fileKey = (sessionId: string, target: string) => JSON.stringify([sessionId, target]);
const availableFiles = (id: string, paths: string[]) => invoke<string[]>('available_session_materials', {id, paths});

export function NodeMaterials({node, workspaceId, cwd, sessions, readOnly, onChange, onOpen}: {
  node: MindNode;
  workspaceId: string;
  cwd?: string;
  sessions: AgentSession[];
  readOnly: boolean;
  onChange: (update: MaterialUpdate) => void;
  onOpen: (material: Material) => void | Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [available, setAvailable] = useState<Set<string>>(() => new Set());
  const stored = node.materials ?? [];
  const storedKeys = new Set(stored.map(item => materialTargetKey(item.target)));
  const automatic = useMemo(() => nodeSessionMaterials(sessions, workspaceId, node.id, cwd), [sessions, workspaceId, node.id, cwd]);
  const candidates = JSON.stringify(automatic.filter(item => item.kind === 'file' && !storedKeys.has(materialTargetKey(item.target)))
    .map(item => [item.sessionId, item.target]));
  useEffect(() => {
    if (!isTauri()) return;
    const pathsBySession = new Map<string, string[]>();
    for (const [id, path] of JSON.parse(candidates) as [string, string][]) {
      const paths = pathsBySession.get(id);
      if (paths) paths.push(path);
      else pathsBySession.set(id, [path]);
    }
    let active = true;
    void Promise.all([...pathsBySession].map(async ([id, paths]) => {
      const confirmed = await availableFiles(id, paths).catch(() => []);
      return confirmed.map(path => fileKey(id, path));
    })).then(results => {if (active) setAvailable(new Set(results.flat()));});
    return () => {active = false;};
  }, [candidates]);
  const materials: Material[] = [...stored, ...automatic.filter(item => !storedKeys.has(materialTargetKey(item.target)) &&
    (item.kind !== 'file' || available.has(fileKey(item.sessionId, item.target))))];
  const outputs = stored.filter(item => item.output);
  const full = stored.length >= nodeMaterialLimit;

  async function confirmFile(material: Material) {
    if (!('sessionId' in material) || material.kind !== 'file') return true;
    if ((await availableFiles(material.sessionId, [material.target])).includes(material.target)) return true;
    const key = fileKey(material.sessionId, material.target);
    setAvailable(previous => new Set([...previous].filter(item => item !== key)));
    setError('这份文件现在不可用，已从自动素材中移除。');
    return false;
  }

  function add() {
    try {
      const parsed = parseMaterialTarget(input);
      const key = materialTargetKey(parsed.target);
      if (materials.some(item => materialTargetKey(item.target) === key)) throw new Error('这份素材已经在列表里。');
      const material = {id: crypto.randomUUID(), title: boundedText(parsed.title, 240), target: parsed.target};
      onChange(current => current.length >= nodeMaterialLimit || current.some(item => materialTargetKey(item.target) === key)
        ? current : [...current, material]);
      setInput(''); setError(''); setAdding(false);
    } catch (cause) {setError(cause instanceof Error ? cause.message : '无法添加这份素材。');}
  }

  function row(material: Material, inOutputs: boolean) {
    const parsed = parseMaterialTarget(material.target);
    const saved = 'id' in material;
    const title = material.title || parsed.title;
    const Icon = parsed.kind === 'obsidian' ? BookOpen : parsed.kind === 'web' ? Globe : FileText;
    const source = 'sessionTitle' in material ? `会话：${material.sessionTitle}` : undefined;
    const content = <><Icon size={16}/><span><strong>{title}</strong><small>{parsed.detail}</small></span>{parsed.href && <ExternalLink size={12}/>}</>;
    return <div className="material-row" key={saved ? material.id : materialTargetKey(material.target)}>
      {parsed.kind === 'obsidian' && !saved
        ? <a className="material-link" href={parsed.href} title={source}>{content}</a>
        : <button className="material-link" type="button" title={source ? `${material.target}\n${source}` : material.target} onClick={async () => {
          try {setError(''); if (await confirmFile(material)) await onOpen(material);}
          catch (cause) {setError(cause instanceof Error ? cause.message : String(cause));}
        }}>{content}</button>}
      {parsed.kind === 'file' && <button type="button" className="icon-button" aria-label={`复制${title}路径`} title="复制文件路径" onClick={async () => {
        try {await navigator.clipboard.writeText(material.target); setCopied(material.target); setError('');}
        catch {setError('复制失败，请从素材文字中复制路径。');}
      }}>{copied === material.target ? <Check size={13}/> : <Copy size={13}/>}</button>}
      {inOutputs && saved
        ? <button type="button" className="icon-button" aria-label={`从产出区移除 ${title}`} title="从产出区移除" disabled={readOnly} onClick={() => {
          onChange(current => current.map(item => item.id === material.id ? {...item, output: false} : item));
        }}><X size={13}/></button>
        : saved && material.output ? <span className="material-output-state"><Check size={12}/>已加入产出</span>
          : <button type="button" className="text-button material-output-action" aria-label={`加入产出区 ${title}`} title="加入产出区" disabled={readOnly || (!saved && full)} onClick={async () => {
            try {
              setError('');
              if (!await confirmFile(material)) return;
              const id = crypto.randomUUID();
              onChange(current => addNodeOutput(current, material, id));
            } catch (cause) {setError(String(cause));}
          }}><Plus size={12}/>加入产出</button>}
      {saved && !inOutputs && !material.output && <button type="button" className="icon-button material-remove" aria-label={`移除素材 ${title}`} title="移除素材" disabled={readOnly}
        onClick={() => onChange(current => current.filter(item => item.id !== material.id || item.output))}><X size={13}/></button>}
    </div>;
  }

  return <>
    <section className="node-detail-section node-materials" aria-label="素材区">
      <div className="detail-section-heading"><h3>素材区{materials.length > 0 && <span className="detail-count">{materials.length}</span>}</h3><button type="button" className="icon-button" aria-label="添加素材" title="添加素材" disabled={readOnly || full}
        onClick={() => {setAdding(value => !value); setError('');}}><Plus size={16}/></button></div>
      {materials.length ? <div className="node-material-list">{materials.map(item => row(item, false))}</div> : !adding && <p className="quiet-note">关联会话的文件和链接会显示在这里。</p>}
      {adding && <form className="material-add" onSubmit={event => {event.preventDefault(); add();}}>
        <input autoFocus aria-label="素材链接或路径" placeholder="粘贴 Obsidian 链接、网页或文件路径" maxLength={4096} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setAdding(false); setError('');}
        }}/>
        <button className="icon-button" aria-label="保存素材" title="保存素材" disabled={readOnly || full || !input.trim()}><Check size={15}/></button>
      </form>}
      {error && <p className="material-error" role="alert">{error}</p>}
    </section>
    <section className="node-detail-section node-materials" aria-label="产出区">
      <div className="detail-section-heading"><h3>产出区{outputs.length > 0 && <span className="detail-count">{outputs.length}</span>}</h3></div>
      {outputs.length ? <div className="node-material-list">{outputs.map(item => row(item, true))}</div> : <p className="quiet-note">从素材区挑选要保留的成果</p>}
    </section>
  </>;
}
