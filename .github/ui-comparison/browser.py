"""Observe the unmodified built UI; all traffic and all fixtures are synthetic."""
import json, pathlib, sys, time, traceback
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
config=json.loads(pathlib.Path(sys.argv[1]).read_text()); out=pathlib.Path(config['output'])
def save(name,obj): (out/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2))
errors=[]; requests=[]; frames=[]; clocks=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
  def route(r):
   url=urlsplit(r.request.url)
   if url.hostname not in ['127.0.0.1','localhost'] and url.scheme not in ['data','blob']:
    requests.append({'blockedExternal':r.request.url});r.abort()
   else: r.continue_()
  page.route('**/*',route)
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('response',lambda r:requests.append({'url':r.url,'status':r.status}) if r.status>=400 else None)
  def websocket(ws):
   frames.append({'event':'open','url':ws.url,'at':time.time()*1000})
   def receive(payload):
    # All data is synthetic. Persist markers only, never arbitrary payload bodies.
    import re
    markers=re.findall(r'TALKUI_[0-9]{5}',str(payload))
    if markers: frames.append({'event':'received','at':time.time()*1000,'markers':list(set(markers))})
   ws.on('framereceived',receive)
   ws.on('close',lambda:frames.append({'event':'close','at':time.time()*1000}))
  page.on('websocket',websocket)
  page.add_init_script("""(() => {
    window.__uiTimes = []; window.__uiClock = () => performance.timeOrigin + performance.now();
    const mounted = new Map(), visible = new Set(); let armed = false;
    function scan() {
      for (const node of document.querySelectorAll('[data-message-id]')) {
        const marker = node.textContent.match(/TALKUI_[0-9]{5}/)?.[0]; if (!marker) continue;
        if (!mounted.has(marker)) { mounted.set(marker, __uiClock()); window.__uiTimes.push({marker,phase:'mounted',at:__uiClock(),id:node.dataset.messageId}); }
        if (visible.has(marker)) continue;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        // Require the message marker's text range in viewport and unoccluded, not merely a DOM node.
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT); let text;
        while(text=walker.nextNode()) { const index=text.textContent.indexOf(marker); if(index<0)continue;
          const range=document.createRange(); range.setStart(text,index); range.setEnd(text,index+marker.length);
          const r=range.getBoundingClientRect(), x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
          const top=document.elementFromPoint(x,y);
          if(r.width>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth && style.visibility==='visible' && style.display!=='none' && Number(style.opacity)>0 && top && node.contains(top)) {
            visible.add(marker); window.__uiTimes.push({marker,phase:'visibleAfterTwoFrames',at:__uiClock(),id:node.dataset.messageId,rect:{x:r.x,y:r.y,width:r.width,height:r.height},visibility:document.visibilityState});
          }
        }
      }
    }
    // Passive observer: never mutates UI, scrolls, changes app caches or injects messages.
    function schedule() { if(armed)return;armed=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{armed=false;scan();})); }
    new MutationObserver(schedule).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style']});
    addEventListener('scroll',schedule,true); addEventListener('resize',schedule); setInterval(schedule,100);
  })();""")
  page.goto(config['url'],wait_until='networkidle',timeout=60000)
  page.screenshot(path=str(out/'recon.png'))
  (out/'recon.html').write_text(page.content())
  # Observe rendered content before selecting the seeded conversation by its actual visible label.
  rendered=page.get_by_text('UI Contato 00',exact=True)
  save('recon-selectors.json',{'targetCount':rendered.count(),'buttons':page.get_by_role('button').all_text_contents()})
  if rendered.count(): rendered.first.click()
  page.locator('[data-message-id]').first.wait_for(state='visible',timeout=30000)
  page.wait_for_function("document.querySelectorAll('[data-message-id]').length >= 1")
  for _ in range(12):
   start=time.time()*1000; browser_clock=page.evaluate('performance.timeOrigin+performance.now()'); end=time.time()*1000
   clocks.append({'start':start,'browser':browser_clock,'end':end,'offset':browser_clock-(start+end)/2,'uncertainty':(end-start)/2})
  page.screenshot(path=str(out/'ready.png'))
  save('ready.json',{'at':time.time()*1000,'url':page.url,'browser':browser.version,'frames':frames,'clock':min(clocks,key=lambda x:x['uncertainty'])})
  deadline=time.monotonic()+320
  while not (out/'stop-browser').exists() and time.monotonic()<deadline:
   page.wait_for_timeout(100)
   save('browser-live.json',{'times':page.evaluate('window.__uiTimes'),'frames':frames})
  for _ in range(6):
   start=time.time()*1000;bc=page.evaluate('performance.timeOrigin+performance.now()');end=time.time()*1000
   clocks.append({'start':start,'browser':bc,'end':end,'offset':bc-(start+end)/2,'uncertainty':(end-start)/2})
  save('browser.json',{'times':page.evaluate('window.__uiTimes'),'frames':frames,'errors':errors,'requests':requests,'clocks':clocks,'browser':browser.version,'viewport':page.viewport_size,'visibility':page.evaluate('document.visibilityState')})
  page.screenshot(path=str(out/'final.png'))
  (out/'final.html').write_text(page.content())
  browser.close()
except Exception:
 save('browser-failure.json',{'error':traceback.format_exc(),'errors':errors,'requests':requests,'frames':frames})
 raise
