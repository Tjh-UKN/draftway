import {describe,it,expect} from 'vitest';
import {advanceRepeat,dateKey,isToday,makeRecord,overdue,progress,sortTasks,toggleTask,type Task} from './domain';
const task=()=>makeRecord('task') as Task;
describe('task scheduling',()=>{
 it('compares local calendar dates and leaves undated tasks out of today',()=>{const now=new Date(2026,9,2,12);expect(isToday(new Date(2026,9,2,1).toISOString(),now)).toBe(true);expect(isToday(null,now)).toBe(false);expect(dateKey(now)).toBe('2026-10-02');});
 it('only flags unfinished past tasks as overdue',()=>{const now=new Date('2026-10-02T12:00:00+08:00');const t={...task(),dueAt:'2026-10-01T12:00:00+08:00'};expect(overdue(t,now)).toBe(true);expect(overdue({...t,status:'done'},now)).toBe(false);expect(overdue(task(),now)).toBe(false);});
 it('clamps month-end recurrence instead of skipping February',()=>{const date=new Date(2026,0,31,9);const next=new Date(advanceRepeat(date.toISOString(),'monthly'));expect(next.getMonth()).toBe(1);expect(next.getDate()).toBe(28);expect(next.getHours()).toBe(9);});
 it('keeps high-priority unfinished tasks ahead of completed tasks',()=>{const a={...task(),priority:'high' as const,status:'done' as const};const b={...task(),priority:'normal' as const};const c={...task(),priority:'high' as const};expect(sortTasks([a,b,c]).map(t=>t.id)).toEqual([c.id,b.id,a.id]);});
 it('completion creates a timestamp and reopening clears it',()=>{const completed=toggleTask(task());expect(completed.status).toBe('done');expect(completed.completedAt).toBeTruthy();expect(toggleTask(completed).completedAt).toBeNull();expect(progress([completed,task()])).toEqual({done:1,total:2,percent:50});});
});
