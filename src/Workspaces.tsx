import {Component, useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Globe, Grip, LayoutGrid, Pencil, Plus, Puzzle, RotateCcw, Settings2, Trash2, X, ZoomIn, ZoomOut} from 'lucide-react';
import {Modal} from './components';
import {useWorkbench} from './workbench';
import * as api from './api';
import {clampZoom, cloneWorkspace, layoutLimits, moveWidget, parseWorkspaceLayout, webWorkspaceUrl, type WidgetInstance, type WorkspaceDefinition, type WorkspaceLayout} from './workspace-layout';
import {createWidget, defaultWorkspaceLayout, findWidget, widgetRegistry} from './widgets';
import type {WidgetDefinition} from './widgets/types';
import WidgetWindow from './WidgetWindow';
import {webWorkspacePresets} from './workspace-presets';
import './workspaces.css';

class WidgetBoundary extends Component<{children: ReactNode}, {error: boolean}> {
  state = {error: false};
  static getDerivedStateFromError() {return {error: true};}
  render() {
    return this.state.error ? <div className="widget-unavailable"><Puzzle/><p>这个组件暂时无法显示。</p><button type="button" className="button" onClick={() => this.setState({error: false})}>重试组件</button></div> : this.props.children;
  }
}

function WidgetContent({definition, widget, full}: {definition: WidgetDefinition; widget: WidgetInstance; full: boolean}) {
  return full && definition.fullView ? definition.fullView(widget.config) : definition.render(widget.config);
}

function initialLayout(value: unknown) {
  try {return {layout: value == null ? defaultWorkspaceLayout() : parseWorkspaceLayout(value), error: ''};}
  catch (error) {return {layout: null, error: String(error)};}
}

function WidgetSettings({initial, onSave, onClose}: {initial: WidgetInstance; onSave: (widget: WidgetInstance) => void; onClose: () => void}) {
  const [draft, setDraft] = useState({...initial, config: {...initial.config}});
  const definition = findWidget(initial.type);
  const Settings = definition && definition.version === initial.version ? definition.Settings : undefined;
  return <Modal title="组件设置" subtitle="修改这个组件实例，不影响其他工作区中的同类组件。" onClose={onClose}>
    <form onSubmit={event => {event.preventDefault(); onSave({...draft, title: draft.title.trim()});}}>
      <label className="field"><span>组件名称</span><input data-autofocus required maxLength={80} value={draft.title} onChange={event => setDraft({...draft, title: event.target.value})}/></label>
      {Settings && <WidgetBoundary><Settings config={draft.config} onChange={config => setDraft({...draft, config})}/></WidgetBoundary>}
      <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!draft.title.trim()}>保存组件设置</button></div>
    </form>
  </Modal>;
}

