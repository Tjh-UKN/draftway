export interface ChatFile {
  kind: 'reference' | 'attachment';
  path: string;
  name: string;
}

export const chatFileLimit = 10;

const windowsPath = /^(?:[a-z]:[\\/]|[\\/]{2})/i;
const controlCharacter = /[\u0000-\u001f\u007f]/;

export function isChatFile(value: unknown): value is ChatFile {
  if (!value || typeof value !== 'object') return false;
  const {kind, path, name} = value as Partial<ChatFile>;
  return (kind === 'reference' || kind === 'attachment') &&
    typeof path === 'string' && path.length <= 32767 &&
    (windowsPath.test(path) || path.startsWith('/')) && !controlCharacter.test(path) &&
    typeof name === 'string' && !!name.trim() && name.length <= 255 &&
    !/[\\/]/.test(name) && !controlCharacter.test(name);
}

export function chatFileKey(file: ChatFile) {
  const path = windowsPath.test(file.path)
    ? file.path.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').toLowerCase()
    : file.path;
  return `${file.kind}:${path}`;
}

export function isChatFiles(value: unknown): value is ChatFile[] {
  if (!Array.isArray(value) || value.length > chatFileLimit) return false;
  const keys = new Set<string>();
  for (const item of value) {
    if (!isChatFile(item)) return false;
    keys.add(chatFileKey(item));
  }
  return keys.size === value.length;
}

export interface FileMention {
  start: number;
  end: number;
  query: string;
}

const mentionAtCaret = /(?:^|[\s([{\p{Script=Han}，。！？、：；（【])(@(?:"([^"\r\n]*)("?)|([^\s@`"'<>，。！？、：；）】,?!;)]*)))$/u;
const bareTokenEnd = /^[^\s@`"'<>，。！？、：；）】,?!;)]*/u;

export function findFileMention(value: string, start: number, end: number): FileMention | null {
  if (start !== end || start < 0 || start > value.length) return null;
  const match = mentionAtCaret.exec(value.slice(0, start));
  if (!match) return null;
  const tail = value.slice(end);
  const suffix = match[2] === undefined ? bareTokenEnd.exec(tail) : match[3] ? null : /^[^"\r\n]*"/.exec(tail);
  return {start: start - match[1].length, end: end + (suffix?.[0].length ?? 0), query: match[2] ?? match[4]};
}

export function removeFileMention(value: string, mention: FileMention) {
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  const joined = /[ \t]$/.test(before) && /^[ \t]/.test(after) ? after.slice(1) : after;
  return before + joined;
}
