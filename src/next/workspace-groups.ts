import type {WorkbenchState, Workspace} from './core';

export interface WorkspaceGroup {
  id: string;
  name: string;
  workspaceIds: string[];
  collapsed?: boolean;
}

export interface WorkspaceNeighbor {
  id: string;
  position: 'before' | 'after';
}

export function validateWorkspaceGroups(groups: WorkspaceGroup[] | undefined, workspaces: Workspace[]) {
  if (groups === undefined) return;
  const workspaceIds = new Set(workspaces.map(workspace => workspace.id));
  const groupIds = new Set<string>();
  if (Array.isArray(groups) && groups.every(group => {
    if (!group || typeof group.id !== 'string' || !group.id || group.id.length > 100 || groupIds.has(group.id) ||
        typeof group.name !== 'string' || !group.name.trim() || group.name.length > 40 ||
        (group.collapsed !== undefined && typeof group.collapsed !== 'boolean') || !Array.isArray(group.workspaceIds)) return false;
    groupIds.add(group.id);
    return group.workspaceIds.every(id => workspaceIds.delete(id));
  })) return;
  throw new Error('工作区分组数据无效。');
}

export function workspaceGroupOf(state: WorkbenchState, workspaceId: string) {
  return state.workspaceGroups?.find(group => group.workspaceIds.includes(workspaceId));
}

export function updateWorkspaceGroup(state: WorkbenchState, id: string, update: (group: WorkspaceGroup) => WorkspaceGroup): WorkbenchState {
  return {...state, workspaceGroups: state.workspaceGroups?.map(group => group.id === id ? update(group) : group)};
}

export function expandWorkspaceGroup(state: WorkbenchState, workspaceId: string): WorkbenchState {
  const group = workspaceGroupOf(state, workspaceId);
  return group?.collapsed ? updateWorkspaceGroup(state, group.id, current => ({...current, collapsed: false})) : state;
}

function insertNextTo(ids: string[], workspaceId: string, neighbor: WorkspaceNeighbor) {
  const order = ids.filter(id => id !== workspaceId);
  order.splice(order.indexOf(neighbor.id) + (neighbor.position === 'after' ? 1 : 0), 0, workspaceId);
  return order;
}

export function moveWorkspaceToGroup(state: WorkbenchState, workspaceId: string, groupId: string, neighbor?: WorkspaceNeighbor): WorkbenchState {
  const groups = state.workspaceGroups;
  if (!state.spaces.some(workspace => workspace.id === workspaceId) ||
      (groupId && !groups?.some(group => group.id === groupId))) return state;
  if (neighbor && (neighbor.id === workspaceId || !state.spaces.some(workspace => workspace.id === neighbor.id) ||
      (workspaceGroupOf(state, neighbor.id)?.id ?? '') !== groupId)) return state;

  const workspaceGroups = groups?.map(group => {
    const includesWorkspace = group.workspaceIds.includes(workspaceId);
    if (group.id === groupId) {
      const workspaceIds = neighbor ? insertNextTo(group.workspaceIds, workspaceId, neighbor)
        : includesWorkspace ? group.workspaceIds : [...group.workspaceIds, workspaceId];
      return {...group, collapsed: false, workspaceIds};
    }
    return includesWorkspace ? {...group, workspaceIds: group.workspaceIds.filter(id => id !== workspaceId)} : group;
  });
  if (!neighbor || groupId) return groups ? {...state, workspaceGroups} : state;

  const groupedIds = new Set(workspaceGroups?.flatMap(group => group.workspaceIds));
  const ungrouped = new Map(state.spaces.filter(workspace => !groupedIds.has(workspace.id)).map(workspace => [workspace.id, workspace]));
  const order = insertNextTo([...ungrouped.keys()], workspaceId, neighbor).map(id => ungrouped.get(id)!);
  let index = 0;
  const spaces = state.spaces.map(workspace => groupedIds.has(workspace.id) ? workspace : order[index++]);
  return {...state, workspaceGroups, spaces};
}

export function moveWorkspaceGroup(state: WorkbenchState, id: string, direction: -1 | 1): WorkbenchState {
  const groups = state.workspaceGroups;
  const index = groups?.findIndex(group => group.id === id) ?? -1;
  const destination = index + direction;
  if (!groups || index < 0 || destination < 0 || destination >= groups.length) return state;
  const workspaceGroups = [...groups];
  [workspaceGroups[index], workspaceGroups[destination]] = [workspaceGroups[destination], workspaceGroups[index]];
  return {...state, workspaceGroups};
}

export function dissolveWorkspaceGroup(state: WorkbenchState, id: string): WorkbenchState {
  return {...state, workspaceGroups: state.workspaceGroups?.filter(group => group.id !== id)};
}
