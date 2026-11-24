import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench, type Message} from './core';
import {nodeMaterialLimit, type NodeMaterial} from './material-target';
import {addNodeOutput, nodeSessionMaterials, sessionMaterials} from './session-materials';

const cwd = 'C:\\work';
const reply = (text: string): Message => ({id: 'answer', role: 'assistant', at: 2, text});

describe('会话材料索引', () => {
  it('indexes linked and mentioned files, input attachments and named web links', () => {
    const input: Message = {id: 'input', role: 'user', at: 1, text: 'https://ignored.example/',
      files: [{kind: 'attachment', name: 'trace.csv', path: 'C:\\inputs\\trace.csv'}]};
    const answer = reply([
      '[性能报告](./out/Latency%20Report.html#summary)',
      '另见 `out/notes.md` 和 C:\\work\\out\\results.json。',
      '[可访问的页面][site]',
      '[site]: https://example.com/output',
      '',
      '![架构图](./out/arch.svg)',
      '[same](file:///c:/WORK/out/notes.md)',
    ].join('\n\n'));
    expect(sessionMaterials([input, answer], cwd).map(({title, target}) => [title, target])).toEqual([
      ['Latency Report.html', 'C:\\work\\out\\Latency Report.html'],
      ['notes.md', 'C:\\work\\out\\notes.md'],
      ['results.json', 'C:\\work\\out\\results.json'],
      ['可访问的页面', 'https://example.com/output'],
      ['arch.svg', 'C:\\work\\out\\arch.svg'],
      ['trace.csv', 'C:\\inputs\\trace.csv'],
    ]);
  });

  it('skips code-block examples, inline method names and unsupported links', () => {
    const answer = reply('`torch.ops` [bad](javascript:alert) [anchor](#result) ![remote](https://images.example/image.png)\n\n```sh\ncat C:\\work\\sample.md\n```');
    expect(sessionMaterials([answer], cwd)).toEqual([]);
  });

  it('collects the linked sessions automatically while excluding input files, other nodes and workspaces', () => {
    let state = createSession(initialWorkbench(), 'design', 'think', 'primary', 1, 'codex');
    state = createSession(state, 'design', null, 'linked', 2, 'codex');
    const [primary, linked] = state.sessions;
    primary.cwd = cwd;
    primary.messages = [
      {id: 'input', role: 'user', text: '', at: 1, files: [{kind: 'attachment', name: 'input.csv', path: 'C:\\work\\input.csv'}]},
      reply('[报告](./report.html) [重复](./second.md)'),
    ];
    linked.linkedNodeIds = ['think'];
    linked.messages = [reply('`second.md`')];
    const unrelated = [
      {...primary, id: 'unlinked', nodeId: null, messages: [reply('`unlinked.html`')]},
      {...primary, id: 'elsewhere', workspaceId: 'other', messages: [reply('`other.html`')]},
    ];
    const materials = nodeSessionMaterials([...state.sessions, ...unrelated], 'design', 'think', cwd);
    expect(materials.map(item => [item.title, item.sessionId])).toEqual([['second.md', 'linked'], ['report.html', 'primary']]);
    expect(state.spaces[0].nodes.find(item => item.id === 'think')?.materials).toBeUndefined();
  });

  it('persists chosen outputs without making every source material an output', () => {
    const state = initialWorkbench();
    const node = state.spaces[0].nodes.find(item => item.id === 'think')!;
    const source = {id: 'reference', title: '素材', target: 'https://example.com/'};
    const report = {title: '报告', target: 'C:\\work\\report.html'};
    node.materials = addNodeOutput([source], report, 'material');
    const restored = parseWorkbench(JSON.parse(JSON.stringify(state)));
    const materials = restored.spaces[0].nodes.find(item => item.id === 'think')?.materials;
    expect(materials).toEqual([source, {id: 'material', ...report, output: true}]);
    expect(addNodeOutput(node.materials, {...report, target: 'c:/WORK/Report.HTML'}, 'duplicate')).toBe(node.materials);
    expect(addNodeOutput(node.materials, source, 'ignored')[0]).toEqual({...source, output: true});
  });

  it('honors the latest node material limit', () => {
    const materials: NodeMaterial[] = Array.from({length: nodeMaterialLimit}, (_, index) => ({id: String(index), title: '报告', target: `C:\\work\\${index}.md`}));
    expect(addNodeOutput(materials, {title: '新文档', target: 'C:\\work\\new.md'}, 'new')).toBe(materials);
    expect(addNodeOutput(materials, materials[0], 'ignored')[0].output).toBe(true);
  });
});
