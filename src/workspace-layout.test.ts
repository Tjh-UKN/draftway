import {describe, expect, it} from 'vitest';
import {clampColumns, clampHeight, clampZoom, cloneWorkspace, fitWidgetWindow, moveWidget, parseWorkspaceLayout, webWorkspaceUrl} from './workspace-layout';
import {createWidget, defaultWorkspaceLayout, widgetRegistry} from './widgets';

describe('workspace composition and persistence contract', () => {
  it('creates valid defaults and independent instances from registered modules', () => {
    const layout = defaultWorkspaceLayout();
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(new Set(widgetRegistry.map(widget => widget.type)).size).toBe(widgetRegistry.length);
    const first = createWidget(widgetRegistry[0]);
    const second = createWidget(widgetRegistry[0]);
    first.config.projectId = 'a-project';
    expect(second.config.projectId).toBe('');
    expect(first.id).not.toBe(second.id);
  });

  it('clones only composition and configuration with independent IDs and settings', () => {
    const source = defaultWorkspaceLayout().workspaces[0];
    source.widgets[0].window = {x:100,y:120,width:640,height:480};
    const template = cloneWorkspace(source, '  我的模板  ');
    const copy = cloneWorkspace(template, '新工作区');
    expect(template.name).toBe('我的模板');
    expect(new Set([source.id, template.id, copy.id]).size).toBe(3);
    expect(copy.widgets.map(widget => widget.id)).not.toEqual(source.widgets.map(widget => widget.id));
    copy.widgets[0].config.projectId = 'another-project';
    expect(source.widgets[0].config.projectId).toBe('');
    expect(template.widgets[0].config.projectId).toBe('');
    expect(copy.widgets[0].type).toBe(source.widgets[0].type);
    copy.widgets[0].window!.x = 200;
    expect(source.widgets[0].window!.x).toBe(100);
  });

  it('reorders instances without losing configuration and ignores stale drag IDs', () => {
    const source = defaultWorkspaceLayout().workspaces[0];
    const reordered = moveWidget(source, source.widgets[0].id, source.widgets[2].id);
    expect(reordered.widgets).toEqual([source.widgets[1], source.widgets[2], source.widgets[0]]);
    expect(source.widgets[0].type).toBe('tasks');
    expect(moveWidget(source, 'missing', source.widgets[1].id)).toBe(source);
  });

  it('retains unavailable modules and their future configuration versions', () => {
    const layout = defaultWorkspaceLayout();
    layout.workspaces[0].widgets[0] = {...layout.workspaces[0].widgets[0], type: 'future.pr', version: 2, config: {repository: 'example/repo'}};
    expect(parseWorkspaceLayout(layout)).toEqual(layout);
  });

  it('rejects unsupported layouts, duplicate IDs, missing active workspaces and malformed geometry', () => {
    const source = defaultWorkspaceLayout();
    const invalid = [
      {...source, version: 2}, {...source, activeId: crypto.randomUUID()}, {...source, workspaces: []},
      {...source, workspaces: [source.workspaces[0], source.workspaces[0]]},
      {...source, templates: [source.workspaces[0], source.workspaces[0]]},
    ];
    for (const key of ['columns','height','version','config','type','title','id'] as const) {
      const layout = structuredClone(source);
      Object.assign(layout.workspaces[0].widgets[0], {[key]: {columns: 5, height: NaN, version: 0, config: {nested: {}}, type: '../bad', title: '', id: 'bad'}[key]});
      invalid.push(layout);
    }
    for (const layout of invalid) expect(() => parseWorkspaceLayout(layout)).toThrow();
    const duplicates = structuredClone(source);
    duplicates.workspaces[0].widgets.push(duplicates.workspaces[0].widgets[0]);
    expect(() => parseWorkspaceLayout(duplicates)).toThrow();
  });

  it('bounds zoom and resize without changing saved layout units', () => {
    expect([clampZoom(10), clampZoom(85), clampZoom(200)]).toEqual([60,90,140]);
    expect([clampColumns(0), clampColumns(7), clampColumns(20)]).toEqual([4,8,12]);
    expect([clampHeight(10), clampHeight(250.6), clampHeight(9999)]).toEqual([240,251,1200]);
    const layout = defaultWorkspaceLayout();
    const geometry = layout.workspaces[0].widgets.map(({columns, height}) => ({columns, height}));
    layout.workspaces[0].zoom = 60;
    expect(parseWorkspaceLayout(layout).workspaces[0].widgets.map(({columns,height}) => ({columns,height}))).toEqual(geometry);
  });

  it('fits remembered windows to smaller viewports and rejects malformed window metadata', () => {
    expect(fitWidgetWindow({x:2000,y:1500,width:900,height:700},{width:800,height:600})).toEqual({x:16,y:48,width:768,height:536});
    const small = fitWidgetWindow({x:-20,y:-20,width:100,height:100},{width:390,height:960});
    expect(small).toEqual({x:16,y:48,width:320,height:280});
    const layout = defaultWorkspaceLayout();
    layout.workspaces[0].widgets[0].window = {x:20,y:50,width:640,height:480};
    expect(parseWorkspaceLayout(layout)).toEqual(layout);
    for (const bad of [{x:-1,y:50,width:640,height:480},{x:20,y:50,width:9000,height:480},{x:20,y:50,width:640.5,height:480},null]) {
      expect(() => parseWorkspaceLayout({...layout,workspaces:[{...layout.workspaces[0],widgets:[{...layout.workspaces[0].widgets[0],window:bad}]}]})).toThrow();
    }
  });

  it('preserves and clones web workspaces while rejecting executable and credential-bearing URLs', () => {
    const layout = defaultWorkspaceLayout();
    const web = layout.workspaces.find(board => !!board.url)!;
    expect(web.url).toBe('http://127.0.0.1:8765/');
    expect(webWorkspaceUrl(' HTTPS://example.com/reviews?a=1&b=2 ')).toBe('https://example.com/reviews?a=1&b=2');
    const copy = cloneWorkspace(web, '检视工作区');
    expect(copy.url).toBe(web.url); expect(copy.id).not.toBe(web.id);
    expect(parseWorkspaceLayout(layout)).toEqual(layout);
    for (const url of ['javascript:alert(1)','file:///C:/data','data:text/html,test','mailto:a@b.com','microsoft-edge:https://example.com','https://user:password@example.com','', 'x'.repeat(2049)]) {
      expect(() => webWorkspaceUrl(url)).toThrow();
      expect(() => parseWorkspaceLayout({...layout,workspaces:[{...web,url}],activeId:web.id})).toThrow();
    }
  });
});
