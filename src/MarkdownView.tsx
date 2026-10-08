import { useId } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { markdownUrl } from './markdown';
export default function MarkdownView({value,onOpenLink,className=''}:{value:string;onOpenLink?:(url:string)=>void;className?:string}){
 const prefix=`md-${useId().replace(/[^a-z\d]/gi,'')}-`;
 return <div className={`markdown-content ${className}`}>
  <Markdown remarkPlugins={[remarkGfm,remarkBreaks]} skipHtml remarkRehypeOptions={{clobberPrefix:prefix,footnoteLabel:'脚注',footnoteBackLabel:'返回正文'}} urlTransform={(url,key)=>markdownUrl(url,key==='src')} components={{
   a:({node:_,href,children,...props})=><a {...props} href={href||undefined} target={href?.startsWith('#')?undefined:'_blank'} rel="noopener noreferrer" onClick={e=>{
    if(!href){e.preventDefault();return;}
    if(href.startsWith('#')){e.preventDefault();try{const root=e.currentTarget.closest('.markdown-content');root?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({block:'nearest'});}catch{/* Malformed anchors remain inert. */}return;}
    if(onOpenLink){e.preventDefault();onOpenLink(href);}
   }}>{children}</a>,
   table:({node:_,children,...props})=><div className="markdown-table-wrap"><table {...props}>{children}</table></div>,
   img:({node:_,src,alt,...props})=>src?<img {...props} src={src} alt={alt||'笔记图片'} loading="lazy" referrerPolicy="no-referrer"/>:<span className="markdown-image-placeholder">图片：{alt||'未指定图片地址'}</span>,
  }}>{value}</Markdown>
 </div>;
}
