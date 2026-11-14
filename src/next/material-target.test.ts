import {describe, expect, it} from 'vitest';
import {parseMaterialTarget} from './material-target';
import {initialWorkbench, parseWorkbench} from './core';

describe('node material references', () => {
  it('opens an existing Obsidian note with encoded vault, folder and heading', () => {
    const target = parseMaterialTarget('obsidian://open?vault=My%20Vault&file=Design%2FNote.md%23Heading');
    expect(target.kind).toBe('obsidian');
    expect(target.title).toBe('Note#Heading');
    expect(new URL(target.href!).searchParams.get('vault')).toBe('My Vault');
    expect(target.href).toContain('vault=My%20Vault');
    expect(new URL(target.href!).searchParams.get('file')).toBe('Design/Note.md#Heading');
    expect(parseMaterialTarget(target.target).target).toBe(target.target);
  });
  it('recognizes Obsidian shorthand and absolute-note links', () => {
    const shorthand = parseMaterialTarget('obsidian://vault/My%20Vault/Folder/Note');
    expect(new URL(shorthand.target).searchParams.get('file')).toBe('Folder/Note');
    expect(new URL(shorthand.target).searchParams.get('vault')).toBe('My Vault');
    expect(parseMaterialTarget('obsidian://open?path=C%3A%5CVault%5CNote.md').title).toBe('Note');
  });
  it('keeps local files as paths and normalizes normal web URLs', () => {
    expect(parseMaterialTarget('"C:\\My Notes\\report.pdf"')).toMatchObject({kind: 'file', target: 'C:\\My Notes\\report.pdf', title: 'report.pdf'});
    expect(parseMaterialTarget('file:///C:/My%20Notes/Note.md')).toMatchObject({kind: 'file', target: 'C:\\My Notes\\Note.md'});
    expect(parseMaterialTarget('https://example.com/notes?q=one')).toMatchObject({kind: 'web', href: 'https://example.com/notes?q=one'});
  });
  it('rejects script links, credentials and Obsidian write or callback actions', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com', 'obsidian://new?vault=Test&file=Note&overwrite=true', 'obsidian://open?vault=Test&file=Note&x-success=evil://run', 'obsidian://open?vault=Test&vault=Other', 'obsidian://open?file=Note', 'just some text']) expect(() => parseMaterialTarget(value)).toThrow();
  });
  it('persists multiple materials and keeps the old reference without mutating the source', () => {
    const state = initialWorkbench();
    const node = state.spaces[0].nodes[0];
    node.reference = 'old/path.md';
    node.materials = [{id: 'note-1', title: 'Design', target: 'obsidian://open?vault=Notes&file=Design'}, {id: 'web-1', title: 'Reference', target: 'https://example.com/'}];
    const saved = JSON.stringify(state);
    const restored = parseWorkbench(JSON.parse(saved));
    expect(restored.spaces[0].nodes[0].materials).toEqual(node.materials);
    expect(restored.spaces[0].nodes[0].reference).toBe('old/path.md');
    expect(JSON.stringify(state)).toBe(saved);
    restored.spaces[0].nodes[0].materials![0].target = 'javascript:alert(1)';
    expect(() => parseWorkbench(restored)).toThrow('关联材料格式无效');
  });
});
