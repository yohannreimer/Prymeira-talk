import { expect,it,vi } from 'vitest';
import { insertWhatsAppDraft } from './insert-draft';
it('confirms the actual editable after the WhatsApp editor updates, regardless of execCommand return',async()=>{
 const previous={innerText:'',focus:vi.fn()},replacement={innerText:'',focus:vi.fn()};let current=previous;
 const doc={querySelector:()=>current,execCommand:vi.fn(()=>false)};
 let ticks=0;
 const result=await insertWhatsAppDraft(doc as never,'Texto de teste',()=>true,async()=>{if(++ticks===2){replacement.innerText='Texto de teste';current=replacement;}});
 expect(result).toEqual({ok:true});expect(doc.execCommand).toHaveBeenCalledTimes(1);expect(previous.innerText).toBe('');
});
it('preserves an occupied field and stops confirming after navigation',async()=>{
 const doc={querySelector:()=>({innerText:'Texto do vendedor',focus:vi.fn()}),execCommand:vi.fn()};
 expect(await insertWhatsAppDraft(doc as never,'Novo',()=>true,async()=>{})).toMatchObject({ok:false});expect(doc.execCommand).not.toHaveBeenCalled();
 let current=true;const empty={querySelector:()=>({innerText:'',focus:vi.fn()}),execCommand:vi.fn(()=>true)};
 expect(await insertWhatsAppDraft(empty as never,'Novo',()=>current,async()=>{current=false;})).toMatchObject({ok:false});
});
