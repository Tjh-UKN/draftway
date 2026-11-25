import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench} from './core';
import {durableWorkbench} from './persistence';
import {deleteWorkspace} from './session-management';
import {dissolveWorkspaceGroup, expandWorkspaceGroup, moveWorkspaceGroup, moveWorkspaceToGroup, workspaceGroupOf} from './workspace-groups';

describe('workspace groups', () => {
  it('reads older snapshots and persists grouping without changing workspace or session identity', () => {
    const initial = createSession(initialWorkbench(), 'design', 'think', 'session', 1);
    const restored = parseWorkbench(initial);
    expect(restored.workspaceGroups).toBeUndefined();
    const state = {...restored, workspaceGroups: [{id: 'group', name: '项目', workspaceIds: [], collapsed: true}]};
    const moved = moveWorkspaceToGroup(state, 'design', 'group');
    expect(moved.spaces).toBe(state.spaces);
    expect(moved.sessions).toBe(state.sessions);
    expect(workspaceGroupOf(moved, 'design')).toMatchObject({id: 'group', collapsed: false});
    const collapsed = {...moved, workspaceGroups: moved.workspaceGroups!.map(group => ({...group, collapsed: true}))};
    const reloaded = parseWorkbench(JSON.parse(JSON.stringify(durableWorkbench(collapsed))));
    expect(workspaceGroupOf(reloaded, 'design')).toMatchObject({id: 'group', collapsed: true});
    expect(workspaceGroupOf(expandWorkspaceGroup(reloaded, 'design'), 'design')?.collapsed).toBe(false);
  });

  it('moves workspaces between groups and preserves contents when dissolving a group', () => {
    const state = {...initialWorkbench(), workspaceGroups: [
      {id:'one', name:'一组', workspaceIds:['design']}, {id:'two', name:'二组', workspaceIds:[]},
    ]};
    const moved = moveWorkspaceToGroup(state, 'design', 'two');
    expect(moved.workspaceGroups?.map(group => group.workspaceIds)).toEqual([[], ['design']]);
    expect(workspaceGroupOf(moveWorkspaceToGroup(moved, 'design', ''), 'design')).toBeUndefined();
    const dissolved = dissolveWorkspaceGroup(moved, 'two');
    expect(dissolved.spaces).toBe(moved.spaces);
    expect(dissolved.activeId).toBe(moved.activeId);
    expect(workspaceGroupOf(dissolved, 'design')).toBeUndefined();
    expect(deleteWorkspace(moved, 'design').workspaceGroups?.map(group => group.workspaceIds)).toEqual([[], []]);
  });

  it('rejects a duplicate or dangling membership instead of silently hiding the workspace', () => {
    const initial = initialWorkbench();
    expect(() => parseWorkbench({...initial, workspaceGroups: [
      {id:'one',name:'一组',workspaceIds:['design']}, {id:'two',name:'二组',workspaceIds:['design']},
    ]})).toThrow('工作区分组数据无效');
    expect(() => parseWorkbench({...initial, workspaceGroups: [
      {id:'one',name:'一组',workspaceIds:['missing']},
    ]})).toThrow('工作区分组数据无效');
  });

  it('inserts a dropped workspace on either side of a row without duplicating membership', () => {
    const initial = initialWorkbench();
    const extra = {...initial.spaces[0], id: 'extra', name: '另一个项目'};
    const state = {...initial, spaces: [...initial.spaces, extra], workspaceGroups: [
      {id: 'first', name: '第一组', workspaceIds: ['design']},
      {id: 'second', name: '第二组', workspaceIds: ['review', 'extra']},
    ]};
    const moved = moveWorkspaceToGroup(state, 'design', 'second', {id: 'extra', position: 'before'});
    expect(moved.workspaceGroups?.map(group => group.workspaceIds)).toEqual([[], ['review', 'design', 'extra']]);
    const reordered = moveWorkspaceToGroup(moved, 'review', 'second', {id: 'extra', position: 'after'});
    expect(workspaceGroupOf(reordered, 'review')?.workspaceIds).toEqual(['design', 'extra', 'review']);
    expect(moveWorkspaceToGroup(reordered, 'review', 'first', {id: 'extra', position: 'after'})).toBe(reordered);
    expect(moveWorkspaceToGroup(reordered, 'review', 'second', {id: 'review', position: 'before'})).toBe(reordered);
    expect(parseWorkbench(reordered).workspaceGroups).toEqual(reordered.workspaceGroups);
  });

  it('sorts ungrouped workspaces and moves whole groups without reordering other workspaces', () => {
    const initial = initialWorkbench();
    const extra = {...initial.spaces[0], id: 'extra', name: '另一个项目'};
    const state = {...initial, spaces: [...initial.spaces, extra], workspaceGroups: [
      {id: 'first', name: '第一组', workspaceIds: ['review']},
      {id: 'second', name: '第二组', workspaceIds: []},
    ]};
    const reordered = moveWorkspaceToGroup(state, 'extra', '', {id: 'design', position: 'before'});
    expect(reordered.spaces.map(space => space.id)).toEqual(['extra', 'review', 'design', 'learn']);
    expect(reordered.spaces[1]).toBe(state.spaces[1]);
    const ungrouped = moveWorkspaceToGroup(reordered, 'review', '', {id: 'design', position: 'after'});
    expect(ungrouped.spaces.map(space => space.id)).toEqual(['extra', 'design', 'review', 'learn']);
    expect(workspaceGroupOf(ungrouped, 'review')).toBeUndefined();
    const groupsReordered = moveWorkspaceGroup(reordered, 'second', -1);
    expect(groupsReordered.workspaceGroups?.map(group => group.id)).toEqual(['second', 'first']);
    expect(groupsReordered.spaces).toBe(reordered.spaces);
    expect(moveWorkspaceGroup(groupsReordered, 'second', -1)).toBe(groupsReordered);
  });
});
