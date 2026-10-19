// Contract mirrored from the qualified WAHA 2026.9.1 GOWS toWAMessage fixture
// apps/api/src/modules/waha/waha-gows.test.ts. Info alone is not a complete GOWS payload.
export function makeEnvelopes({rawId,phone,text,timestamp,instance,session,index}){
 const pushName=`UI Contato ${String(index).padStart(2,'0')}`;
 return {
  evolution:{event:'MESSAGES_UPSERT',instance,data:{key:{id:rawId,remoteJid:phone+'@s.whatsapp.net',fromMe:false},message:{conversation:text},messageTimestamp:timestamp,pushName}},
  waha:{event:'message.any',session,payload:{id:`false_${phone}@c.us_${rawId}`,timestamp,from:phone+'@c.us',fromMe:false,source:'app',body:text,to:null,participant:null,hasMedia:false,media:null,ack:2,location:null,vCards:[],_data:{Info:{Chat:phone+'@s.whatsapp.net',Sender:phone+'@s.whatsapp.net',IsFromMe:false,IsGroup:false,ID:rawId,PushName:pushName,Timestamp:new Date(timestamp*1000).toISOString(),Type:'text'},Message:{conversation:text}}}}
 };
}
