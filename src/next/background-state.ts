import type {Notice, WorkbenchState} from './core';
export interface ReviewStatus {workspaceId: string; url: string; connected: boolean; repository: string; runningCount: number; paused: boolean; reports: {file: string; state: string; prs: number[]; pending: number}[]; error: string | null; historyGap: boolean}
export interface BackgroundState {revision: number; error: string | null; notices: Notice[]; reviews: Record<string, ReviewStatus>}
export function mergeBackground(state: WorkbenchState, incoming: BackgroundState): WorkbenchState {
  const notices = [...state.notices];
  for (const notice of incoming.notices) {
    if (!state.spaces.some(space => space.id === notice.workspaceId)) continue;
    const sessionId = notice.target?.kind === 'session' ? notice.target.sessionId : notice.sessionId;
    if (sessionId && !state.sessions.some(session => session.id === sessionId)) continue;
    const index = notices.findIndex(old => old.id === notice.id);
    const value = {...notice, sessionId: notice.target?.kind === 'session' ? notice.target.sessionId : undefined, read: notice.read || !!notices[index]?.read};
    if (index < 0) notices.push(value); else notices[index] = value;
  }
  return {...state, notices: notices.sort((a, b) => a.at - b.at)};
}
