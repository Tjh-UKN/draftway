export interface ReviewReport {repository?:string;round_status?:string;started_at?:string;counts?:{approved?:number;posted?:number};pulls:{pr:number;title?:string;status:string;approved?:{body?:string;path?:string;line?:number}[];errors?:string[]}[]}
export function parseReviewReport(value:unknown):ReviewReport {
  const report=value as ReviewReport;const fail=()=>{throw Error('报告格式不兼容，请打开原看板查看。');};
  if(!report||!Array.isArray(report.pulls)||['repository','round_status','started_at'].some(key=>Object.hasOwn(report,key)&&typeof (report as unknown as Record<string,unknown>)[key]!=='string'))return fail();
  if(report.counts!==undefined&&(!report.counts||['approved','posted'].some(key=>{const value=report.counts?.[key as 'approved'];return value!==undefined&&(!Number.isInteger(value)||value<0);})))return fail();
  for(const pr of report.pulls){if(!pr||!Number.isInteger(pr.pr)||pr.pr<1||typeof pr.status!=='string'||(pr.title!==undefined&&typeof pr.title!=='string')||(pr.errors!==undefined&&(!Array.isArray(pr.errors)||pr.errors.some(s=>typeof s!=='string')))||(pr.approved!==undefined&&(!Array.isArray(pr.approved)||pr.approved.some(f=>!f||(f.body!==undefined&&typeof f.body!=='string')||(f.path!==undefined&&typeof f.path!=='string')||(f.line!==undefined&&(!Number.isInteger(f.line)||f.line<0))))))return fail();}
  return report;
}
