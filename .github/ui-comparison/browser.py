"""Observe the unmodified built UI; all traffic and all fixtures are synthetic."""
import json, pathlib, sys, time, traceback
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from viewport import wait_until_latest
config=json.loads(pathlib.Path(sys.argv[1]).read_text()); out=pathlib.Path(config['output'])
def save(name,obj):
 temporary=out/(name+'.tmp'); temporary.write_text(json.dumps(obj,ensure_ascii=False,indent=2)); temporary.replace(out/name)
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
  page.on('response',lambda r:requests.append({'url':r.url,'status':r.status,'at':time.time()*1000}))
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
  page.add_init_script(path=pathlib.Path(__file__).with_name('observer.js'))
  page.goto(config['url'],wait_until='networkidle',timeout=60000)
  page.screenshot(path=str(out/'recon.png'))
  (out/'recon.html').write_text(page.content())
  # Observe rendered content before selecting the seeded conversation by its actual visible label.
  rendered=page.get_by_text('UI Contato 00',exact=True)
  save('recon-selectors.json',{'targetCount':rendered.count(),'buttons':page.get_by_role('button').all_text_contents()})
  if rendered.count(): rendered.first.click()
  page.locator('[data-message-id]').first.wait_for(state='visible',timeout=30000)
  page.wait_for_function("document.querySelectorAll('[data-message-id]').length >= 1")
  thread=page.locator('.message-thread')
  thread.hover()
  page.mouse.wheel(0,100000)
  wait_until_latest(page, thread)
  page.wait_for_timeout(300)
  initial=thread.evaluate("e=>({scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,distanceFromBottom:e.scrollHeight-e.clientHeight-e.scrollTop})")
  warm=page.locator('[data-message-id="'+config['warmupMessageId']+'"]')
  assert warm.is_visible() and initial['distanceFromBottom']<=2,initial
  save('initial-viewport.json',{'at':time.time()*1000,'thread':initial,'warmupMessageId':config['warmupMessageId'],'warmupVisible':warm.is_visible(),'setup':'Initial user wheel to latest messages before offers; no scrolling during measurement'})
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
  save('browser.json',{'times':page.evaluate('window.__uiTimes'),'frames':page.evaluate('window.__uiFrames'),'protocolFrames':frames,'maxSimultaneousBubbles':page.evaluate('window.__uiDuplicates'),'errors':errors,'requests':requests,'clocks':clocks,'browser':browser.version,'viewport':page.viewport_size,'visibility':page.evaluate('document.visibilityState'),'scrollContainers':page.evaluate("Array.from(document.querySelectorAll('*')).filter(e=>e.clientHeight>0 && e.scrollHeight>e.clientHeight+10).map(e=>({tag:e.tagName,className:e.className,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}))")})
  page.screenshot(path=str(out/'final.png'))
  (out/'final.html').write_text(page.content())
  browser.close()
except Exception:
 save('browser-failure.json',{'error':traceback.format_exc(),'errors':errors,'requests':requests,'frames':frames})
 raise
