// Drive real Chrome over CDP (no deps) to test the Mic's scroll-restore on a PHONE-width viewport.
// The whole point: the phone scrolls the DOCUMENT, the desktop scrolls .stream. Two prior fixes
// were desktop-correct and phone-irrelevant, so this test runs at 600px wide -- inside the
// @media(max-width:720px) block -- which is the case that actually matters.
const PORT = 9222;
const URL_ = process.argv[2] || "http://127.0.0.1:8080/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const pg = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pg) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("no CDP page target");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
};
function send(method, params) {
  const n = ++id;
  return new Promise((res) => { waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");

// Always load fresh. Without this the test grades whatever the browser loaded at launch, which
// silently re-ran the OLD build after a push and reported a false FAIL.
await send("Page.navigate", { url: URL_ });
await sleep(3000);

// wait for the app + its thread list
for (let i = 0; i < 60; i++) {
  const ready = await evalJs(`!!document.querySelector('.chip')`);
  if (ready) break;
  await sleep(500);
}

const out = {};
out.viewport = await evalJs(`innerWidth + 'x' + innerHeight`);
out.fixLoaded = await evalJs(`/restorePending/.test(document.querySelector('script[src*="mic.js"],script[src*="glass.js"]') ? '' : '') || (typeof scrollEl !== 'undefined')`);

// open The Desk
await evalJs(`(() => {
  const c = [...document.querySelectorAll('.chip')].find(x => /desk/i.test(x.textContent));
  if (c) c.click();
  return !!c;
})()`);
await sleep(2500);

// which element is actually scrolling at this width?
out.docScrollable = await evalJs(`(() => {
  const d = document.scrollingElement;
  return d.scrollHeight > d.clientHeight + 4;
})()`);
out.streamScrollable = await evalJs(`(() => {
  const s = document.querySelector('.stream');
  return !!s && s.scrollHeight > s.clientHeight + 4;
})()`);

// scroll to a spot in the middle -- whichever element is the real scroller
out.setTo = await evalJs(`(() => {
  const d = document.scrollingElement;
  const useDoc = d.scrollHeight > d.clientHeight + 4;
  const s = useDoc ? d : document.querySelector('.stream');
  const target = Math.floor((s.scrollHeight - s.clientHeight) * 0.45);
  s.scrollTop = target;
  return s.scrollTop;
})()`);

await sleep(400);
out.beforeFlip = await evalJs(`(() => {
  const d = document.scrollingElement;
  const useDoc = d.scrollHeight > d.clientHeight + 4;
  return (useDoc ? d : document.querySelector('.stream')).scrollTop;
})()`);

// flip to cockpit, linger, flip back -- exactly what the operator did
await evalJs(`document.getElementById('tab-cockpit').click()`);
await sleep(1500);
await evalJs(`document.getElementById('tab-mic').click()`);
await sleep(1200);

out.afterFlip = await evalJs(`(() => {
  const d = document.scrollingElement;
  const useDoc = d.scrollHeight > d.clientHeight + 4;
  return (useDoc ? d : document.querySelector('.stream')).scrollTop;
})()`);

const drift = Math.abs(out.afterFlip - out.beforeFlip);
out.drift = drift;
out.VERDICT = drift <= 30 ? "PASS - position held" : "FAIL - position lost";
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
