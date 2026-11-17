import { memo,useId,useRef,type ReactNode,type ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { markdownUrl } from './markdown';
import CopyButton from './CopyButton';
import {localPath,localPathUrl,remarkLocalPaths} from './local-paths';
function ChatCode({children}:{children?:ReactNode}){const code=useRef<HTMLPreElement>(null);return <div className="chat-code-block"><pre ref={code}>{children}</pre><CopyButton text={()=>code.current?.textContent||''} label="复制代码"/></div>;}
const chatCodeComponents={pre:ChatCode};
export default memo(function MarkdownView({value,onOpenLink,onOpenLocalPath,className='',allowRemoteImages=true,codeActions=false}:{value:string;onOpenLink?:(url:string)=>void;onOpenLocalPath?:(path:string)=>void;className?:string;allowRemoteImages?:boolean;codeActions?:boolean}){
 const prefix=`md-${useId().replace(/[^a-z\d]/gi,'')}-`;
 return <div className={`markdown-content ${className}`}>
  <Markdown remarkPlugins={[remarkGfm,remarkBreaks,...(onOpenLocalPath?[remarkLocalPaths]:[])]} skipHtml remarkRehypeOptions={{clobberPrefix:prefix,footnoteLabel:'脚注',footnoteBackLabel:'返回正文'}} urlTransform={(url,key)=>{const path=key!=='src'&&onOpenLocalPath?localPath(url):null;return path?localPathUrl(path):markdownUrl(url,key==='src');}} components={{
   ...(codeActions?chatCodeComponents:{}),
   ...(onOpenLocalPath?{code:({node:_,children,className,...props}:{node?:unknown}&ComponentPropsWithoutRef<'code'>)=>{const path=typeof children==='string'&&children.endsWith('\n')?localPath(children):null;return <code {...props} className={className}>{path?<button type="button" className="local-file-link" title="打开本地文件" onClick={()=>onOpenLocalPath(path)}>{children}</button>:children}</code>;}}:{}),
   a:({node:_,href,children,...props})=>{const path=href&&onOpenLocalPath?localPath(href):null;return path?<button type="button" className="local-file-link" title="打开本地文件" onClick={()=>onOpenLocalPath!(path)}>{children}</button>:<a {...props} href={href||undefined} target={href?.startsWith('#')?undefined:'_blank'} rel="noopener noreferrer" onClick={e=>{
    if(!href){e.preventDefault();return;}
    if(href.startsWith('#')){e.preventDefault();try{const root=e.currentTarget.closest('.markdown-content');root?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({block:'nearest'});}catch{/* Malformed anchors remain inert. */}return;}
    if(onOpenLink){e.preventDefault();onOpenLink(href);}
   }}>{children}</a>;},
   table:({node:_,children,...props})=><div className="markdown-table-wrap"><table {...props}>{children}</table></div>,
   img:({node:_,src,alt,...props})=>src&&(allowRemoteImages||!/^https?:/i.test(src))?<img {...props} src={src} alt={alt||'笔记图片'} loading="lazy" referrerPolicy="no-referrer"/>:<span className="markdown-image-placeholder">图片：{alt||'未指定图片地址'}</span>,
  }}>{value}</Markdown>
 </div>;
});
