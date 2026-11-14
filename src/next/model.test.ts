import {describe, expect, it} from 'vitest';
import {descendants, nodeProgress, parseState, placeNodes, safeWebUrl, seedState} from './model';

describe('the new workspace model', () => {
  it('keeps event progress consistent through the tree', () => {
    const {nodes} = seedState().spaces[0];
    expect(nodeProgress(nodes, 'northstar')).toBe(45);
    expect(nodeProgress(nodes, 'act')).toBe(45);
    nodes.find(n => n.id === 'link')!.progress = 100;
    expect(nodeProgress(nodes, 'northstar')).toBe(53);
    expect(nodeProgress(nodes, 'think')).toBe(0);
  });
  it('collapses and focuses branches without changing the underlying events', () => {
    const {nodes} = seedState().spaces[0];
    expect(placeNodes(nodes).length).toBe(8);
    expect(placeNodes(nodes, ['act']).map(n => n.node.id)).not.toContain('link');
    expect(placeNodes(nodes, ['northstar'])).toHaveLength(1);
    expect(placeNodes(nodes, [], 'act').map(n => n.node.id)).toEqual(['act', 'link', 'spaces', 'experience']);
    expect(descendants(nodes, 'act')).toHaveLength(3);
    expect(nodes).toHaveLength(8);
  });
  it('places siblings without overlapping at increasing tree depths', () => {
    const {nodes} = seedState().spaces[0];
    nodes.push({id: 'deeper', parentId: 'link', side: 1, kind: 'event', title: 'A deeper step', body: '', progress: 0, due: '', steps: []});
    const placed = placeNodes(nodes);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]; const b = placed[j];
      expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2).toBe(true);
    }
  });
  it('rejects invalid saved state and unsafe web destinations', () => {
    const state = seedState();
    expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    state.spaces[0].nodes[1].parentId = 'simplicity';
    expect(() => parseState(state)).toThrow('节点关系无效');
    for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'microsoft-edge:https://example.com', 'https://user:pass@example.com']) expect(() => safeWebUrl(value)).toThrow();
    expect(safeWebUrl(' https://example.com/path ')).toBe('https://example.com/path');
  });
});
