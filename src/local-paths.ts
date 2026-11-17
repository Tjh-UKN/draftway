const prefix='northstar-local:';
export function localPath(value:string):string|null {
  let path=value.trim();
  if(!path||path.length>32768||/[\x00-\x1f\x7f]/.test(path))return null;
  if(path.startsWith(prefix)){try{const decoded=decodeURIComponent(path.slice(prefix.length));return decoded.startsWith(prefix)?null:localPath(decoded);}catch{return null;}}
  if(/^file:/i.test(path)){
    try{const url=new URL(path);if(url.username||url.password||url.port)return null;const decoded=decodeURIComponent(url.pathname);path=url.hostname&&url.hostname!=='localhost'?`\\\\${url.hostname}${decoded.replaceAll('/','\\')}`:decoded.replace(/^\/([a-z]:)/i,'$1');}catch{return null;}
  }
  path=path.replace(/^\/mnt\/([a-z])\//i,(_,drive:string)=>`${drive.toUpperCase()}:\\`);
  if(!/^[a-z]:[\\/]/i.test(path)&&!/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path))return null;
  if(/[\x00-\x1f\x7f<>"|?*]/.test(path)||path.slice(2).includes(':'))return null;
  return path.replaceAll('/','\\');
}
export const localPathUrl=(path:string)=>prefix+encodeURIComponent(path);
type Node={type:string;value?:string;url?:string;children?:Node[]};
export function remarkLocalPaths(){
  return (root:Node)=>{
    function visit(parent:Node){
      if(['link','image','code','inlineCode'].includes(parent.type)||!parent.children)return;
      parent.children=parent.children.flatMap(node=>{
        if(node.type==='inlineCode'&&node.value){const path=localPath(node.value);return path?[{type:'link',url:localPathUrl(path),children:[node]}]:[node];}
        if(node.type!=='text'||!node.value){visit(node);return [node];}
        const label=node.value.replace(/[，。；、,;!]+$/u,'');const whole=localPath(label);
        if(whole)return [{type:'link',url:localPathUrl(whole),children:[{...node,value:label}]},...(label.length<node.value.length?[{type:'text',value:node.value.slice(label.length)}]:[])];
        const pattern=/(?:[a-z]:[\\/]|\\\\[^\s\\/]+[\\/]|file:\/\/\/|\/mnt\/[a-z]\/)[^\s<>"|?*，。；、（）,;]+/gi;
        const pieces:Node[]=[];let end=0;
        for(const match of node.value.matchAll(pattern)){
          const start=match.index!;if(start&&/[\w/\\:]/.test(node.value[start-1]))continue;
          const label=match[0].replace(/[，。；、）),.;!\]}]+$/u,'');const path=localPath(label);if(!path)continue;
          if(start>end)pieces.push({type:'text',value:node.value.slice(end,start)});
          pieces.push({type:'link',url:localPathUrl(path),children:[{type:'text',value:label}]});end=start+label.length;
        }
        if(!pieces.length)return [node];if(end<node.value.length)pieces.push({type:'text',value:node.value.slice(end)});return pieces;
      });
    }
    visit(root);
  };
}
