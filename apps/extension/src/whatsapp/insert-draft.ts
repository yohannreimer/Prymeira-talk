const changed=()=>({ok:false as const,error:'A conversa mudou. Confira o campo antes de tentar novamente.'});
/** Lexical can replace the editable and return false from execCommand even when it inserted text. */
export async function insertWhatsAppDraft(document:Document,body:string,isCurrent:()=>boolean,pause=()=>new Promise<void>(resolve=>setTimeout(resolve,50))) {
  if(!isCurrent())return changed();
  const composer=document.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"]');
  if(!composer||composer.innerText.trim())return {ok:false as const,error:'Deixe o campo de mensagem vazio antes de inserir a sugestão.'};
  composer.focus();document.execCommand('insertText',false,body);
  // Confirm the live DOM after its input handlers settle; never insert a second time or press Enter.
  for(let attempt=0;attempt<20;attempt++){
    await pause();if(!isCurrent())return changed();
    const current=document.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"]');
    if(current?.innerText.trim()===body.trim())return {ok:true as const};
  }
  return {ok:false as const,error:'Não foi possível confirmar o preenchimento. Confira o campo do WhatsApp antes de tentar novamente.'};
}
