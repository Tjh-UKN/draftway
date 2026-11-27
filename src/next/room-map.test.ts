import {describe, expect, it} from 'vitest';
import {conversationMap, type RoomMessage, type RoomSession} from './room-map';
import {ago} from './RoomDialog';

const session = (id: string, name: string, host: string, state = 'live'): RoomSession =>
  ({id, name, title: '', host, repo: '', version: '', state, status: '', lastSeen: 0, unread: 0, polling: [], links: [], draftwaySession: null});
const message = (id: number, sender: string, from: string, target: string | null): RoomMessage =>
  ({id, at: id * 1000, sender, from, to: target ?? '?', target, link: null, kind: 'notify', body: '', replyTo: null});

describe('room conversation map', () => {
  it('joins each pair once, whichever way the messages went, and counts them', () => {
    const sessions = [session('a1', 'api', 'RTX'), session('b2', 'web', 'Mac'), session('c3', 'idle', 'Mac')];
    const map = conversationMap({sessions, messages: [message(1, 'a1', 'api@RTX', 'b2'), message(2, 'b2', 'web@Mac', 'a1'), message(3, 'b2', 'web@Mac', 'link:release'), message(4, 'a1', 'api@RTX', null), message(5, 'a1', 'api@RTX', 'a1')]});
    expect(map.edges).toEqual([{a: 'a1', b: 'b2', count: 2, last: 2000}, {a: 'b2', b: 'link:release', count: 1, last: 3000}]);
    // Sessions that never talked stay off the map; group addresses come after the sessions, which are sorted by host.
    expect(map.nodes.map(node => [node.id, node.label, node.group])).toEqual([['b2', 'web@Mac', false], ['a1', 'api@RTX', false], ['link:release', 'link:release', true]]);
  });
  it('names senders that have left the session list from their messages', () => {
    const map = conversationMap({sessions: [session('a1', 'api', 'RTX')], messages: [message(1, 'gone99', 'old@SMC', 'a1')]});
    expect(map.nodes.find(node => node.id === 'gone99')).toMatchObject({label: 'old@SMC', host: 'SMC', state: 'gone'});
  });
  it('prints ages the way room who does', () => {
    expect([ago(0, 3000), ago(0, 125_000), ago(0, 7_300_000), ago(0, 90_000_000)]).toEqual(['3s', '2m', '2h', '1d']);
  });
});
