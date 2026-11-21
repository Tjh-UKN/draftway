import {describe, expect, it} from 'vitest';
import {chatFileLimit, findFileMention, isChatFile, isChatFiles, removeFileMention, type ChatFile} from './session-files';

describe('session file drafts', () => {
  const attachment: ChatFile = {kind: 'attachment', path: 'C:\\repo\\test.md', name: 'test.md'};

  it('accepts absolute files and bounds recovered drafts', () => {
    expect(isChatFiles([attachment, {...attachment, kind: 'reference', path: '/repo/chart.png'}])).toBe(true);
    expect(isChatFiles([{...attachment, path: '\\\\server\\share\\test.md'}])).toBe(true);
    expect(isChatFiles(Array.from({length: chatFileLimit + 1}, (_, index) => ({...attachment, path: `/repo/${index}.md`})))).toBe(false);
    expect(isChatFile({...attachment, path: 'test.md'})).toBe(false);
    expect(isChatFile({...attachment, path: '/repo/null\u0000.md'})).toBe(false);
    expect(isChatFile({...attachment, name: '../test.md'})).toBe(false);
    expect(isChatFile({...attachment, kind: 'unknown'})).toBe(false);
  });

  it('recognizes duplicate references to the same Windows file', () => {
    expect(isChatFiles([attachment, {...attachment, path: 'c:/REPO/test.md'}])).toBe(false);
    expect(isChatFiles([attachment, {...attachment, path: '\\\\?\\C:\\repo\\test.md'}])).toBe(false);
    expect(isChatFiles([{...attachment, path: '/Repo/test.md'}, {...attachment, path: '/repo/test.md'}])).toBe(true);
  });
});

describe('@ file mentions', () => {
  it('starts from the caret and preserves surrounding message text', () => {
    const value = 'Please check @docs/test.md and summarize\n  verbatim.';
    const start = value.indexOf('@');
    const caret = start + 6;
    const mention = findFileMention(value, caret, caret)!;
    expect(mention).toEqual({start, end: value.indexOf(' and'), query: 'docs/'});
    expect(removeFileMention(value, mention)).toBe('Please check and summarize\n  verbatim.');
    expect(findFileMention(value, caret, caret + 5)).toBeNull();
  });

  it('supports an empty query, Chinese text, and quoted filenames containing spaces', () => {
    expect(findFileMention('@', 1, 1)).toEqual({start: 0, end: 1, query: ''});
    const value = '看下@文档/测评.md，结论是什么';
    const caret = value.indexOf('，');
    expect(removeFileMention(value, findFileMention(value, caret, caret)!)).toBe('看下，结论是什么');
    const quoted = '@"daily notes/agenda.md" please summarize';
    const space = quoted.indexOf('/');
    expect(findFileMention(quoted, space, space)).toEqual({start: 0, end: quoted.indexOf(' please'), query: 'daily notes'});
    const endOfQuote = quoted.indexOf(' please');
    expect(findFileMention(quoted, endOfQuote, endOfQuote)?.query).toBe('daily notes/agenda.md');
  });

  it('does not turn an email address or a URL into file queries', () => {
    for (const text of ['name@example.com', 'https://example.com/@name', '`@example`']) {
      expect(findFileMention(text, text.length, text.length)).toBeNull();
    }
  });
});
