// Export duration/category only. SQL text and parameters never leave this parser.
export function sanitizePostgresDurations(input){
 const entries=[];let unmatchedDurationLines=0;
 for(const line of input.split('\n')){
  if(!line.includes('duration:'))continue;
  const m=/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ UTC) \[(\d+)\] app=([^ ]*)\s+LOG:\s+duration:\s+([\d.]+) ms\s+(?:(parse|bind|execute) [^:]*:|statement:)\s*(.*)$/.exec(line);
  if(!m){unmatchedDurationLines++;continue;}
  const sql=m[6],verb=/^\s*([A-Z]+)/i.exec(sql)?.[1]?.toUpperCase()??'UNKNOWN';
  let category=/pg_advisory_xact_lock/.test(sql)?'advisory':/transaction_isolation/.test(sql)?'isolation':/FOR SHARE/.test(sql)?'source_share':verb;
  const table=/(?:FROM|INTO|UPDATE)\s+(?:"?public"?\.)?"?([a-z_]+)"?/i.exec(sql)?.[1]??null;
  const at=Date.parse(m[1].replace(' UTC','Z').replace(' ','T')),durationMs=Number(m[4]);
  if(!Number.isFinite(at)||!Number.isFinite(durationMs)){unmatchedDurationLines++;continue;}
  entries.push({at,pid:Number(m[2]),application:m[3],phase:m[5]??'statement',category,table,durationMs});
 }
 return {version:1,complete:unmatchedDurationLines===0,unmatchedDurationLines,entries};
}
