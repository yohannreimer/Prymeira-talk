export async function waitUntilDeadline(deadline, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  while (now() < deadline) await sleep(deadline - now());
}
