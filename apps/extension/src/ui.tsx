import type { CSSProperties } from 'react';
export function Icon({ name, size=18, className='' }: {name:'arrow'|'refresh'|'logout'|'close'|'check'|'message'|'clock'|'alert';size?:number;className?:string}) {
  const paths = {
    arrow:<path d="m9 5 7 7-7 7"/>, refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14A8 8 0 0 0 17.9 17.9"/></>,
    logout:<><path d="M9 5H5v14h4m6-11 4 4-4 4m-5-4h9"/></>, close:<path d="m6 6 12 12M6 18 18 6"/>,
    check:<path d="m5 12 4 4L19 6"/>, message:<><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8m-8 4h5"/></>,
    clock:<><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,alert:<><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 3v.1"/></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Prym({ large=false }: {large?:boolean}) { return <img className={`prym-avatar${large?' prym-large':''}`} src="assets/prym.png" alt="Prym, assistente do Talk" width={large?112:42} height={large?132:50}/>; }
export function Initials({ name }: {name:string}) {
 const words=name.trim().split(/\s+/).filter(x=>/\p{L}|\p{N}/u.test(x)), label=/^\+?[\d\s()-]+$/.test(name)?null:words.slice(0,2).map(x=>Array.from(x)[0]).join('').toLocaleUpperCase('pt-BR');
 return <span className="contact-avatar" aria-hidden="true">{label||<Icon name="message"/>}</span>;
}
export function Skeleton({ rows=3 }: {rows?:number}) { return <div className="skeleton" aria-hidden="true">{Array.from({length:rows},(_,i)=><div className="skeleton-line" key={i} style={{'--line-width':i%2?'65%':'90%'} as CSSProperties}/>)}</div>; }
