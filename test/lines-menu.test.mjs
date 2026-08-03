// Test the phone-only Lines dropdown over CDP, at phone width, against the live box.
const PORT = 9222;
const URL_ = process.argv[2] || "http://127.0.0.1:8080/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const l = await r.json();
      const p = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("no CDP page target");
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && waiting.has(x.id)) { waiting.get(x.id)(x); waiting.delete(x.id); } };
const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: URL_ });
await sleep(3500);
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('.chip')`)) break; await sleep(500); }

const out = {};
out.viewport = await ev(`innerWidth + 'x' + innerHeight`);
// 1. the tab exists and is VISIBLE at phone width
out.linesTabVisible = await ev(`(() => { const t=document.getElementById('tab-lines');
  return !!t && getComputedStyle(t).display !== 'none'; })()`);
// 2. all three tabs fit on one row (no wrap)
out.tabsOneRow = await ev(`(() => {
  const ts=[...document.querySelectorAll('.tab')];
  const tops=new Set(ts.map(t=>Math.round(t.getBoundingClientRect().top)));
  return { count: ts.length, rows: tops.size, labels: ts.map(t=>t.textContent.trim()) };
})()`);
// 3. menu starts closed, opens on tap
out.menuClosedInitially = await ev(`document.getElementById('linesmenu').hidden === true`);
await ev(`document.getElementById('tab-lines').click()`);
await sleep(350);
out.menuOpens = await ev(`(() => { const m=document.getElementById('linesmenu');
  return !m.hidden && getComputedStyle(m).display === 'block'; })()`);
out.menuItems = await ev(`[...document.querySelectorAll('.lineitem-title')].map(x=>x.textContent)`);
out.menuOnScreen = await ev(`(() => { const r=document.getElementById('linesmenu').getBoundingClientRect();
  return r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.width > 100; })()`);
// 4. tapping outside closes it
await ev(`document.body.click()`);
await sleep(250);
out.closesOnOutsideTap = await ev(`document.getElementById('linesmenu').hidden === true`);
// 5. it is reachable from MID-PAGE -- the whole point (tabbar is sticky)
await ev(`(() => { const d=document.scrollingElement; d.scrollTop = Math.floor((d.scrollHeight-d.clientHeight)*0.5); })()`);
await sleep(300);
out.tabVisibleMidPage = await ev(`(() => { const r=document.getElementById('tab-lines').getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight; })()`);
await ev(`document.getElementById('tab-lines').click()`);
await sleep(350);
out.opensMidPage = await ev(`document.getElementById('linesmenu').hidden === false`);
// 6. picking a line switches to it and lands at the newest turn
const before = await ev(`document.getElementById('desk-title').textContent`);
out.switchedFrom = before;
await ev(`(() => { const items=[...document.querySelectorAll('.lineitem')];
  const other=items.find(i=>!i.classList.contains('active')); if(other) other.click(); return !!other; })()`);
await sleep(3000);
out.switchedTo = await ev(`document.getElementById('desk-title').textContent`);
out.menuClosedAfterPick = await ev(`document.getElementById('linesmenu').hidden === true`);
out.landedAtBottom = await ev(`(() => { const d=document.scrollingElement;
  return (d.scrollHeight - d.scrollTop - d.clientHeight) < 60; })()`);

// The line-switch assertions need at least TWO open lines. With one, there is nothing to switch
// to -- that is a SKIP, not a failure. (A test that reports FAIL when it simply could not run
// teaches you to ignore it, which is worse than having no test.)
const canSwitch = out.menuItems.length >= 2;
out.switchChecks = canSwitch ? "ran" : "SKIPPED - only one line open";
const core = out.linesTabVisible && out.tabsOneRow.rows === 1 && out.tabsOneRow.count === 3 &&
  out.menuClosedInitially && out.menuOpens && out.menuOnScreen && out.menuItems.length > 0 &&
  out.closesOnOutsideTap && out.tabVisibleMidPage && out.opensMidPage;
const switching = !canSwitch || (out.switchedTo !== out.switchedFrom && out.menuClosedAfterPick && out.landedAtBottom);
out.VERDICT = (core && switching) ? (canSwitch ? "PASS" : "PASS (switch checks skipped)") : "FAIL";
console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
