import {describe,it,expect} from 'vitest';
import {habitStats,journalSummary,makeRecord,shiftDay,type Habit} from './domain';
const habit=(dates:string[],start='2026-09-25')=>({...makeRecord('habit'),title:'阅读',startDate:start,checkIns:Object.fromEntries(dates.map(day=>[day,'2026-10-03T10:00:00Z']))}) as Habit;
describe('habit history',()=>{
 it('retains yesterday’s streak while today is still in progress',()=>{expect(habitStats(habit(['2026-10-01','2026-10-02']),'2026-10-03').streak).toBe(2);expect(habitStats(habit(['2026-10-01','2026-10-02','2026-10-03']),'2026-10-03').streak).toBe(3);});
 it('resets after a gap and recalculates when a missing day is filled',()=>{const h=habit(['2026-09-30','2026-10-01','2026-10-03']);expect(habitStats(h,'2026-10-03').streak).toBe(1);expect(habitStats(h,'2026-10-03').longest).toBe(2);h.checkIns['2026-10-02']='2026-10-03T10:00:00Z';expect(habitStats(h,'2026-10-03').streak).toBe(4);delete h.checkIns['2026-10-01'];expect(habitStats(h,'2026-10-03').streak).toBe(2);expect(habitStats(h,'2026-10-03').total).toBe(3);});
 it('does not invent missed days before a habit starts',()=>{const stats=habitStats(habit(['2026-10-03'],'2026-10-03'),'2026-10-03');expect(stats.weekTotal).toBe(1);expect(stats.weekRate).toBe(100);expect(habitStats(habit([]),'2026-10-03').longest).toBe(0);});
 it('uses calendar days across month, year and leap-day boundaries',()=>{expect(shiftDay('2026-12-31',1)).toBe('2027-01-01');expect(shiftDay('2024-03-01',-1)).toBe('2024-02-29');expect(habitStats(habit(['2026-12-31','2027-01-01'],'2026-12-31'),'2027-01-01').streak).toBe(2);});
 it('includes signed habits in the selected daily summary and preserves archived history',()=>{const h={...habit(['2026-10-02']),archived:true};expect(journalSummary([h],'2026-10-02').body).toContain('当日习惯签到\n• 阅读');expect(journalSummary([h],'2026-10-03').habits).toHaveLength(0);});
});
