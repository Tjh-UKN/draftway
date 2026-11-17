import {afterEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSession, initialWorkbench} from './core';
import {useNativeAgents, type AgentRuntime} from './NativeAgents';

const {invoke} = vi.hoisted(() => ({invoke: vi.fn(() => new Promise(() => {}))}));
vi.mock('@tauri-apps/api/core', () => ({isTauri: () => true, invoke}));
afterEach(() => {vi.unstubAllGlobals(); invoke.mockClear();});

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
