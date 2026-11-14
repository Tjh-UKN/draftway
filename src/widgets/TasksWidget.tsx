import {Plus, SquareCheck} from 'lucide-react';
import {useWorkbench} from '../workbench';
import {sortTasks, toggleTask, type Task} from '../domain';
import {Empty, TaskRow} from '../components';
import ProjectFilter from './ProjectFilter';
import type {WidgetDefinition, WidgetSettingsProps} from './types';

function Settings(props: WidgetSettingsProps) {
  return <><ProjectFilter {...props}/><label className="field"><span>任务范围</span><select aria-label="任务范围" value={props.config.status || 'open'} onChange={event => props.onChange({...props.config, status: event.target.value})}>
    <option value="open">未完成</option><option value="all">全部任务</option><option value="done">已完成</option>
  </select></label></>;
}

function TasksWidget({config}: Pick<WidgetSettingsProps, 'config'>) {
  const ctx = useWorkbench();
  const tasks = sortTasks(ctx.data.records.filter((record): record is Task => record.kind === 'task' && !record.archived
    && (!config.projectId || record.projectId === config.projectId)
    && (config.status === 'all' || (config.status === 'done' ? record.status === 'done' : record.status !== 'done'))));
  return <><div className="widget-summary"><span>{tasks.length} 项任务</span><button className="text-button" onClick={() => ctx.create('task', config.projectId || undefined)}><Plus size={14}/>添加任务</button></div>
    {tasks.map(task => <TaskRow key={task.id} task={task} onEdit={() => ctx.edit(task)} onToggle={() => {void ctx.save(toggleTask(task));}} busy={ctx.busy}/>)}
    {!tasks.length && <Empty icon={<SquareCheck size={24}/>} heading="当前范围没有任务" description="添加任务，或在组件设置中调整范围。"/>}</>;
}

export const tasksWidget: WidgetDefinition = {
  type: 'tasks', version: 1, title: '事项备忘', description: '查看和完成任务，可按项目与完成状态筛选。', icon: SquareCheck, page: 'tasks',
  defaultSize: {columns: 6, height: 400}, minSize: {columns: 4, height: 240}, defaultConfig: {projectId: '', status: 'open'},
  render: config => <TasksWidget config={config}/>, Settings,
};