export default function Workspaces() {
  const ctx = useWorkbench();
  const [initial] = useState(() => initialLayout(ctx.data.workspaceLayout));
  const [layout, setLayout] = useState(initial.layout);
  const [loadError, setLoadError] = useState(initial.error);
  const latest = useRef(layout);
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'|'editing'>('saved');
  const [saveError, setSaveError] = useState('');
  const saveSequence = useRef(0);
  const saving = useRef(0);
  const source = JSON.stringify(ctx.data.workspaceLayout ?? null);
  const previousSource = useRef(source);
  const initialized = useRef(false);
  const [dialog, setDialog] = useState<'create'|'edit'|'catalog'|'template'|'delete'|null>(null);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [workspaceType, setWorkspaceType] = useState<'components'|'web'>('components');
  const [website, setWebsite] = useState('');
  const [webPreset, setWebPreset] = useState('');
  const [formError, setFormError] = useState('');
  const [openedWebsite, setOpenedWebsite] = useState<string|null>(null);
  const [settingsId, setSettingsId] = useState<string|null>(null);
  const [focusedId, setFocusedId] = useState<string|null>(null);
  const [focusMode, setFocusMode] = useState<'expanded'|'full'>('expanded');
  const dragging = useRef<string|null>(null);
  const [dropTarget, setDropTarget] = useState<string|null>(null);
  const viewport = useRef<HTMLDivElement>(null);

  function persist(next: WorkspaceLayout) {
    const sequence = ++saveSequence.current;
    saving.current++;
    setSaveStatus('saving');
    void api.saveWorkspaceLayout(next).then(() => {
      if (sequence === saveSequence.current) {setSaveStatus('saved'); setSaveError('');}
    }).catch(error => {
      if (sequence === saveSequence.current) {setSaveStatus('error'); setSaveError(String(error));}
    }).finally(() => {saving.current--;});
  }

  function change(update: (current: WorkspaceLayout) => WorkspaceLayout, save = true) {
    if (!latest.current) return;
    const next = update(latest.current);
    try {parseWorkspaceLayout(next);} catch (error) {setSaveStatus('error'); setSaveError(String(error)); return;}
    latest.current = next;
    setLayout(next);
    if (save) persist(next); else setSaveStatus('editing');
  }

  function updateBoard(update: (board: WorkspaceDefinition) => WorkspaceDefinition, save = true) {
    change(current => ({...current, workspaces: current.workspaces.map(board => board.id === current.activeId ? update(board) : board)}), save);
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (ctx.data.workspaceLayout == null && latest.current) persist(latest.current);
  }, []);

  useEffect(() => {
    if (source === previousSource.current) return;
    previousSource.current = source;
    // A record refresh can contain an older layout while layout writes are still queued.
    if (saving.current || saveStatus === 'error') return;
    const incoming = initialLayout(ctx.data.workspaceLayout);
    if (!incoming.error && JSON.stringify(incoming.layout) === JSON.stringify(latest.current)) return;
    latest.current = incoming.layout;
    setLayout(incoming.layout);
    setLoadError(incoming.error);
    setFocusedId(null);
    setSettingsId(null);
    setDialog(null);
    if (ctx.data.workspaceLayout == null && incoming.layout) persist(incoming.layout);
  }, [source]);

  useEffect(() => {
    if (ctx.page !== 'workspaces') {setFocusedId(null); setSettingsId(null); setDialog(null);}
  }, [ctx.page]);

  if (!layout) return <div className="workspace-load-error"><Puzzle size={32}/><h1>暂时无法读取工作区布局</h1><p>{loadError}</p><p>配置仍保留在本地。可以继续从左侧使用原有功能。</p><button className="button" onClick={() => {void ctx.run(ctx.refresh);}}>重新读取</button></div>;
  const active = layout.workspaces.find(board => board.id === layout.activeId)!;
  const settings = active.widgets.find(widget => widget.id === settingsId);
  const focus = active.widgets.find(widget => widget.id === focusedId);
  const scale = active.zoom / 100;

  function activateWebWorkspace(board: WorkspaceDefinition) {
    if (!board.url) return;
    void ctx.run(async () => {await api.openWebWorkspace(board.url!); setOpenedWebsite(board.id);}, api.desktop ? '已请求 Edge 打开网页' : '已请求在新页面打开');
  }

  function switchWorkspace(id: string, open = true) {
    setFocusedId(null); setSettingsId(null);
    change(current => ({...current, activeId: id}));
    const board = latest.current?.workspaces.find(item => item.id === id);
    if (open && board?.url) activateWebWorkspace(board);
  }

  function reorder(id: string, direction: number) {
    const index = active.widgets.findIndex(widget => widget.id === id);
    const target = active.widgets[index + direction];
    if (target) updateBoard(board => moveWidget(board, id, target.id));
  }

  function createWorkspace() {
    const sourceBoard = layout!.templates.find(template => template.id === templateId);
    const board: WorkspaceDefinition = sourceBoard ? cloneWorkspace(sourceBoard, name) : {id: crypto.randomUUID(), name: name.trim(), zoom: 100, widgets: []};
    if (workspaceType === 'web') {try {board.url = webWorkspaceUrl(website);} catch (error) {setFormError(String(error)); return;}}
    change(current => ({...current, activeId: board.id, workspaces: [...current.workspaces, board]}));
    setDialog(null); setFocusedId(null);
    if (board.url) activateWebWorkspace(board);
  }

  return <section className="workspace-page" aria-label="工作区">
    <div className="workspace-tabs-bar"><div className="workspace-tabs" role="tablist" aria-label="选择工作区">
      {layout.workspaces.map((board, index) => <button key={board.id} id={`workspace-tab-${board.id}`} role="tab" aria-controls="workspace-panel" aria-selected={active.id === board.id} tabIndex={active.id === board.id ? 0 : -1} onClick={() => switchWorkspace(board.id)} onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next = layout.workspaces[(index + offset + layout.workspaces.length) % layout.workspaces.length];
        switchWorkspace(next.id, false); document.getElementById(`workspace-tab-${next.id}`)?.focus();
      }}>{board.url ? <Globe size={15}/> : <LayoutGrid size={15}/>}<span className="workspace-tab-name">{board.name}</span><span>{board.url ? '网页' : board.widgets.length}</span></button>)}
    </div><button className="workspace-add-tab icon-button" aria-label="新建工作区" disabled={layout.workspaces.length >= layoutLimits.workspaces} onClick={() => {setName(''); setTemplateId(''); setWebsite(''); setWebPreset(''); setWorkspaceType('components'); setFormError(''); setDialog('create');}}><Plus size={18}/></button></div>

    <div className="workspace-heading"><div><div className="eyebrow">属于你的工作方式</div><h1>{active.name}</h1><p>{active.url ? (api.desktop ? '点击工作区标签，在 Edge 中打开现有网页工具。' : '点击工作区标签，在新页面打开现有网页工具。') : '选择一个组件，打开独立的工作界面。'}</p></div>
      <div className="workspace-heading-actions"><button className="button" onClick={() => {setName(active.name); setWebsite(active.url || ''); setWorkspaceType(active.url ? 'web' : 'components'); setFormError(''); setDialog('edit');}}><Pencil size={14}/>管理工作区</button>{active.url ? <button className="button primary" disabled={ctx.busy} onClick={() => activateWebWorkspace(active)}><ArrowUpRight size={15}/>{api.desktop ? '用 Edge 打开' : '打开网页'}</button> : <button className="button primary" disabled={active.widgets.length >= layoutLimits.widgets} onClick={() => setDialog('catalog')}><Plus size={15}/>添加组件</button>}</div>
    </div>

    <div className="workspace-controls"><div className="workspace-save-status" role="status">{saveStatus === 'saved' ? <><Check size={13}/>布局已保存</> : saveStatus === 'saving' ? '正在保存布局…' : saveStatus === 'editing' ? '正在调整大小…' : <><span>布局未保存</span><button className="text-button" onClick={() => {if (latest.current) persist(latest.current);}}>重试保存</button></>}</div>
      <span className="workspace-layout-hint">{active.url ? '网页地址已保存 · 工具在浏览器中独立运行' : '点击入口打开组件 · 拖动手柄调整顺序'}</span>
      {!active.url && <div className="workspace-zoom"><button className="icon-button" aria-label="缩小工作区" disabled={active.zoom <= 60} onClick={() => updateBoard(board => ({...board, zoom: clampZoom(board.zoom - 10)}))}><ZoomOut size={16}/></button><input type="range" aria-label="工作区缩放" min={60} max={140} step={10} value={active.zoom} onChange={event => updateBoard(board => ({...board, zoom: Number(event.target.value)}))}/><output>{active.zoom}%</output><button className="icon-button" aria-label="放大工作区" disabled={active.zoom >= 140} onClick={() => updateBoard(board => ({...board, zoom: clampZoom(board.zoom + 10)}))}><ZoomIn size={16}/></button><button className="icon-button" aria-label="恢复实际大小" onClick={() => updateBoard(board => ({...board, zoom: 100}))}><RotateCcw size={14}/></button><button className="text-button" onClick={() => updateBoard(board => ({...board, zoom: clampZoom(Math.min(100, (viewport.current?.clientWidth || 960) / 960 * 100))}))}>适合窗口</button></div>}
    </div>
    {saveStatus === 'error' && <p className="workspace-save-error" role="alert">{saveError} 当前布局仍在本窗口中，请重试保存。</p>}

    <div className="workspace-viewport" ref={viewport} id="workspace-panel" role="tabpanel" aria-labelledby={`workspace-tab-${active.id}`}>
      {active.url ? <div className="web-workspace" aria-label="网页工作区"><span className="web-workspace-icon"><Globe size={34}/></span><h2>{api.desktop ? '在 Edge 中使用此工作区' : '在新页面使用此工作区'}</h2><code>{active.url}</code><p>{openedWebsite === active.id ? (api.desktop ? '已请求 Edge 打开，请到 Edge 中确认页面。' : '已请求打开，请在新页面查看看板。') : '打开已有网页工具，继续使用它自己的看板和数据。'}</p><button className="button primary" disabled={ctx.busy} onClick={() => activateWebWorkspace(active)}><ArrowUpRight size={16}/>{api.desktop ? '用 Edge 打开网页' : '打开网页工作区'}</button></div> : <>
      <div className="workspace-launchers" style={{zoom: scale}}>
        {active.widgets.map((widget, index) => {
          const definition = findWidget(widget.type);
          const Icon = definition?.icon || Puzzle;
          return <article key={widget.id} className={`workspace-launcher ${dropTarget === widget.id ? 'widget-drop-target' : ''}`} aria-label={`入口：${widget.title}`}
            onDragOver={event => {if (dragging.current) {event.preventDefault(); setDropTarget(widget.id);}}}
            onDrop={event => {event.preventDefault(); const from = dragging.current; dragging.current = null; setDropTarget(null); if (from) updateBoard(board => moveWidget(board, from, widget.id));}}>
            <button className="workspace-launcher-open" aria-label={`打开组件：${widget.title}`} onClick={() => {setFocusMode('expanded'); setFocusedId(widget.id);}}>
              <span className="workspace-launcher-icon"><Icon size={26}/></span><strong>{widget.title}</strong><p>{definition?.description || '组件尚未接入，配置已保留。'}</p><span className="workspace-launcher-link">打开界面 <ArrowUpRight size={13}/></span>
            </button>
            <div className="workspace-launcher-actions"><button className="widget-drag-handle icon-button" draggable aria-label={`拖动组件：${widget.title}`} onDragStart={event => {dragging.current = widget.id; event.dataTransfer.setData('application/x-northstar-widget', widget.id); event.dataTransfer.effectAllowed = 'move';}} onDragEnd={() => {dragging.current = null; setDropTarget(null);}}><Grip size={14}/></button>
              <button className="icon-button" disabled={index === 0} aria-label={`前移组件：${widget.title}`} onClick={() => reorder(widget.id, -1)}><ArrowLeft size={12}/></button><button className="icon-button" disabled={index === active.widgets.length-1} aria-label={`后移组件：${widget.title}`} onClick={() => reorder(widget.id, 1)}><ArrowRight size={12}/></button>
              <button className="icon-button" aria-label={`设置组件：${widget.title}`} onClick={() => setSettingsId(widget.id)}><Settings2 size={14}/></button><button className="icon-button" aria-label={`移除组件：${widget.title}`} title="移除入口，保留业务记录" onClick={() => updateBoard(board => ({...board, widgets: board.widgets.filter(item => item.id !== widget.id)}))}><X size={15}/></button>
            </div>
          </article>;
        })}
      </div>
      {!active.widgets.length && <div className="workspace-empty"><span><LayoutGrid size={35}/></span><h2>从一个组件开始</h2><p>添加任务、笔记或画板，组合出适合自己的工作区。</p><button className="button primary" onClick={() => setDialog('catalog')}><Plus size={16}/>选择组件</button></div>}
      </>}
    </div>

    {focus && ctx.page === 'workspaces' && (() => {
      const definition = findWidget(focus.type);
      const available = definition && definition.version === focus.version;
      return <WidgetWindow key={focus.id} title={focus.title} initial={focus.window}
        preferred={{width: Math.max(560, focus.columns * 90), height: Math.max(400, focus.height + 80)}}
        minimum={{width: Math.max(320, (definition?.minSize.columns || 4) * 80), height: (definition?.minSize.height || 240) + 80}}
        onChange={window => updateBoard(board => ({...board, widgets: board.widgets.map(widget => widget.id === focus.id ? {...widget, window} : widget)}))}
        onClose={() => setFocusedId(null)} toolbar={<>
          <button className="icon-button" aria-label={`设置组件：${focus.title}`} onClick={() => setSettingsId(focus.id)}><Settings2 size={15}/></button>
          {available && (definition.page || definition.fullView) && <button className="icon-button" aria-label={`打开完整功能：${focus.title}`} onClick={() => {if (definition.fullView) setFocusMode('full'); else if (definition.page) {setFocusedId(null); ctx.navigate(definition.page);}}}><ArrowUpRight size={15}/></button>}
        </>}>
        <article className="workspace-widget widget-window-content" aria-label={`组件：${focus.title}`}><div className="widget-body"><WidgetBoundary>{available ? <WidgetContent definition={definition} widget={focus} full={focusMode === 'full'}/> : <div className="widget-unavailable"><Puzzle size={28}/><h3>组件暂不可用</h3><p>组件 {focus.type}（配置版本 {focus.version}）尚未接入或需要兼容版本，配置已保留。</p></div>}</WidgetBoundary></div></article>
      </WidgetWindow>;
    })()}

    {dialog === 'catalog' && <Modal title="添加组件" subtitle="组件可以重复添加，每个实例有自己的设置。" onClose={() => setDialog(null)}><div className="widget-catalog">{widgetRegistry.map(definition => <button key={definition.type} disabled={active.widgets.length >= layoutLimits.widgets} onClick={() => {updateBoard(board => ({...board, widgets: [...board.widgets, createWidget(definition)]})); setFocusedId(null); setDialog(null);}}><span><definition.icon size={23}/></span><div><h3>{definition.title}</h3><p>{definition.description}</p></div><Plus size={18}/></button>)}</div></Modal>}

    {(dialog === 'create' || dialog === 'template') && <Modal title={dialog === 'create' ? '新建工作区' : '保存为工作区模板'} subtitle={dialog === 'template' ? '保存布局与组件设置，业务记录仍由原模块管理。' : '从空白开始，或使用自己保存的模板。'} onClose={() => setDialog(null)}>
      <form onSubmit={event => {event.preventDefault(); if (dialog === 'create') createWorkspace(); else {change(current => ({...current, templates: [...current.templates, cloneWorkspace(active, name)]})); setDialog(null);}}}>
        <label className="field"><span>{dialog === 'create' ? '工作区名称' : '模板名称'}</span><input data-autofocus required maxLength={60} value={name} onChange={event => setName(event.target.value)}/></label>
        {dialog === 'create' && <><label className="field"><span>工作区类型</span><select aria-label="工作区类型" value={workspaceType} onChange={event => {setWorkspaceType(event.target.value as 'components'|'web'); setTemplateId(''); setFormError('');}}><option value="components">组件工作区</option><option value="web">网页工作区（Edge）</option></select></label>
          <label className="field"><span>起始布局</span><select aria-label="起始布局" value={templateId} onChange={event => {setTemplateId(event.target.value); const template = layout.templates.find(item => item.id === event.target.value); if (template?.url) setWebsite(template.url);}}><option value="">空白工作区</option>{layout.templates.filter(template => !!template.url === (workspaceType === 'web')).map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          {workspaceType === 'web' && <><label className="field"><span>现有工具</span><select aria-label="现有工具" value={webPreset} onChange={event => {setWebPreset(event.target.value); const preset = webWorkspacePresets.find(item => item.url === event.target.value); if (preset) {setName(preset.name); setWebsite(preset.url);}}}><option value="">自定义网页地址</option>{webWorkspacePresets.map(preset => <option key={preset.url} value={preset.url}>{preset.name}</option>)}</select></label><label className="field"><span>网页地址</span><input required type="url" maxLength={2048} placeholder="http://127.0.0.1:8765/" value={website} onChange={event => {setWebsite(event.target.value); setWebPreset('');}}/></label></>}
        </>}
        {formError && <p role="alert" className="workspace-save-error">{formError}</p>}
        <div className="modal-footer"><button type="button" className="button" onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={!name.trim()}>{dialog === 'create' ? '创建工作区' : '保存模板'}</button></div>
      </form>
    </Modal>}

    {dialog === 'edit' && <Modal title="管理工作区" onClose={() => setDialog(null)}><form onSubmit={event => {event.preventDefault(); let url: string|undefined; if (workspaceType === 'web') {try {url = webWorkspaceUrl(website);} catch (error) {setFormError(String(error)); return;}} updateBoard(board => {const updated = {...board, name: name.trim()}; if (url) updated.url = url; else delete updated.url; return updated;}); setDialog(null);}}>
      <label className="field"><span>工作区名称</span><input data-autofocus required maxLength={60} value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>工作区类型</span><select aria-label="工作区类型" value={workspaceType} onChange={event => setWorkspaceType(event.target.value as 'components'|'web')}><option value="components">组件工作区</option><option value="web">网页工作区（Edge）</option></select></label>{workspaceType === 'web' && <label className="field"><span>网页地址</span><input required type="url" maxLength={2048} value={website} onChange={event => setWebsite(event.target.value)}/></label>}{formError && <p className="workspace-save-error" role="alert">{formError}</p>}<div className="workspace-management-actions">
        <button className="button" type="button" disabled={layout.workspaces.length >= layoutLimits.workspaces} onClick={() => {const clone = cloneWorkspace(active, `${active.name.slice(0,55)} 副本`); change(current => ({...current, activeId: clone.id, workspaces: [...current.workspaces, clone]})); setFocusedId(null); setDialog(null);}}><Copy size={14}/>复制工作区</button>
        <button className="button" type="button" disabled={layout.templates.length >= layoutLimits.templates} onClick={() => {setName(active.name); setDialog('template');}}><LayoutGrid size={14}/>保存为模板</button>
        <button className="button workspace-delete" type="button" disabled={layout.workspaces.length <= 1} onClick={() => setDialog('delete')}><Trash2 size={14}/>删除工作区</button></div>
      {layout.templates.length > 0 && <div className="workspace-template-list"><h3>已保存的模板</h3>{layout.templates.map(template => <div key={template.id}><span>{template.name}</span><button type="button" className="icon-button" aria-label={`删除模板：${template.name}`} onClick={() => change(current => ({...current, templates: current.templates.filter(item => item.id !== template.id)}))}><Trash2 size={14}/></button></div>)}</div>}
      <div className="modal-footer"><button type="button" className="button" onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={!name.trim()}>保存工作区名称</button></div>
    </form></Modal>}

    {dialog === 'delete' && <Modal title="删除这个工作区？" subtitle="只删除布局与组件配置，任务、笔记和画板记录继续保留。" onClose={() => setDialog(null)}><p>将删除“{active.name}”。</p><div className="modal-footer"><button className="button" onClick={() => setDialog(null)}>取消</button><button className="button primary" onClick={() => {change(current => {const workspaces = current.workspaces.filter(board => board.id !== current.activeId); return {...current, workspaces, activeId: workspaces[0].id};}); setFocusedId(null); setDialog(null);}}>确认删除工作区</button></div></Modal>}

    {settings && <WidgetSettings key={settings.id} initial={settings} onClose={() => setSettingsId(null)} onSave={widget => {updateBoard(board => ({...board, widgets: board.widgets.map(item => item.id === widget.id ? widget : item)})); setSettingsId(null);}}/>}
  </section>;
}
