import {PenTool, Plus} from 'lucide-react';
import {useWorkbench} from '../workbench';
import {dateLabel, type Drawing} from '../domain';
import {Empty} from '../components';
import ProjectFilter from './ProjectFilter';
import type {WidgetDefinition, WidgetSettingsProps} from './types';

function DrawingsWidget({config}: Pick<WidgetSettingsProps, 'config'>) {
  const ctx = useWorkbench();
  const drawings = ctx.data.records.filter((record): record is Drawing => record.kind === 'drawing' && !record.archived
    && (!config.projectId || record.projectId === config.projectId)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  return <><div className="widget-summary"><span>{drawings.length} 块画板</span><button className="text-button" onClick={() => ctx.create('drawing', config.projectId || undefined)}><Plus size={14}/>新建画板</button></div>
    <div className="widget-drawings">{drawings.map(drawing => <button key={drawing.id} onClick={() => ctx.edit(drawing)}><PenTool size={22}/><strong>{drawing.title}</strong><small>{dateLabel(drawing.updatedAt)}</small></button>)}</div>
    {!drawings.length && <Empty icon={<PenTool size={24}/>} heading="把思路画下来" description="创建画板后，可以从这里继续编辑。"/>}</>;
}

export const drawingsWidget: WidgetDefinition = {
  type: 'drawings', version: 1, title: '自由画板', description: '打开与编辑已有画板，或创建新画板。', icon: PenTool, page: 'drawings',
  defaultSize: {columns: 12, height: 280}, minSize: {columns: 4, height: 240}, defaultConfig: {projectId: ''},
  render: config => <DrawingsWidget config={config}/>, Settings: ProjectFilter,
};
