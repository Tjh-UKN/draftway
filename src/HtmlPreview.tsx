import {useEffect,useState,type Ref} from 'react';
import * as api from './api';
import {isolatedHtml} from './knowledge-graph';
export default function HtmlPreview({body,title,className,frameRef,onLoad}:{body:string;title:string;className?:string;frameRef?:Ref<HTMLIFrameElement>;onLoad?:()=>void}){
  const [url,setUrl]=useState('');const [error,setError]=useState('');
  useEffect(()=>{if(!api.desktop)return;let alive=true;let token:string|undefined;setUrl('');setError('');void api.createHtmlPreview(body).then(preview=>{token=preview.token;if(alive)setUrl(preview.url);else void api.closeHtmlPreview(preview.token);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;if(token)void api.closeHtmlPreview(token);};},[body]);
  if(error)return <p role="alert">{error}</p>;
  if(api.desktop&&!url)return <p>正在打开 HTML…</p>;
  return <iframe ref={frameRef} onLoad={onLoad} className={className} title={title} sandbox="allow-scripts" {...(api.desktop?{src:url}:{srcDoc:isolatedHtml(body)})}/>;
}
