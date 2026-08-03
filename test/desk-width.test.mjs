// Desk-width regression: the Lines tab must be HIDDEN and the strip must still be the way in.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await fetch("http://127.0.0.1:9222/json");
const pg = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && waiting.has(x.id)) { waiting.get(x.id)(x); waiting.delete(x.id); } };
const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: (process.argv[2] || "http://127.0.0.1:8080/") });
await sleep(3500);
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('.chip')`)) break; await sleep(500); }
const out = {};
out.viewport = await ev(`innerWidth + 'x' + innerHeight`);
out.linesTabHidden = await ev(`getComputedStyle(document.getElementById('tab-lines')).display === 'none'`);
out.stripVisible = await ev(`(() => { const s=document.querySelector('.strip');
  return !!s && s.getBoundingClientRect().width > 100; })()`);
out.chipCount = await ev(`document.querySelectorAll('.chip').length`);
out.tabs = await ev(`[...document.querySelectorAll('.tab')].filter(t=>getComputedStyle(t).display!=='none').map(t=>t.textContent.trim())`);
out.streamScrolls = await ev(`(() => { const s=document.querySelector('.stream');
  const d=document.scrollingElement; return { stream: s.scrollHeight > s.clientHeight+4, doc: d.scrollHeight > d.clientHeight+4 }; })()`);
out.VERDICT = (out.linesTabHidden && out.stripVisible && out.chipCount > 0 && out.tabs.length === 2) ? "PASS" : "FAIL";
console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
