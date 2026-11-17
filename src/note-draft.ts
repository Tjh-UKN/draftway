import type {Note} from './domain';

const signature=(note:Note)=>JSON.stringify([note.title,note.body,note.format,note.projectId,note.taskId,note.noteType,note.occurredOn,note.tags]);

// A single writer keeps the newest keystrokes when a previous save is still in flight.
export class NoteDraft {
  note:Note;
  saving=false;
  error='';
  private saved:string;
  private active:Promise<void>|null=null;
  private listeners=new Set<()=>void>();
  constructor(initial:Note,private save:(note:Note)=>Promise<Note>,recovered?:Note){
    this.note=recovered?.id===initial.id&&recovered.version===initial.version?recovered:{...initial,title:initial.title||'未命名笔记'};
    this.saved=initial.version?signature(initial):'';
  }
  get dirty(){return !this.note.archived&&signature(this.note)!==this.saved;}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private notify(){this.listeners.forEach(listener=>listener());}
  patch(fields:Partial<Pick<Note,'title'|'body'|'format'|'projectId'|'taskId'|'noteType'|'occurredOn'|'tags'>>){if(this.note.archived)return;this.note={...this.note,...fields};this.notify();}
  flush():Promise<void>{
    if(this.active)return this.active;
    this.active=this.write().finally(()=>{this.active=null;});
    return this.active;
  }
  private async write(){
    this.saving=true;this.error='';this.notify();
    try{
      while(this.dirty){
        const submitted=this.note;
        const result=await this.save({...submitted,title:submitted.title.trim()||'未命名笔记'});
        this.saved=signature(submitted);
        this.note={...this.note,version:result.version,updatedAt:result.updatedAt,...(result.knowledgeSource?{knowledgeSource:result.knowledgeSource}:{})};
        this.notify();
      }
    }catch(error){this.error=error instanceof Error?error.message:String(error);throw error;}
    finally{this.saving=false;this.notify();}
  }
}
