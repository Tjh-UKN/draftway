export interface NodeMaterial {id: string; title: string; target: string}
export interface MaterialTarget {kind: 'obsidian' | 'web' | 'file'; target: string; title: string; href?: string; detail: string}
const leaf = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
const invalid = () => new Error('请粘贴 Obsidian 笔记链接、网页地址或完整文件路径。');

export function parseMaterialTarget(input: string): MaterialTarget {
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  if (/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/(?!\/))/i.test(value)) return {kind: 'file', target: value, title: leaf(value), detail: value};
  let url: URL;
  try {url = new URL(value);} catch {throw invalid();}
  if (url.username || url.password) throw invalid();
  if (url.protocol === 'http:' || url.protocol === 'https:') return {kind: 'web', target: url.href, href: url.href, title: url.hostname, detail: url.href};
  if (url.protocol === 'file:') {
    if (url.search || url.hash) throw invalid();
    let path: string;
    try {path = decodeURIComponent(url.pathname);} catch {throw invalid();}
    if (url.hostname) path = `\\\\${url.hostname}${path.replace(/\//g, '\\')}`;
    else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1).replace(/\//g, '\\');
    return parseMaterialTarget(path);
  }
  if (url.protocol !== 'obsidian:' || url.port || url.hash) throw invalid();
  if (url.hostname === 'vault') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || url.search) throw invalid();
    let vault: string; let file: string;
    try {vault = decodeURIComponent(parts.shift()!); file = parts.map(decodeURIComponent).join('/');} catch {throw invalid();}
    url = new URL('obsidian://open'); url.searchParams.set('vault', vault); url.searchParams.set('file', file);
  }
  if (url.hostname !== 'open' || (url.pathname && url.pathname !== '/') || [...url.searchParams.keys()].some(key => !['vault', 'file', 'path', 'paneType'].includes(key))) throw invalid();
  for (const key of ['vault', 'file', 'path', 'paneType']) if (url.searchParams.getAll(key).length > 1) throw invalid();
  const vault = url.searchParams.get('vault')?.trim();
  const file = url.searchParams.get('file')?.trim();
  const path = url.searchParams.get('path')?.trim();
  const pane = url.searchParams.get('paneType');
  if ((!path && !vault) || (pane && !['tab', 'split', 'window'].includes(pane))) throw invalid();
  const normalized = new URL('obsidian://open');
  if (path) normalized.searchParams.set('path', path);
  else {normalized.searchParams.set('vault', vault!); if (file) normalized.searchParams.set('file', file);}
  if (pane) normalized.searchParams.set('paneType', pane);
  const target = normalized.href.replace(/\+/g, '%20');
  return {kind: 'obsidian', target, href: target, title: leaf(path || file || vault!).replace(/\.md(?=#|$)/i, ''), detail: vault ? `Obsidian · ${vault}` : 'Obsidian'};
}

export function validMaterial(value: unknown): value is NodeMaterial {
  const item = value as NodeMaterial;
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 240 || typeof item.target !== 'string') return false;
  try {parseMaterialTarget(item.target); return true;} catch {return false;}
}
