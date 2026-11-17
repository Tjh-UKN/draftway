const colors:Record<string,string>={root:'#969ca5',idea:'#22a06b',analysis:'#5b8def',event:'#ca8a04',document:'#9b7bd4',code:'#4b9bb5',artifact:'#38a89d',folder:'#969ca5',markdown:'#9b7bd4',html:'#4b9bb5',mindmap:'#22a06b',excalidraw:'#ca8a04'};
export default function NodeDot({kind}:{kind:string}){
  return <span className="node-color-dot" aria-hidden="true" style={{display:'inline-block',width:7,height:7,flex:'0 0 7px',borderRadius:'50%',backgroundColor:colors[kind]||colors.root}}/>;
}
