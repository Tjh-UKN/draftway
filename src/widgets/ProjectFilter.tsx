import {useWorkbench} from '../workbench';
import type {WidgetSettingsProps} from './types';

export default function ProjectFilter({config, onChange}: WidgetSettingsProps) {
  const {data} = useWorkbench();
  return <label className="field"><span>关联项目</span><select aria-label="关联项目" value={config.projectId || ''} onChange={event => onChange({...config, projectId: event.target.value})}>
    <option value="">全部项目</option>
    {data.records.filter(record => record.kind === 'project' && !record.archived).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
  </select></label>;
}
