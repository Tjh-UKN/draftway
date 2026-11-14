export function boundedText(value:string,limit:number):string {
  let text='';for(const character of value){const code=character.codePointAt(0)!;const next=code>=0xd800&&code<=0xdfff?'�':character;if(text.length+next.length>limit)break;text+=next;}return text;
}
