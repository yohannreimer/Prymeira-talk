// Primary latency and terminal durability are different observations.
export function terminalComplete(counts,expected){
 if(!Number.isSafeInteger(expected.applications)||expected.applications<1||!Number.isSafeInteger(expected.effects)||expected.effects<1)throw Error('Nonempty expected terminal counts required');
 for(const k of ['applications','applied','effects','done','failed'])if(!Number.isSafeInteger(counts[k])||counts[k]<0)throw Error('Observed terminal counts required');
 return counts.applications===expected.applications&&counts.applied===expected.applications&&counts.effects===expected.effects&&counts.done===expected.effects&&counts.failed===0;
}
export function ownedQueueCounts(stdout,namespace){
 if(!/^talk\.prod\.ui-[a-f0-9-]{8}$/.test(namespace))throw Error('Owned UI namespace required');
 const names=['incoming','retry','dead'].map(q=>namespace+'.'+q),rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(p=>names.includes(p[0]));
 if(rows.length!==3||new Set(rows.map(r=>r[0])).size!==3||rows.some(r=>r.length!==3||!/^\d+$/.test(r[1])||!/^\d+$/.test(r[2])))throw Error('Three observed owned queues required');
 return rows.map(([name,ready,unacknowledged])=>({name,ready:Number(ready),unacknowledged:Number(unacknowledged)}));
}
export function ownedConsumerPrefetch(stdout,namespace,expected){
 if(![1,2,8].includes(expected)||!/^talk\.prod\.ui-[a-f0-9-]{8}$/.test(namespace))throw Error('Owned bounded prefetch required');
 const names=['incoming','retry'].map(q=>namespace+'.'+q),rows=stdout.trim().split('\n').map(s=>s.trim().split(/\s+/)).filter(r=>names.includes(r[0]));
 if(rows.length!==2||new Set(rows.map(r=>r[0])).size!==2||rows.some(r=>r.length!==2||!/^\d+$/.test(r[1])||Number(r[1])!==expected))throw Error('Observed prefetch differs from selected image');
 return rows.map(([queue,prefetch])=>({queue,prefetch:Number(prefetch)}));
}
