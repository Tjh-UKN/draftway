import {advanceDemoRuns, cancelDemoRun, resumeDemoRun, startDemoRun, type DemoOutcome, type MapAction, type WorkbenchState} from './core';

// Following Orca's provider registry boundary: the host owns records, an adapter
// supplies execution operations. Only implemented adapters can be registered.
export interface SessionAdapter {
  start(state: WorkbenchState, sessionId: string, text: string, outcome: DemoOutcome, runId: string, at: number, mapAction?: MapAction, targetNodeId?: string): WorkbenchState;
  resume(state: WorkbenchState, runId: string, at: number): WorkbenchState;
  cancel(state: WorkbenchState, runId: string): WorkbenchState;
  reconcile(state: WorkbenchState, at: number): WorkbenchState;
}
const adapters = new Map<string, SessionAdapter>([
  ['demo-agent', {start: startDemoRun, resume: resumeDemoRun, cancel: cancelDemoRun, reconcile: advanceDemoRuns}],
]);
export function sessionAdapter(integrationId: string) {return adapters.get(integrationId);}
export function reconcileSessions(state: WorkbenchState, at: number) {
  let next = state;
  for (const adapter of adapters.values()) next = adapter.reconcile(next, at);
  return next;
}
