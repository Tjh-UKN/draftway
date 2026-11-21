import {closeSurface, createWorkspace, defaultSessionWindow, updateWorkspace, type WorkbenchState} from './core';
import {closeDockTab} from './docking';
import {boundedText} from './text';

export function assertSessionsIdle(state: WorkbenchState, ids: string[]) {
  if (state.runs.some(run => ids.includes(run.sessionId) && ['running', 'needs_input'].includes(run.state))) throw Error('请先停止正在执行或等待输入的会话，再删除。');
}

export function renameSession(state: WorkbenchState, id: string, value: string): WorkbenchState {
  const title = boundedText(value.replace(/[\r\n]+/g, ' ').trim(), 100);
  if (!title || !state.sessions.some(session => session.id === id)) return state;
  return {...state, sessions: state.sessions.map(session => session.id === id ? {...session, title} : session), spaces: state.spaces.map(space => ({...space, dock: {...space.dock, tabs: space.dock.tabs.map(tab => tab.kind === 'session' && tab.sessionId === id ? {...tab, title} : tab)}, surfaces: space.surfaces.map(surface => surface.integrationId === 'session' && surface.resourceId === id ? {...surface, title} : surface)}))};
}

export function deleteSessions(state: WorkbenchState, ids: string[]): WorkbenchState {
  assertSessionsIdle(state, ids);
  let next = state;
  for (const space of state.spaces) {
    next = updateWorkspace(next, space.id, original => {
      let space = original;
      for (const surface of original.surfaces.filter(surface => surface.integrationId === 'session' && ids.includes(surface.resourceId || ''))) {
        space = closeSurface(space, surface.id);
        space = {...space, surfaces: space.surfaces.filter(item => item.id !== surface.id)};
      }
      let dock = space.dock;
      for (const tab of dock.tabs.filter(tab => tab.kind === 'session' && ids.includes(tab.sessionId))) dock = closeDockTab(dock, tab.id);
      const tabs = space.sessionTabs;
      const recent = tabs.recent.filter(id => !ids.includes(id));
      return {...space, dock, sessionTabs: {ids: tabs.ids.filter(id => !ids.includes(id)), recent, activeId: ids.includes(tabs.activeId) ? recent.at(-1) || 'workspace' : tabs.activeId}, sessionWindow: space.sessionWindow.sessionId && ids.includes(space.sessionWindow.sessionId) ? defaultSessionWindow() : space.sessionWindow};
    });
  }
  return {...next, sessions: next.sessions.filter(session => !ids.includes(session.id)), runs: next.runs.filter(run => !ids.includes(run.sessionId)), artifacts: next.artifacts.filter(artifact => !ids.includes(artifact.sessionId)), notices: next.notices.filter(notice => !ids.includes(notice.sessionId || '') && !(notice.target?.kind === 'session' && ids.includes(notice.target.sessionId)))};
}

export function deleteWorkspace(state: WorkbenchState, id: string): WorkbenchState {
  if (!state.spaces.some(space => space.id === id)) return state;
  const next = deleteSessions(state, state.sessions.filter(session => session.workspaceId === id).map(session => session.id));
  const spaces = next.spaces.filter(space => space.id !== id);
  if (!spaces.length) spaces.push(createWorkspace('我的工作区', 'blank'));
  return {...next, spaces, activeId: next.activeId === id ? spaces[0].id : next.activeId, notices: next.notices.filter(notice => notice.workspaceId !== id)};
}
