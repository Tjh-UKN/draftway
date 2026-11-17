import {makeRecord, type KnowledgeSource, type Note} from './domain';
import type {WorkbenchState} from './next/core';
import {boundedText} from './next/text';

export interface KnowledgeCandidate {title:string;body:string;source:KnowledgeSource;}
export const knowledgeSourceKey=(source:KnowledgeSource)=>'personal-knowledge-source:'+JSON.stringify([source.workspaceId,source.kind,source.id]);
export function knowledgeCandidates(state:Pick<WorkbenchState,'spaces'>):KnowledgeCandidate[] {
  const candidates:KnowledgeCandidate[]=[];
  for(const space of state.spaces) {
    const source=(kind:KnowledgeSource['kind'],id:string,category:KnowledgeSource['category']):KnowledgeSource=>({kind,id,category,workspaceId:space.id,workspaceName:space.name});
    for(const node of space.nodes)if(node.body.trim() && (node.kind==='artifact'||node.kind==='document'||node.sourceArtifactId))candidates.push({title:node.title,body:node.body,source:source('node',node.id,node.kind==='document'?'document':'artifact')});
    const notes=space.surfaces.filter(surface=>surface.integrationId==='note'&&surface.text?.trim());
    for(const note of notes)candidates.push({title:note.title||space.name+' · 随记',body:note.text!,source:source('note',note.id,'note')});
    if(space.notes.trim()&&!notes.some(note=>note.text===space.notes))candidates.push({title:space.name+' · 随记',body:space.notes,source:source('note','workspace-notes','note')});
  }
  return candidates;
}
export function knowledgeNote(candidate:KnowledgeCandidate):Note {
  if(new TextEncoder().encode(candidate.body).length>1_000_000)throw Error('知识内容超过 1 MB，原内容仍保留在工作区。');
  return {...makeRecord('note') as Note,title:boundedText(candidate.title.trim(),120)||'未命名知识',body:candidate.body,knowledgeSource:{...candidate.source,autoUpdate:true}};
}

export function refreshKnowledgeNote(note:Note,candidate:KnowledgeCandidate):Note {
  if(note.archived||note.knowledgeSource?.autoUpdate===false||(note.knowledgeSource?.autoUpdate===undefined&&note.version>1))return note;
  const title=boundedText(candidate.title.trim(),120)||'未命名知识';
  if(note.title===title&&note.body===candidate.body&&note.knowledgeSource?.workspaceName===candidate.source.workspaceName)return note;
  const imported=knowledgeNote(candidate);
  return {...note,title:imported.title,body:imported.body,knowledgeSource:imported.knowledgeSource,updatedAt:imported.updatedAt,version:note.version+1};
}
