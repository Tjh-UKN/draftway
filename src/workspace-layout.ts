export interface WidgetWindowRect {x: number; y: number; width: number; height: number;}

export interface WidgetInstance {
  id: string;
  type: string;
  version: number;
  title: string;
  columns: number;
  height: number;
  config: Record<string, string>;
  window?: WidgetWindowRect;
}

export interface WorkspaceDefinition {
  id: string;
  name: string;
  zoom: number;
  widgets: WidgetInstance[];
  url?: string;
}

export interface WorkspaceLayout {
  version: 1;
  activeId: string;
  workspaces: WorkspaceDefinition[];
  templates: WorkspaceDefinition[];
}

export const layoutLimits = {workspaces: 32, templates: 32, widgets: 40};
export const clampZoom = (value: number) => Math.min(140, Math.max(60, Math.round(value / 10) * 10));
export const clampColumns = (value: number) => Math.min(12, Math.max(4, Math.round(value / 2) * 2));
export const clampHeight = (value: number) => Math.min(1200, Math.max(240, Math.round(value)));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= limit;
const id = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function webWorkspaceUrl(value: string): string {
  if (!value.trim() || value.length > 2048) throw new Error('请输入有效的网页地址。');
  let url: URL;
  try {url = new URL(value.trim());} catch {throw new Error('请输入完整的 http:// 或 https:// 网页地址。');}
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('工作区只支持不含登录信息的 HTTP 或 HTTPS 网页。');
  return url.href;
}

export function fitWidgetWindow(rect: WidgetWindowRect, viewport: {width: number; height: number}, minimum = {width: 320, height: 280}): WidgetWindowRect {
  const maxWidth = Math.max(160, Math.min(4096, viewport.width - 32));
  const maxHeight = Math.max(160, Math.min(4096, viewport.height - 64));
  const width = Math.round(Math.min(maxWidth, Math.max(Math.min(minimum.width, maxWidth), rect.width)));
  const height = Math.round(Math.min(maxHeight, Math.max(Math.min(minimum.height, maxHeight), rect.height)));
  return {width, height, x: Math.round(Math.max(16, Math.min(viewport.width - width - 16, rect.x))), y: Math.round(Math.max(48, Math.min(viewport.height - height - 16, rect.y)))};
}

const validWindow = (value: unknown) => object(value)
  && ['x','y'].every(key => typeof value[key] === 'number' && Number.isInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 100_000)
  && ['width','height'].every(key => typeof value[key] === 'number' && Number.isInteger(value[key]) && Number(value[key]) >= 160 && Number(value[key]) <= 4096);

// Unknown component types are retained so a temporarily unavailable module never erases its instances.
export function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (!object(value) || value.version !== 1) throw new Error('工作区布局版本不受支持，请使用兼容版本打开。');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512_000) throw new Error('工作区布局过大。');
  const validBoard = (board: unknown): boolean => {
    if (!object(board) || !id(board.id) || !text(board.name, 60) || typeof board.zoom !== 'number' || !Number.isInteger(board.zoom) || board.zoom < 60 || board.zoom > 140) return false;
    if (board.url !== undefined) {
      if (typeof board.url !== 'string') return false;
      try {webWorkspaceUrl(board.url);} catch {return false;}
    }
    if (!Array.isArray(board.widgets) || board.widgets.length > layoutLimits.widgets) return false;
    const ids = new Set();
    return board.widgets.every(widget => {
      if (!object(widget) || !id(widget.id) || ids.has(widget.id)) return false;
      ids.add(widget.id);
      return typeof widget.type === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(widget.type)
        && Number.isInteger(widget.version) && Number(widget.version) >= 1 && Number(widget.version) <= 1000
        && text(widget.title, 80) && [4,6,8,10,12].includes(Number(widget.columns)) && typeof widget.columns === 'number'
        && typeof widget.height === 'number' && Number.isInteger(widget.height) && widget.height >= 240 && widget.height <= 1200
        && object(widget.config) && Object.keys(widget.config).length <= 32
        && (widget.window === undefined || validWindow(widget.window))
        && Object.entries(widget.config).every(([key, entry]) => key.length <= 80 && typeof entry === 'string' && entry.length <= 2000);
    });
  };
  for (const [key, minimum, maximum] of [['workspaces', 1, layoutLimits.workspaces], ['templates', 0, layoutLimits.templates]] as const) {
    const boards = value[key];
    if (!Array.isArray(boards) || boards.length < minimum || boards.length > maximum || !boards.every(validBoard)
      || new Set(boards.map(board => board.id)).size !== boards.length) throw new Error('工作区布局格式无效，原配置已保留。');
  }
  if (!(value.workspaces as WorkspaceDefinition[]).some(board => board.id === value.activeId)) throw new Error('当前工作区不存在。');
  return value as unknown as WorkspaceLayout;
}

export function cloneWorkspace(source: WorkspaceDefinition, name: string): WorkspaceDefinition {
  return {...source, id: crypto.randomUUID(), name: name.trim(), widgets: source.widgets.map(widget => ({...widget, id: crypto.randomUUID(), config: {...widget.config}, ...(widget.window ? {window: {...widget.window}} : {})}))};
}

export function moveWidget(workspace: WorkspaceDefinition, from: string, to: string): WorkspaceDefinition {
  const widgets = [...workspace.widgets];
  const index = widgets.findIndex(widget => widget.id === from);
  const target = widgets.findIndex(widget => widget.id === to);
  if (index < 0 || target < 0 || index === target) return workspace;
  const [widget] = widgets.splice(index, 1);
  widgets.splice(target, 0, widget);
  return {...workspace, widgets};
}
