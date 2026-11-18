declare const northstar: {
  readonly api: {major:1;minor:number};
  readonly note: {
    read(): Promise<{id:string;title:string;text:string;revision:number;selection:{from:number;to:number;text:string}}>;
    edit(edit:{from:number;to:number;text:string;revision:number}):Promise<null>;
    select(range:{from:number;to:number}):Promise<null>;
  };
  readonly commands: {register(id:string,run:()=>unknown|Promise<unknown>):void};
  readonly storage: {get(key:string):Promise<unknown>;set(key:string,value:unknown):Promise<null>};
  on(name:'note.changed',listener:()=>void):{dispose():void};
};
