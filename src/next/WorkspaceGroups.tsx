import {useState, type MouseEvent, type ReactNode} from 'react';
import {ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal} from 'lucide-react';
import {Dialog} from './ui';
import type {WorkspaceGroup} from './workspace-groups';
import './workspace-groups.css';

export function WorkspaceGroupEntry({group, active, dropping, canRename, children, onToggle, onRename, onMenu}: {
  group: WorkspaceGroup;
  active: boolean;
  dropping?: boolean;
  canRename: boolean;
  children: ReactNode;
  onToggle: () => void;
  onRename: () => void;
  onMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const expanded = !group.collapsed;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const Icon = expanded ? FolderOpen : Folder;
  const contentId = 'workspace-group-' + group.id;
  return <section className="workspace-group" aria-label={group.name} data-workspace-drop-group={group.id}>
    <div className={'workspace-group-header' + (active && !expanded ? ' active' : '')} data-workspace-group-id={group.id}
      data-workspace-drop-target={dropping || undefined}>
      <button type="button" className="workspace-group-toggle" aria-expanded={expanded} aria-controls={contentId} title={group.name}
        onClick={onToggle} onDoubleClick={() => {if (canRename) onRename();}} onKeyDown={event => {
          if (event.key === 'F2' && canRename) {event.preventDefault(); event.stopPropagation(); onRename();}
        }}><Chevron size={13}/><Icon size={16}/><span>{group.name}</span></button>
      <button type="button" className="workspace-group-action" aria-label={'管理分组 ' + group.name} aria-haspopup="menu" title="管理分组"
        onClick={onMenu}><MoreHorizontal size={16}/></button>
    </div>
    <div id={contentId} className="workspace-group-children" hidden={!expanded}>{children}</div>
  </section>;
}

export function WorkspaceGroupField({groups, value, onChange}: {groups: WorkspaceGroup[]; value: string; onChange: (value: string) => void}) {
  return <label className="field">所属分组
    <select value={value} onChange={event => onChange(event.target.value)}>
      <option value="">顶层</option>
      {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select>
  </label>;
}

export function WorkspaceGroupDialog({group, groups, onSave, onClose}: {
  group?: WorkspaceGroup;
  groups: WorkspaceGroup[];
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(group?.name ?? '');
  const name = value.trim();
  const duplicate = groups.some(item => item.id !== group?.id && item.name.trim().toLowerCase() === name.toLowerCase());
  return <Dialog title={group ? '重命名分组' : '新建分组'} onClose={onClose}>
    <form onSubmit={event => {event.preventDefault(); if (name && !duplicate) onSave(name);}}>
      <label className="field">分组名称
        <input required maxLength={40} value={value} onChange={event => setValue(event.target.value)} onFocus={event => event.currentTarget.select()}/>
      </label>
      {duplicate && <p className="tool-error" role="alert">这个分组名称已经在用。</p>}
      <footer><button className="primary-button" disabled={!name || duplicate}>{group ? '保存名称' : '创建分组'}</button></footer>
    </form>
  </Dialog>;
}

export function MoveWorkspaceDialog({name, groups, currentGroup, onMove, onClose}: {
  name: string;
  groups: WorkspaceGroup[];
  currentGroup: string;
  onMove: (groupId: string) => void;
  onClose: () => void;
}) {
  const [groupId, setGroupId] = useState(currentGroup);
  return <Dialog title="移动到分组" onClose={onClose}>
    <form onSubmit={event => {event.preventDefault(); if (groupId !== currentGroup) onMove(groupId);}}>
      <p className="muted">{name}</p>
      <WorkspaceGroupField groups={groups} value={groupId} onChange={setGroupId}/>
      <footer><button className="primary-button" disabled={groupId === currentGroup}>移动工作区</button></footer>
    </form>
  </Dialog>;
}
