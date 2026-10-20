"""Qualify the pre-load wait against a real CSP header, without weakening it."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright, Error
from viewport import wait_until_latest

policy="script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com https://clerk.prymeiradigital.com.br"
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Security-Policy',policy)
        self.end_headers()
        self.wfile.write(b'<div class="message-thread" style="height:200px;overflow:auto"><div style="height:2000px">synthetic history</div><div>latest synthetic message</div></div>')

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=Thread(target=server.serve_forever,daemon=True); thread.start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page()
        response=page.goto('http://127.0.0.1:'+str(server.server_port))
        assert response.headers['content-security-policy']==policy
        target=page.locator('.message-thread')
        # Preserve the failing predicate as evidence when the pinned browser reproduces it.
        try:
            page.wait_for_function("(() => {const e=document.querySelector('.message-thread');return !!e && e.scrollHeight-e.clientHeight-e.scrollTop<=2;})()",timeout=200)
        except Error as error:
            print('Original predicate outcome:',type(error).__name__,str(error).splitlines()[0])
        try:
            wait_until_latest(page,target,timeout_ms=200)
            raise AssertionError('Wait must not report top of history as latest')
        except TimeoutError:
            pass
        assert target.evaluate('e=>e.scrollTop')==0, 'The wait must never change the viewport'
        target.hover(); page.mouse.wheel(0,100000)
        state=wait_until_latest(page,target)
        assert state['distanceFromBottom']<=2,state
        browser.close()
    print('Strict CSP / no scrolling side effect / user wheel / latest viewport: PASS')
finally:
    server.shutdown();server.server_close();thread.join()
