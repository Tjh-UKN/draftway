import {it,expect} from 'vitest';
import {parseReviewReport} from './review-report';
import {boundedText} from './text';
it('accepts report content and rejects incompatible findings before rendering',()=>{expect(parseReviewReport({pulls:[{pr:1,status:'complete',approved:[{body:'Finding'}]}]}).pulls).toHaveLength(1);for(const value of [{pulls:[{pr:1,status:'complete',approved:{}}]},{repository:{},pulls:[]},{pulls:[{pr:1,status:'complete',errors:'failure'}]}])expect(()=>parseReviewReport(value)).toThrow('报告格式不兼容');});
it('bounds Unicode titles without leaving a split surrogate in native JSON',()=>{const value=boundedText('a'+'🚀'.repeat(100),120);expect(value.length).toBe(119);expect([...value].at(-1)).toBe('🚀');expect(boundedText('\ud800',120)).toBe('�');});
