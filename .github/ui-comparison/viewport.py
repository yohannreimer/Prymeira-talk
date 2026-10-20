"""Read-only pre-load viewport wait, without in-page eval or a CSP override."""
import time

def wait_until_latest(page, thread, timeout_ms=30000):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        state = thread.evaluate("e=>({scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,distanceFromBottom:e.scrollHeight-e.clientHeight-e.scrollTop})")
        if state['distanceFromBottom'] <= 2:
            return state
        page.wait_for_timeout(50)
    raise TimeoutError('Thread did not reach latest messages before offering load: '+str(state))
