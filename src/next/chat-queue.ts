import {useEffect} from 'react';
import type {AgentSession, WorkbenchState} from './core';
import {isChatFiles, type ChatFile} from './session-files';

export interface QueuedMessage {
  id: string;
  text: string;
  files?: ChatFile[];
  model?: string;
  effort?: string;
}

export type ChatSend = (session: AgentSession, request?: QueuedMessage & {queued?: true}) => boolean | void;

export function isChatQueue(value: unknown): value is QueuedMessage[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.text !== 'string' || (!item.text.trim() && !item.files?.length) || item.text.length > 20000 ||
        (item.files !== undefined && !isChatFiles(item.files)) ||
        [item.model, item.effort].some(option => option !== undefined &&
          (typeof option !== 'string' || !option.trim() || option.length > 256))) return false;
    ids.add(item.id);
  }
  return true;
}

function updateSession(state: WorkbenchState, id: string, update: (session: AgentSession) => AgentSession) {
  const current = state.sessions.find(session => session.id === id);
  if (!current) return state;
  const next = update(current);
  return current === next ? state : {...state, sessions: state.sessions.map(session => session === current ? next : session)};
}

export function enqueueChatMessage(state: WorkbenchState, id: string, message: QueuedMessage) {
  const lastRun = [...state.runs].reverse().find(run => run.sessionId === id)?.state;
  const turnFailed = lastRun === 'failed' || lastRun === 'cancelled' || lastRun === 'interrupted';
  return updateSession(state, id, session => ({...session, draft: '', draftFiles: [],
    queuedMessages: [...(session.queuedMessages ?? []), message],
    queuePaused: session.queuePaused || (!session.queuedMessages?.length && turnFailed ? true : undefined)}));
}

export function pauseChatQueue(state: WorkbenchState, id: string) {
  return updateSession(state, id, session => session.queuePaused ? session : {...session, queuePaused: true});
}

export function resumeChatQueue(state: WorkbenchState, id: string) {
  return updateSession(state, id, session => session.queuePaused && session.queuedMessages?.length
    ? {...session, queuePaused: undefined} : session);
}

export function changeQueuedMessage(state: WorkbenchState, id: string, messageId: string, text?: string) {
  return updateSession(state, id, session => session.queuedMessages?.some(item => item.id === messageId)
    ? {...session, queuedMessages: text === undefined ? session.queuedMessages.filter(item => item.id !== messageId)
      : session.queuedMessages.map(item => item.id === messageId ? {...item, text} : item)} : session);
}

function canSendFromQueue(state: WorkbenchState, session: AgentSession | undefined, headId: string) {
  return !!session?.nativeRevision && !session.queuePaused && session.queuedMessages?.[0]?.id === headId && !session.requests?.length &&
    !state.runs.some(run => run.sessionId === session.id && (run.state === 'running' || run.state === 'needs_input'));
}

export function canStartQueuedMessage(state: WorkbenchState, id: string, headId: string) {
  return canSendFromQueue(state, state.sessions.find(session => session.id === id), headId);
}

export function useChatQueue(state: WorkbenchState, enabled: boolean, send: ChatSend, sendSettled?: number) {
  useEffect(() => {
    if (!enabled) return;
    for (const session of state.sessions) {
      const head = session.queuedMessages?.[0];
      if (head && canSendFromQueue(state, session, head.id)) {
        send({...session, selectedModel: head.model, selectedEffort: head.effort}, {...head, queued: true});
      }
    }
  }, [state, enabled, send, sendSettled]);
}
