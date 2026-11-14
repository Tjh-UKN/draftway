import {tasksWidget} from './TasksWidget';
import {notesWidget} from './NotesWidget';
import {drawingsWidget} from './DrawingsWidget';
import type {WidgetDefinition} from './types';
import type {WidgetInstance, WorkspaceLayout} from '../workspace-layout';
import {webWorkspacePresets} from '../workspace-presets';

// New modules register here; the workspace shell never branches on business types.
export const widgetRegistry: readonly WidgetDefinition[] = [tasksWidget, notesWidget, drawingsWidget];
export const findWidget = (type: string) => widgetRegistry.find(definition => definition.type === type);
export function createWidget(definition: WidgetDefinition): WidgetInstance {
  return {id: crypto.randomUUID(), type: definition.type, version: definition.version, title: definition.title,
    ...definition.defaultSize, config: {...definition.defaultConfig}};
}
export function defaultWorkspaceLayout(): WorkspaceLayout {
  const id = crypto.randomUUID();
  return {version: 1, activeId: id, workspaces: [{id, name: '我的工作区', zoom: 100, widgets: widgetRegistry.map(createWidget)},
    ...webWorkspacePresets.map(preset => ({id:crypto.randomUUID(),name:preset.name,url:preset.url,zoom:100,widgets:[]}))], templates: []};
}
