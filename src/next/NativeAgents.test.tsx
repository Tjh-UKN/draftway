import {afterEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSession, initialWorkbench} from './core';
import {useNativeAgents, type AgentRuntime} from './NativeAgents';

const {invoke} = vi.hoisted(() => ({invoke: vi.fn((_command: string, _args?: unknown): Promise<unknown> => new Promise(() => {}))}));
vi.mock('@tauri-apps/api/core', () => ({isTauri: () => true, invoke}));
afterEach(() => {vi.unstubAllGlobals(); invoke.mockReset(); invoke.mockImplementation(() => new Promise(() => {}));});

it('sends the exact node-linked draft without trimming or adding context', () => {
  vi.stubGlobal('window', {});
  let state = createSession(initialWorkbench(), 'design', 'link', 'session', 1);
  const text = ' \t\r\n中文 "quotes" `code` \\path\u2028\n\t ';
  state.sessions[0].draft = text;
  let runtime: AgentRuntime | null = null;
  function Probe() {runtime = useNativeAgents(state, update => {state = update(state);}); return null;}
  renderToStaticMarkup(<Probe/>);
  (runtime as AgentRuntime | null)!.send(state.sessions[0]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('agent_send', {id: 'session', runId: expect.any(String), text});
  expect(state.sessions[0].draft).toBe('');
  state.sessions[0].draft = ' \t\r\n ';
  (runtime as AgentRuntime | null)!.send(state.sessions[0]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(state.sessions[0].draft).toBe(' \t\r\n ');
});

it.each(['codex', 'claude', 'pi'])('loads the %s catalog without sending a message and forwards explicit turn choices', async backend => {
  vi.stubGlobal('window', {});
  const state = createSession(initialWorkbench(), 'design', null, 'session', 1);
  const session = {...state.sessions[0], integrationId:backend, draft:'inspect', selectedModel:'selected-model', selectedEffort:'high'};
  const host = {current: null as AgentRuntime | null};
  function Probe() {host.current = useNativeAgents(state, () => {}); return null;}
  renderToStaticMarkup(<Probe/>);
  const catalog = {models: [], model:'configured-model', effort:'low'};
  invoke.mockResolvedValueOnce(catalog);
  await expect(host.current!.modelOptions(session.id)).resolves.toEqual(catalog);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('agent_model_options', {id:session.id});
  host.current!.send(session);
  expect(invoke).toHaveBeenLastCalledWith('agent_send', {
    id:session.id, runId:expect.any(String), text:'inspect', model:'selected-model', effort:'high',
  });
});

it('shares an active executor check and permits a retry after failure', async () => {
  vi.stubGlobal('window', {});
  const state = initialWorkbench();
  const host = {current: null as AgentRuntime | null};
  function Probe() {host.current = useNativeAgents(state, () => {}); return null;}
  renderToStaticMarkup(<Probe/>);
  invoke.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce([]);
  const first = host.current!.refreshBackends();
  expect(host.current!.refreshBackends()).toBe(first);
  await first;
  await host.current!.refreshBackends();
  expect(invoke.mock.calls).toEqual([['agent_backends'], ['agent_backends']]);
});

it('deduplicates model prefetches and skips work queued for a closed workspace', async () => {
  vi.stubGlobal('window', {});
  const host = {current: null as AgentRuntime | null};
  function Probe() {host.current = useNativeAgents(initialWorkbench(), () => {}); return null;}
  renderToStaticMarkup(<Probe/>);
  let completePi!: () => void;
  invoke.mockImplementationOnce(() => new Promise<void>(resolve => {completePi = resolve;}));
  const prefetch = host.current!.prefetchModelOptions;
  const pi = prefetch('pi', 'workspace', 'C:\\Repo');
  const duplicate = prefetch('pi', 'other-workspace', 'c:/repo/');
  void prefetch('claude', 'workspace');
  const scope = new AbortController();
  const queued = prefetch('codex', 'closed-workspace', undefined, scope.signal);
  expect(invoke.mock.calls).toEqual([
    ['agent_prefetch_model_options', {backend: 'pi', workspaceId: 'workspace', cwd: 'C:\\Repo'}],
    ['agent_prefetch_model_options', {backend: 'claude', workspaceId: 'workspace', cwd: null}],
  ]);
  scope.abort();
  completePi();
  await Promise.all([pi, duplicate, queued]);
  expect(invoke).toHaveBeenCalledTimes(2);
});
