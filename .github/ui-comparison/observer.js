(() => {
    window.__uiTimes = []; window.__uiFrames = []; window.__uiDuplicates = {}; window.__uiClock = () => performance.timeOrigin + performance.now();
    const NativeWebSocket=window.WebSocket;
    window.WebSocket=new Proxy(NativeWebSocket,{construct(Target,args){const socket=Reflect.construct(Target,args);socket.addEventListener('message',event=>{const markers=String(event.data).match(/TALKUI_[0-9]{5}/g);if(markers){let data;try{data=JSON.parse(event.data);}catch{}window.__uiFrames.push({event:'received',type:data?.type??null,at:__uiClock(),markers:[...new Set(markers)]});}});return socket;}});
    const mounted = new Map(), visible = new Set(); let armed = false, frame=0;requestAnimationFrame(function tick(){frame++;requestAnimationFrame(tick);});
    function scan(recordOnly=false) {
      const counts={}; for (const node of document.querySelectorAll('[data-message-id]')) { const m=node.textContent.match(/TALKUI_[0-9]{5}/)?.[0];if(m)counts[m]=(counts[m]??0)+1; } for(const [m,n]of Object.entries(counts))window.__uiDuplicates[m]=Math.max(window.__uiDuplicates[m]??0,n);
      for (const node of document.querySelectorAll('[data-message-id]')) {
        const marker = node.textContent.match(/TALKUI_[0-9]{5}/)?.[0]; if (!marker) continue;
        if (!mounted.has(marker)) { mounted.set(marker, {at:__uiClock(),frame}); window.__uiTimes.push({marker,phase:'mounted',at:__uiClock(),frame,id:node.dataset.messageId}); }
        if (recordOnly || visible.has(marker) || frame-mounted.get(marker).frame<2) continue;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        // Require the message marker's text range in viewport and unoccluded, not merely a DOM node.
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT); let text;
        while(text=walker.nextNode()) { const index=text.textContent.indexOf(marker); if(index<0)continue;
          const range=document.createRange(); range.setStart(text,index); range.setEnd(text,index+marker.length);
          const r=range.getBoundingClientRect(), x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
          const top=document.elementFromPoint(x,y);
          if(r.width>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth && style.visibility==='visible' && style.display!=='none' && Number(style.opacity)>0 && top && node.contains(top)) {
            visible.add(marker); window.__uiTimes.push({marker,phase:'visibleAfterTwoFrames',at:__uiClock(),framesSinceMounted:frame-mounted.get(marker).frame,id:node.dataset.messageId,rect:{x:r.x,y:r.y,width:r.width,height:r.height},visibility:document.visibilityState});
          }
        }
      }
    }
    // Passive observer: never mutates UI, scrolls, changes app caches or injects messages.
    function schedule() { if(armed)return;armed=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{armed=false;scan();})); }
    new MutationObserver(()=>{scan(true);schedule();}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style']});
    addEventListener('scroll',schedule,true); addEventListener('resize',schedule); setInterval(schedule,100);
  })();
