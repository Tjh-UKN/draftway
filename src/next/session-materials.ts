import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import {unified} from 'unified';
import {localPath, remarkLocalPaths} from '../local-paths';
import {sessionNodeIds, type AgentSession, type Message} from './core';
import {materialTargetKey, nodeMaterialLimit, parseMaterialTarget, type MaterialTarget, type NodeMaterial} from './material-target';
import {boundedText} from './text';

const markdown = unified().use(remarkParse).use(remarkGfm);
const linkLocalPaths = remarkLocalPaths();
const fileExtension = /\.[\p{L}\d][\p{L}\d_-]{0,15}$/u;
const bareFile = /\.(?:md|markdown|html?|pdf|txt|csv|json|ya?ml|xml|toml|log|png|jpe?g|gif|webp|svg|xlsx?|docx?|pptx?|zip|mp[34]|py|[jt]sx?|rs|go|sh|ps1)$/i;
const temporaryDirectory = /(?:^|[\\/])(?:tmp|temp|\.tmp|\.temp|\.cache|\.codex-tmp)[\\/]/i;
const temporaryFilename = /(?:^~\$|\.(?:tmp|temp|swp|swo|part|crdownload)$|~$)/i;

type MarkdownNode = {
  type: string; value?: string; url?: string; identifier?: string; alt?: string | null; children?: MarkdownNode[];
};
type Mention = {kind: 'link' | 'file' | 'image'; value: string; label?: string};
const parsedMentions = new WeakMap<Message, Mention[]>();

function* markdownNodes(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;
  if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference' || node.type === 'imageReference') return;
  for (const child of node.children ?? []) yield* markdownNodes(child);
}

function linkText(node: MarkdownNode): string {
  return node.value ?? node.alt ?? node.children?.map(linkText).join('') ?? '';
}

function messageMentions(message: Message): Mention[] {
  const cached = parsedMentions.get(message);
  if (cached) return cached;
  const mentions: Mention[] = (message.files ?? []).map(file => ({kind: 'file', value: file.path}));
  if (message.role === 'assistant') {
    const root = markdown.parse(message.text);
    linkLocalPaths(root);
    const nodes = [...markdownNodes(root)];
    const definitions = new Map<string, string>();
    for (const node of nodes) {
      if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    }
    for (const node of nodes) {
      if ((node.type === 'link' || node.type === 'image') && node.url) {
        mentions.push({kind: node.type, value: node.url, label: linkText(node)});
      } else if (node.type === 'linkReference' || node.type === 'imageReference') {
        const value = definitions.get(node.identifier ?? '');
        if (value) mentions.push({kind: node.type === 'linkReference' ? 'link' : 'image', value, label: linkText(node)});
      } else if (node.type === 'inlineCode' && node.value && (/[\\/]/.test(node.value) ? fileExtension : bareFile).test(node.value)) {
        mentions.push({kind: 'file', value: node.value});
      }
    }
  }
  parsedMentions.set(message, mentions);
  return mentions;
}

function mentionTarget({kind, value, label}: Mention, cwd?: string): MaterialTarget | undefined {
  try {
    if (kind === 'link' && /^(?:https?|obsidian):/i.test(value)) {
      const target = parseMaterialTarget(value);
      const title = label?.replace(/\s+/g, ' ').trim();
      return title && title !== value ? {...target, title} : target;
    }
    const input = kind === 'file' || /^(?:file|northstar-local):/i.test(value)
      ? value : decodeURIComponent(value.split(/[?#]/, 1)[0]);
    const path = localPath(input) ?? (input.startsWith('/') && !input.startsWith('//') ? input : null);
    if (path && (kind === 'file' || fileExtension.test(path))) return parseMaterialTarget(path);
    if (!cwd || !fileExtension.test(input) || /[:<>"|?*\u0000-\u001f\u007f]/.test(input) || /^[\\/]/.test(input)) return;
    const relative = input.replace(/^\.[\\/]/, '');
    const absolute = `${cwd.replace(/[\\/]+$/, '')}/${relative}`;
    return parseMaterialTarget(localPath(absolute) ?? absolute);
  } catch {return undefined;}
}

export function sessionMaterials(messages: readonly Message[], cwd?: string) {
  const materials = new Map<string, MaterialTarget>();
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const mention of messageMentions(messages[index])) {
      const target = mentionTarget(mention, cwd);
      if (!target) continue;
      const key = materialTargetKey(target.target);
      if (!materials.has(key)) materials.set(key, target);
    }
  }
  return [...materials.values()];
}

export interface SessionMaterial extends MaterialTarget {sessionId: string; sessionTitle: string}

export function nodeSessionMaterials(sessions: readonly AgentSession[], workspaceId: string, nodeId: string, cwd?: string) {
  const materials = new Map<string, SessionMaterial>();
  for (const session of [...sessions].reverse()) {
    if (session.workspaceId !== workspaceId || !sessionNodeIds(session).includes(nodeId)) continue;
    const replies = session.messages.filter(message => message.role === 'assistant');
    for (const material of sessionMaterials(replies, session.cwd ?? cwd)) {
      if (material.kind === 'file' && (temporaryDirectory.test(material.target) || temporaryFilename.test(material.title))) continue;
      const key = materialTargetKey(material.target);
      if (!materials.has(key)) materials.set(key, {...material, sessionId: session.id, sessionTitle: session.title});
    }
  }
  return [...materials.values()];
}

export function addNodeOutput(materials: NodeMaterial[], target: Pick<NodeMaterial, 'title' | 'target'>, id: string) {
  const key = materialTargetKey(target.target);
  const existing = materials.find(item => materialTargetKey(item.target) === key);
  if (existing) return existing.output ? materials : materials.map(item => item === existing ? {...item, output: true} : item);
  if (materials.length >= nodeMaterialLimit) return materials;
  return [...materials, {id, title: boundedText(target.title, 240), target: target.target, output: true}];
}
