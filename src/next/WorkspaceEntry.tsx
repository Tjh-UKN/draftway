import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import type {Workspace} from './core';
import {SpaceSymbol} from './ui';

export function WorkspaceEntry({space, active, editing, disabled, title, children, onOpen, onRename, onSave, onFinish}: {space: Workspace; active: boolean; editing: boolean; disabled: boolean; title: string; children?: ReactNode; onOpen: () => void; onRename: () => void; onSave: (name: string) => void; onFinish: () => void}) {
  return <div className={`workspace-sidebar-row ${active ? 'active' : ''} ${editing ? 'editing' : ''}`} data-workspace-id={space.id} aria-current={active ? 'page' : undefined}>
    {editing ? <><SpaceSymbol space={space}/><WorkspaceNameInput name={space.name} disabled={disabled} onSave={onSave} onFinish={onFinish}/></> : <button title={title} onClick={onOpen} onDoubleClick={() => {if (!disabled) onRename();}} onKeyDown={event => {if (event.key === 'F2' && !disabled) {event.preventDefault(); event.stopPropagation(); onRename();}}}><SpaceSymbol space={space}/><span>{space.name}</span>{children}</button>}
  </div>;
}

function WorkspaceNameInput({name, disabled, onSave, onFinish}: {name: string; disabled: boolean; onSave: (name: string) => void; onFinish: () => void}) {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useLayoutEffect(() => {input.current?.focus(); input.current?.select();}, []);
  function finish(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    if (save && !disabled && value.trim() && value.trim() !== name) onSave(value.trim());
    onFinish();
  }
  return <input ref={input} className="workspace-name-input" aria-label="重命名工作区" maxLength={40} value={value} onChange={event => setValue(event.target.value)} onBlur={() => finish(true)} onKeyDown={event => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') {event.preventDefault(); finish(event.key === 'Enter');}
  }}/>;
}
