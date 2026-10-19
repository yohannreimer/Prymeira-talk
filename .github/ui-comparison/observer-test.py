import pathlib
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':800,'height':600})
 page.add_init_script(path=pathlib.Path(__file__).with_name('observer.js'))
 # This unit fixture tests the measuring device, not the application's message flow.
 page.goto('about:blank');page.set_content('<div data-message-id="m1">TALKUI_00001</div><div data-message-id="m2" style="display:none">TALKUI_00002</div><div data-message-id="m3" style="position:absolute;top:2000px">TALKUI_00003</div>')
 page.wait_for_function("window.__uiTimes.some(t=>t.marker==='TALKUI_00001'&&t.phase==='visibleAfterTwoFrames')")
 times=page.evaluate('window.__uiTimes')
 assert all(t['marker']=='TALKUI_00001' for t in times if t['phase']=='visibleAfterTwoFrames'),times
 assert all(t['framesSinceMounted']>=2 for t in times if t['phase']=='visibleAfterTwoFrames'),times
 page.locator('[data-message-id="m2"]').evaluate("e=>e.style.display='block'")
 page.wait_for_function("window.__uiTimes.some(t=>t.marker==='TALKUI_00002'&&t.phase==='visibleAfterTwoFrames')")
 assert not page.evaluate("window.__uiTimes.some(t=>t.marker==='TALKUI_00003'&&t.phase==='visibleAfterTwoFrames')")
 browser.close()
print('Observer checks: visible, hidden, outside viewport, >=2 frames: PASS')
