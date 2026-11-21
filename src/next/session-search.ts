import type {Message} from './core';

export interface TranscriptMatch {
  messageId: string;
  row: number;
  offset: number;
  occurrence: number;
}

export function transcriptSearchPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

export function createTranscriptSearch(query: string) {
  const term = query.trim();
  const pattern = transcriptSearchPattern(term);
  // Streaming reuses unchanged Message objects, so only edited or appended text is rescanned.
  const cache = new WeakMap<Message, number[]>();
  return (messages: readonly Message[]): TranscriptMatch[] => {
    if (!term) return [];
    return messages.flatMap((message, row) => {
      let offsets = cache.get(message);
      if (!offsets) {
        const files = message.files?.map(file => file.name) ?? [];
        offsets = Array.from([message.text, ...files].join('\n').matchAll(pattern), match => match.index);
        cache.set(message, offsets);
      }
      return offsets.map((offset, occurrence) => ({messageId: message.id, row, offset, occurrence}));
    });
  };
}

export function matchingTextRange(contents: Iterable<HTMLElement>, pattern: RegExp, occurrence: number) {
  const textNodes: {node: Text; start: number; end: number}[] = [];
  let text = '';
  for (const content of contents) {
    if (text) text += '\n';
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('.message-copy') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!node.length) continue;
      textNodes.push({node, start: text.length, end: text.length + node.length});
      text += node.data;
    }
  }
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (index++ !== occurrence) continue;
    const end = match.index + match[0].length;
    const first = textNodes.find(node => node.end > match.index);
    const last = textNodes.find(node => node.end >= end);
    if (!first || !last) return;
    const range = document.createRange();
    range.setStart(first.node, Math.max(0, match.index - first.start));
    range.setEnd(last.node, Math.max(0, end - last.start));
    return range;
  }
}
