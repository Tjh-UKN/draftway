import {invoke, isTauri} from '@tauri-apps/api/core';
import {open as openDialog} from '@tauri-apps/plugin-dialog';
import {FileText, Paperclip, X} from 'lucide-react';
import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject} from 'react';
import {chatFileKey, chatFileLimit, findFileMention, isChatFile, removeFileMention, type ChatFile} from './session-files';
import './session-files.css';

interface Props {
  id: string;
  enabled: boolean;
  files: ChatFile[];
  onChangeFiles: (files: ChatFile[]) => void;
  value: string;
  onChangeValue: (value: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
}

type FileMatch = ChatFile & {relativePath?: string};

interface Lookup {
  id: string;
  query: string;
  matches: FileMatch[];
  error?: string;
}

function errorText(error: unknown, fallback: string) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : fallback;
}

export function useSessionFiles({id, enabled, files, onChangeFiles, value, onChangeValue, input}: Props) {
  const native = typeof window !== 'undefined' && isTauri();
  const ready = native && enabled && files.length < chatFileLimit;
  const menuId = useId();
  const [selection, setSelection] = useState<{start: number; end: number} | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [index, setIndex] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [fileError, setFileError] = useState('');
  const pendingCaret = useRef<number | null>(null);
  const current = useRef({id, enabled, files, onChangeFiles});
  const picking = useRef(false);
  const mention = ready && selection ? findFileMention(value, selection.start, selection.end) : null;
  const mentionKey = mention ? `${mention.start}:${mention.end}:${mention.query}` : null;
  const query = mention && dismissed !== mentionKey ? mention.query : null;
  const result = lookup?.id === id && lookup.query === query ? lookup : null;
  const matches = result?.matches ?? [];
  const active = matches.length ? Math.min(index, matches.length - 1) : -1;

  function readSelection() {
    const field = input.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    setSelection(previous => previous?.start === start && previous.end === end ? previous : {start, end});
  }

  useLayoutEffect(() => {
    current.current = {id, enabled, files, onChangeFiles};
    return () => {current.current.enabled = false;};
  }, [id, enabled, files, onChangeFiles]);

  useLayoutEffect(() => {
    const field = input.current;
    if (field && pendingCaret.current !== null) {
      field.focus();
      field.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (ready && field && field === document.activeElement) readSelection();
    else setSelection(null);
  }, [input, ready, value]);

  useEffect(() => {
    if (dismissed !== mentionKey) setDismissed(null);
  }, [dismissed, mentionKey]);

  useEffect(() => {if (!files.length) setFileError('');}, [files.length]);

  useEffect(() => {
    if (query === null) return;
    let alive = true;
    setIndex(0);
    const timer = window.setTimeout(() => {
      void invoke<Omit<FileMatch, 'kind'>[]>('agent_file_suggestions', {id, query}).then(items => {
        if (alive) setLookup({id, query, matches: items.map(item => ({...item, kind: 'reference' as const})).filter(isChatFile)});
      }).catch(error => {
        if (alive) setLookup({id, query, matches: [], error: errorText(error, '无法查找文件')});
      });
    }, 70);
    return () => {alive = false; window.clearTimeout(timer);};
  }, [id, query]);

  function addFiles(added: ChatFile[]) {
    const known = new Set(current.current.files.map(chatFileKey));
    const next = [...current.current.files];
    let reachedLimit = false;
    for (const file of added) {
      const key = chatFileKey(file);
      if (known.has(key)) continue;
      if (next.length === chatFileLimit) {reachedLimit = true; break;}
      known.add(key);
      next.push(file);
    }
    setFileError(reachedLimit ? `每条消息最多添加 ${chatFileLimit} 个文件` : '');
    if (next.length !== current.current.files.length) current.current.onChangeFiles(next);
  }

  async function chooseAttachments() {
    if (!ready || picking.current) return;
    picking.current = true;
    setChoosing(true);
    setFileError('');
    try {
      const selected = await openDialog({title: '添加会话附件', multiple: true});
      if (!selected || current.current.id !== id || !current.current.enabled) return;
      const attachments = selected.map(path => ({kind: 'attachment' as const, path, name: path.split(/[\\/]/).at(-1) ?? ''}));
      addFiles(attachments.filter(isChatFile));
      if (attachments.some(file => !isChatFile(file))) setFileError('有文件无法添加，请检查文件名');
    } catch (error) {
      if (current.current.id === id && current.current.enabled) setFileError(errorText(error, '无法打开文件选择器'));
    } finally {
      picking.current = false;
      setChoosing(false);
    }
  }

  function selectReference({kind, path, name}: ChatFile) {
    const field = input.current;
    const token = field && findFileMention(field.value, field.selectionStart, field.selectionEnd);
    if (!mention || !token || token.start !== mention.start || token.end !== mention.end || token.query !== mention.query) return;
    addFiles([{kind, path, name}]);
    pendingCaret.current = mention.start;
    setSelection(null);
    onChangeValue(removeFileMention(value, mention));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === 'Escape') setDismissed(mentionKey);
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = (active + offset + matches.length) % matches.length;
      setIndex(next);
      document.getElementById(`${menuId}-${next}`)?.scrollIntoView({block: 'nearest'});
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && active >= 0) {
      selectReference(matches[active]);
    } else if (event.key !== 'Enter' || event.shiftKey || result) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return {
    textareaProps: {
      onFocus: readSelection,
      onSelect: readSelection,
      'aria-autocomplete': native ? 'list' as const : undefined,
      'aria-controls': query !== null ? menuId : undefined,
      'aria-activedescendant': active >= 0 ? `${menuId}-${active}` : undefined,
    },
    onBlur: () => {setSelection(null); setDismissed(null);},
    handleKeyDown,
    picker: native && <button type="button" className="icon-button" aria-label="添加会话附件"
      title={files.length < chatFileLimit ? '添加附件 · 输入 @ 引用工作目录中的文件' : `每条消息最多添加 ${chatFileLimit} 个文件`}
      disabled={!ready || choosing} onClick={() => {void chooseAttachments();}}><Paperclip size={15}/></button>,
    chips: <>{files.length > 0 && <ul className="session-file-chips" aria-label="本条消息的文件">{files.map(file => {
      const isReference = file.kind === 'reference';
      const Icon = isReference ? FileText : Paperclip;
      return <li key={chatFileKey(file)} title={file.path}><Icon size={13} aria-hidden="true"/>
        <span>{file.name}</span><button type="button" aria-label={`移除${isReference ? '引用' : '附件'} ${file.name}`}
          disabled={!enabled} onClick={() => {setFileError(''); onChangeFiles(files.filter(item => item !== file));}}><X size={13}/></button></li>;
    })}</ul>}{fileError && <div className="session-composer-file-error" role="alert">{fileError}</div>}</>,
    suggestions: query !== null && <div className="session-file-menu-anchor">
      <div className="session-file-suggestions">
        <div role="listbox" id={menuId} aria-label="工作目录文件">{matches.map((file, i) => (
          <div key={chatFileKey(file)} id={`${menuId}-${i}`} role="option" aria-selected={active === i} title={file.path}
            onMouseDown={event => event.preventDefault()} onClick={() => selectReference(file)}>
            <FileText size={14} aria-hidden="true"/><span>{file.name}{file.relativePath !== file.name && <small>{file.relativePath ?? file.path}</small>}</span>
          </div>
        ))}</div>
        {!matches.length && <div className="session-file-status" role="status">{result ? result.error || '没有匹配的文件' : '正在查找文件…'}</div>}
      </div>
    </div>,
  };
}
