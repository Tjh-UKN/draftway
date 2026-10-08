export function markdownUrl(value:string,image=false):string {
  if(!image&&value.startsWith('#'))return value;
  if(image&&/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(value))return value;
  try {
    const url=new URL(value);
    if(url.username||url.password)return '';
    if(image)return url.protocol==='https:'?url.href:'';
    return ['http:','https:','mailto:'].includes(url.protocol)?url.href:'';
  }catch{return '';}
}
export type MarkdownAction='heading'|'bold'|'italic'|'list'|'checklist'|'quote'|'code'|'link'|'table';
export function insertMarkdown(value:string,start:number,end:number,action:MarkdownAction){
  const selected=value.slice(start,end);let replacement='';let offset=0;let length=0;
  const wrap=(before:string,after:string,hint:string)=>{const content=selected||hint;replacement=before+content+after;offset=before.length;length=content.length;};
  switch(action){
    case 'heading':wrap('## ','','标题');break;
    case 'bold':wrap('**','**','加粗文字');break;
    case 'italic':wrap('*','*','强调文字');break;
    case 'list':wrap('- ','','列表项');break;
    case 'checklist':wrap('- [ ] ','','待办事项');break;
    case 'quote':wrap('> ','','引用内容');break;
    case 'code':wrap('```text\n','\n```','代码内容');break;
    case 'link':wrap('[','](https://example.com)','链接文字');break;
    case 'table':replacement='| 项目 | 说明 |\n| --- | --- |\n| 内容 | 内容 |';offset=2;length=2;break;
  }
  if(['heading','list','checklist','quote','code','table'].includes(action)&&start>0&&value[start-1]!=='\n'){replacement='\n'+replacement;offset++;}
  return {value:value.slice(0,start)+replacement+value.slice(end),start:start+offset,end:start+offset+length};
}
