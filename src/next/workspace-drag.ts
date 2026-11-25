import {useRef, useState, type HTMLAttributes} from 'react';
import type {WorkspaceNeighbor} from './workspace-groups';

interface Destination {
  groupId: string;
  neighbor?: WorkspaceNeighbor;
}

interface PointerDrag {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
}

function destinationAt(list: HTMLElement, id: string, x: number, y: number): Destination | undefined {
  const target = document.elementFromPoint(x, y);
  if (!target || !list.contains(target)) return;
  const groupId = target.closest<HTMLElement>('[data-workspace-drop-group]')?.dataset.workspaceDropGroup;
  const row = target.closest<HTMLElement>('[data-workspace-id]');
  if (row?.dataset.workspaceId) {
    if (row.dataset.workspaceId === id) return;
    const bounds = row.getBoundingClientRect();
    return {groupId: groupId ?? '', neighbor: {id: row.dataset.workspaceId, position: y < bounds.top + bounds.height / 2 ? 'before' : 'after'}};
  }
  if (groupId !== undefined) return {groupId};
  if (target.closest('[data-workspace-drop-ungrouped]')) return {groupId: ''};
}

export function useWorkspaceDrag(disabled: boolean, onMove: (id: string, destination: Destination) => void) {
  const pointer = useRef<PointerDrag | null>(null);
  const cursor = useRef({x: 0, y: 0});
  const scrollFrame = useRef(0);
  const blockClick = useRef(false);
  const [dragging, setDragging] = useState<string>();
  const [destination, setDestination] = useState<Destination>();

  function updateDestination(list: HTMLElement, id: string, x: number, y: number) {
    const next = destinationAt(list, id, x, y);
    setDestination(old => old?.groupId === next?.groupId && old?.neighbor?.id === next?.neighbor?.id &&
      old?.neighbor?.position === next?.neighbor?.position ? old : next);
  }

  function scrollWhileDragging(list: HTMLElement) {
    const drag = pointer.current;
    if (!drag?.started) return;
    if (!list.isConnected) {finish(list);return;}
    const {x, y} = cursor.current;
    const bounds = list.getBoundingClientRect();
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      const distance = y - bounds.top < 28 ? y - bounds.top - 28 : Math.max(0, y - bounds.bottom + 28);
      if (distance) {
        const previous = list.scrollTop;
        list.scrollTop += Math.sign(distance) * Math.ceil(Math.abs(distance) / 3);
        if (list.scrollTop !== previous) updateDestination(list, drag.id, x, y);
      }
    }
    scrollFrame.current = requestAnimationFrame(() => scrollWhileDragging(list));
  }

  function finish(list: HTMLElement) {
    const drag = pointer.current;
    if (!drag) return;
    pointer.current = null;
    cancelAnimationFrame(scrollFrame.current);
    if (list.hasPointerCapture(drag.pointerId)) list.releasePointerCapture(drag.pointerId);
    if (drag.started) {
      blockClick.current = true;
      requestAnimationFrame(() => {blockClick.current = false;});
      setDragging(undefined);
      setDestination(undefined);
    }
  }

  const handlers: HTMLAttributes<HTMLElement> = {
    onPointerDown(event) {
      const target = event.target as Element;
      if (disabled || event.button !== 0 || !event.isPrimary ||
          (event.pointerType === 'touch' && !target.closest('[data-workspace-grip]'))) return;
      const id = target.closest<HTMLElement>('[data-workspace-draggable]')?.dataset.workspaceId;
      if (id) pointer.current = {id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false};
    },
    onPointerMove(event) {
      const drag = pointer.current;
      if (disabled || drag?.pointerId !== event.pointerId) return;
      const list = event.currentTarget;
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.started = true;
        list.setPointerCapture(event.pointerId);
        setDragging(drag.id);
        scrollFrame.current = requestAnimationFrame(() => scrollWhileDragging(list));
      }
      event.preventDefault();
      cursor.current = {x: event.clientX, y: event.clientY};
      updateDestination(list, drag.id, event.clientX, event.clientY);
    },
    onPointerUp(event) {
      const drag = pointer.current;
      if (drag?.pointerId !== event.pointerId) return;
      const next = drag.started && !disabled ? destinationAt(event.currentTarget, drag.id, event.clientX, event.clientY) : undefined;
      finish(event.currentTarget);
      if (next) onMove(drag.id, next);
    },
    onPointerLeave(event) {if (!pointer.current?.started) finish(event.currentTarget);},
    onPointerCancel(event) {if (pointer.current?.pointerId === event.pointerId) finish(event.currentTarget);},
    onLostPointerCapture(event) {if (pointer.current?.pointerId === event.pointerId) finish(event.currentTarget);},
    onKeyDownCapture(event) {
      if (event.key === 'Escape' && pointer.current?.started) {
        event.stopPropagation();
        event.preventDefault();
        finish(event.currentTarget);
      }
    },
    onClickCapture(event) {
      if (!blockClick.current) return;
      blockClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  return {handlers, dragging, destination};
}
