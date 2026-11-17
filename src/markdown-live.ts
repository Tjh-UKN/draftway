import type {EditorState} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';

export function markdownDecorations(state:EditorState,focused:boolean,ranges:readonly {from:number;to:number}[]=[{from:0,to:state.doc.length}]){
 const decorations:{from:number;to:number;line?:boolean;className?:string}[]=[];
 const active=(from:number,to:number)=>focused&&state.selection.ranges.some(selection=>state.doc.lineAt(selection.from).from<=to&&state.doc.lineAt(selection.to).to>=from);
 for(const range of ranges)syntaxTree(state).iterate({from:range.from,to:range.to,enter(node){
  const heading=/^ATXHeading([1-6])$/.exec(node.name);
  if(heading)decorations.push({from:state.doc.lineAt(node.from).from,to:node.from,line:true,className:`note-heading-${heading[1]}`});
  if(active(node.from,node.to))return;
  if(node.name==='HeaderMark'||node.name==='EmphasisMark'||node.name==='StrikethroughMark'||(node.name==='CodeMark'&&node.node.parent?.name==='InlineCode')){
   const to=node.name==='HeaderMark'&&state.doc.sliceString(node.to,node.to+1)===' '?node.to+1:node.to;decorations.push({from:node.from,to});
  }
 }});
 return decorations;
}
