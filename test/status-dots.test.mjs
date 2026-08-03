// Stub /api/threads so we can see a BUSY line and an UNREAD line without spending a real turn.
// Checks: the dropdown shows a green working dot + a rust unread count, and the tab dots are
// vertically centred against their labels.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await fetch("http://127.0.0.1:9222/json");
const pg = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && waiting.has(x.id)) { waiting.get(x.id)(x); waiting.delete(x.id); } };
const send = (m, p) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (e) => {
  const q = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (q.result?.exceptionDetails) throw new Error(JSON.stringify(q.result.exceptionDetails).slice(0, 400));
  return q.result?.result?.value;
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: (process.argv[2] || "http://127.0.0.1:8080/") });
await sleep(4000);
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('.chip')`)) break; await sleep(500); }

await ev(`(() => {
  const orig = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).indexOf('/api/threads') !== -1) {
      return orig(u, o).then(r => r.json()).then(j => {
        // window.__mode picks which aggregate the tab dots land on. The dots are exclusive --
        // unread WINS over working -- so a fixture containing an unread line can only ever
        // exercise the RUST dot. The first version of this test did exactly that, reported the
        // alignment fixed, and never once measured the GREEN dot, which was the broken one.
        // Both states get their own pass now.
        j.threads = (window.__mode === 'workingOnly')
          ? [
              {slug:'the-desk', title:'The Desk', cwd:'/x', model:'claude-haiku-4-5', unread:0, started:true, turnCount:18, busy:true, queued:0},
              {slug:'home-page', title:'The Home Page', cwd:'/y', model:'claude-opus-4-8', unread:0, started:true, turnCount:4, busy:false, queued:0}
            ]
          : [
              {slug:'the-desk', title:'The Desk', cwd:'/x', model:'claude-haiku-4-5', unread:0, started:true, turnCount:18, busy:true, queued:0},
              {slug:'press-room', title:'Press Room', cwd:'/y', model:'claude-opus-4-8', unread:3, started:true, turnCount:12, busy:false, queued:0}
            ];
        return new Response(JSON.stringify(j), {headers:{'Content-Type':'application/json'}});
      });
    }
    return orig(u, o);
  };
  return true;
})()`);
await sleep(2600);                       // let the 1.6s poll land
await ev(`document.getElementById('tab-lines').click()`);
await sleep(500);

const out = {};
out.menuHTML = await ev(`document.getElementById('linesmenu').innerHTML.replace(/\\s+/g,' ').slice(0,700)`);
out.workingDots = await ev(`[...document.querySelectorAll('.lineitem-dot.is-working')].map(d=>{
  const c=getComputedStyle(d), r=d.getBoundingClientRect();
  return {bg:c.backgroundColor, display:c.display, w:Math.round(r.width), h:Math.round(r.height), visible:r.width>0&&r.height>0};
})`);
out.unreadCounts = await ev(`[...document.querySelectorAll('.lineitem-count')].map(d=>{
  const c=getComputedStyle(d), r=d.getBoundingClientRect();
  return {text:d.textContent, bg:c.backgroundColor, visible:r.width>0&&r.height>0};
})`);
// tab dot vertical centring -- measured in BOTH colour states, since they are exclusive
const measureDots = `[...document.querySelectorAll('.tab')].map(t=>{
  const d=t.querySelector('.tabdot');
  if(!d || getComputedStyle(d).display==='none') return {tab:t.textContent.trim(), dot:'hidden'};
  const tr=t.getBoundingClientRect(), dr=d.getBoundingClientRect(), c=getComputedStyle(d);
  return {tab:t.textContent.trim().replace(/\\s+/g,''), cls:d.className,
          marginBottom:c.marginBottom, bg:c.backgroundColor,
          offsetFromTabCentre: Math.round((dr.top+dr.height/2)-(tr.top+tr.height/2))};
})`;
out.tabDots_rust = await ev(measureDots);
// now flip the fixture so NOTHING is unread -> the aggregate becomes "working" -> GREEN dots
await ev(`window.__mode = 'workingOnly'`);
await sleep(2600);
out.tabDots_green = await ev(measureDots);
const dotsOk = out.workingDots.length === 1 && out.workingDots[0].visible;
const cntOk = out.unreadCounts.length === 1 && out.unreadCounts[0].text === '3';
const shown = (arr) => arr.filter(d => d.dot !== 'hidden');
const alignRust = shown(out.tabDots_rust).length > 0 &&
  shown(out.tabDots_rust).every(d => Math.abs(d.offsetFromTabCentre) <= 1 && d.marginBottom === '0px');
const alignGreen = shown(out.tabDots_green).length > 0 &&
  shown(out.tabDots_green).every(d => Math.abs(d.offsetFromTabCentre) <= 1 && d.marginBottom === '0px');
out.checks = { dotsOk, cntOk, alignRust, alignGreen };
out.VERDICT = (dotsOk && cntOk && alignRust && alignGreen) ? "PASS" : "FAIL";
console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
