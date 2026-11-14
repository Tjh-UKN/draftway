export const businessComponents = [
  {id:'overview',title:'个人总览'}, {id:'planning',title:'目标与项目'}, {id:'tasks',title:'事项备忘'},
  {id:'issues',title:'问题跟踪'}, {id:'journal',title:'工作记录与复盘'}, {id:'knowledge',title:'知识笔记'},
  {id:'habits',title:'习惯养成'}, {id:'health',title:'健康记录'}, {id:'calendar',title:'日历'},
  {id:'drawings',title:'自由画板'}, {id:'files',title:'文件柜'}, {id:'archive',title:'归档'}, {id:'settings',title:'数据与设置'},
] as const;
export type BusinessPage = typeof businessComponents[number]['id'];
export function isBusinessPage(value: unknown): value is BusinessPage {return businessComponents.some(item=>item.id===value);}
