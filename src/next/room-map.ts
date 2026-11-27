// Who has talked to whom in a switchboard room, from the recent messages: one node per session or group address
// (repo:, link:, host:, all), one edge per pair with how many messages went between them.
export interface RoomSession {id: string; name: string; title: string; host: string; repo: string; version: string; state: string; status: string; lastSeen: number; unread: number; polling: string[]; links: string[]; draftwaySession: string | null}
export interface RoomMessage {id: number; at: number; sender: string; from: string; to: string; target: string | null; link: string | null; kind: string; body: string; replyTo: number | null}
export interface RoomView {configured: boolean; url: string; sessions: RoomSession[]; messages: RoomMessage[]}

export interface MapNode {id: string; label: string; host: string; state: string; group: boolean; x: number; y: number; anchor: 'start' | 'middle' | 'end'}
export interface MapEdge {a: string; b: string; count: number; last: number}

export const sessionLabel = (session: Pick<RoomSession, 'id' | 'name' | 'host'>) => `${session.name || session.id.slice(0, 8)}@${session.host}`;
export const isGroup = (id: string) => id === 'all' || /^(repo|link|host):/.test(id);

/** Nodes on an ellipse, grouped by host so each machine's sessions sit together; group addresses come last. */
export function conversationMap(view: Pick<RoomView, 'sessions' | 'messages'>, width = 640, height = 340): {nodes: MapNode[]; edges: MapEdge[]} {
  const edges = new Map<string, MapEdge>();
  for (const message of view.messages) {
    if (!message.target || message.target === message.sender) continue;
    const [a, b] = [message.sender, message.target].sort();
    const edge = edges.get(`${a}\n${b}`) ?? {a, b, count: 0, last: 0};
    edge.count += 1; edge.last = Math.max(edge.last, message.at);
    edges.set(`${a}\n${b}`, edge);
  }
  const sessions = new Map(view.sessions.map(session => [session.id, session]));
  const senders = new Map(view.messages.map(message => [message.sender, message.from]));
  const ids = [...new Set([...edges.values()].flatMap(edge => [edge.a, edge.b]))];
  const info = ids.map(id => {
    const session = sessions.get(id);
    const label = isGroup(id) ? id : session ? session.title || sessionLabel(session) : senders.get(id) ?? id.slice(0, 8);
    const host = session?.host ?? (isGroup(id) ? '' : label.split('@')[1] ?? '');
    return {id, label, host, state: session?.state ?? (isGroup(id) ? 'group' : 'gone'), group: isGroup(id)};
  }).sort((p, q) => Number(p.group) - Number(q.group) || p.host.localeCompare(q.host) || p.label.localeCompare(q.label));
  const [cx, cy, rx, ry] = [width / 2, height / 2, width / 2 - 150, height / 2 - 40];
  const nodes = info.map((node, index): MapNode => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(info.length, 1);
    const [x, y] = info.length === 1 ? [cx, cy] : [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
    const anchor = Math.abs(x - cx) < 1 ? 'middle' : x > cx ? 'start' : 'end';
    return {...node, x, y, anchor};
  });
  return {nodes, edges: [...edges.values()]};
}
