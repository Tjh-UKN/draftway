import {useState} from 'react';
import {BookOpen, Check, Copy, ExternalLink, FileText, Globe, Plus, X} from 'lucide-react';
import type {MindNode} from './model';
import {parseMaterialTarget, type NodeMaterial} from './material-target';

export function NodeMaterials({node, onChange}: {node: MindNode; onChange: (node: MindNode) => void}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const materials: NodeMaterial[] = [...(node.materials || [])];
  if (node.reference && !materials.some(m => m.target === node.reference)) materials.unshift({id: 'legacy-reference', title: '', target: node.reference});
  function add() {
    try {
      const parsed = parseMaterialTarget(input);
      if (materials.some(m => {try {return parseMaterialTarget(m.target).target === parsed.target;} catch {return m.target === parsed.target;}})) throw new Error('这份材料已经关联。');
      onChange({...node, materials: [...(node.materials || []), {id: crypto.randomUUID(), title: parsed.title.slice(0, 240), target: parsed.target}]});
      setInput(''); setError(''); setAdding(false);
    } catch (e) {setError(e instanceof Error ? e.message : '无法添加这份材料。');}
  }
  return <section className="node-detail-section node-materials"><div className="detail-section-heading"><h3>关联材料（{materials.length}）</h3><button className="icon-button" aria-label="关联材料" title="关联材料" disabled={materials.length >= 100} onClick={() => {setAdding(value => !value); setError('');}}><Plus size={16}/></button></div>
    {materials.map(material => {
      let parsed; try {parsed = parseMaterialTarget(material.target);} catch {parsed = {kind: 'file' as const, target: material.target, title: material.target, detail: material.target, href: undefined};}
      const title = material.title || parsed.title;
      const Icon = parsed.kind === 'obsidian' ? BookOpen : parsed.kind === 'web' ? Globe : FileText;
      const content = <><Icon size={16}/><span><strong>{title}</strong><small>{parsed.detail}</small></span>{parsed.href && <ExternalLink size={12}/>}</>;
      return <div className="material-row" key={material.id}>
        {parsed.href ? <a className="material-link" href={parsed.href} target={parsed.kind === 'web' ? '_blank' : undefined} rel="noopener noreferrer" title={material.target}>{content}</a> : <span className="material-link" title={material.target}>{content}</span>}
        {parsed.kind === 'file' && <button className="icon-button" aria-label={`复制${title}路径`} title="复制文件路径" onClick={async () => {try {await navigator.clipboard.writeText(material.target); setCopied(material.id); setError('');} catch {setError('复制失败，请从材料文字中复制路径。');}}}>{copied === material.id ? <Check size={13}/> : <Copy size={13}/>}</button>}
        <button className="icon-button material-remove" aria-label={`解除关联${title}`} title="解除关联" onClick={() => onChange(material.id === 'legacy-reference' ? {...node, reference: ''} : {...node, materials: (node.materials || []).filter(m => m.id !== material.id)})}><X size={13}/></button>
      </div>;
    })}
    {!materials.length && !adding && <p className="quiet-note">笔记、网页或文件</p>}
    {adding && <form className="material-add" onSubmit={event => {event.preventDefault(); add();}}><input autoFocus aria-label="材料链接或路径" placeholder="粘贴 Obsidian 链接、网页或文件路径" maxLength={4096} value={input} onChange={event => {setInput(event.target.value); setError('');}} onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setAdding(false); setError('');}}}/><button className="icon-button" aria-label="保存关联材料" title="关联材料" disabled={!input.trim()}><Check size={15}/></button><p className="quiet-note">Obsidian：在笔记中复制链接后粘贴。</p></form>}
    {error && <p className="material-error" role="alert">{error}</p>}
  </section>;
}
