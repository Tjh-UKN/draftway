import {BookOpen, Plus} from 'lucide-react';
import {useWorkbench} from '../workbench';
import {dateLabel, makeRecord, type Note} from '../domain';
import {Empty} from '../components';
import ProjectFilter from './ProjectFilter';
import type {WidgetDefinition, WidgetSettingsProps} from './types';

function Settings(props: WidgetSettingsProps) {
  return <><ProjectFilter {...props}/><label className="field"><span>标签筛选</span><input maxLength={80} placeholder="留空显示全部笔记" value={props.config.tag || ''} onChange={event => props.onChange({...props.config, tag: event.target.value})}/></label></>;
}

function NotesWidget({config}: Pick<WidgetSettingsProps, 'config'>) {
  const ctx = useWorkbench();
  const notes = ctx.data.records.filter((record): record is Note => record.kind === 'note' && !record.archived
    && (!config.projectId || record.projectId === config.projectId) && (!config.tag || record.tags.includes(config.tag)))
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  function create() {
    const note = makeRecord('note') as Note;
    note.projectId = config.projectId || null;
    note.tags = config.tag ? [config.tag] : [];
    ctx.edit(note);
  }
  return <><div className="widget-summary"><span>{notes.length} 篇笔记</span><button className="text-button" onClick={create}><Plus size={14}/>写笔记</button></div>
    <div className="widget-record-list">{notes.map(note => <button key={note.id} onClick={() => ctx.edit(note)}><strong>{note.title}</strong><p>{note.body.slice(0,140) || '空白笔记'}</p><small>{dateLabel(note.updatedAt)}{note.tags.length ? ` · ${note.tags.join(' / ')}` : ''}</small></button>)}</div>
    {!notes.length && <Empty icon={<BookOpen size={24}/>} heading="为想法留一页" description="笔记会保存在知识整理中，其他组件也能查看。"/>}</>;
}

export const notesWidget: WidgetDefinition = {
  type: 'notes', version: 1, title: '知识笔记', description: '收集笔记与复盘，可按项目和标签筛选。', icon: BookOpen, page: 'knowledge',
  defaultSize: {columns: 6, height: 400}, minSize: {columns: 4, height: 240}, defaultConfig: {projectId: '', tag: ''},
  render: config => <NotesWidget config={config}/>, Settings,
};
