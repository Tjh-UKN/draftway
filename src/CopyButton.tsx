import {useState} from 'react';
import {Check,Copy} from 'lucide-react';
export default function CopyButton({text,label='复制回复'}:{text:string|(()=>string);label?:string}){
  const [result,setResult]=useState('');
  return <button type="button" className="message-copy" aria-label={result||label} title={result||label} onClick={()=>{
    const action=navigator.clipboard?.writeText(typeof text==='function'?text():text)||Promise.reject();
    void action.then(()=>setResult('已复制'),()=>setResult('复制失败，请选择文字复制'));
  }}>{result==='已复制'?<Check size={13}/>:<Copy size={13}/>}<span>{result}</span></button>;
}
