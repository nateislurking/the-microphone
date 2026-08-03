/* ============================================================================
   THE MICROPHONE -- mic.js  (the page logic)
   ----------------------------------------------------------------------------
   Thin glass: renders turns and routes replies. No intelligence, no state of
   its own -- the server's thread files are the truth. The page shows turns and
   nothing else: no tool-call noise, no sub-agent chatter, no liveness beyond a
   quiet "working..." while a resume is in flight.

   NOTE -- the "+ open a line" form is the MANUAL path. The intended way to open a
   line is to say so to the Desk ("open a line for X on Sonnet") and let it do the
   work. The form stays because a manual door you never need beats a missing one at
   the moment the Desk is the thing that is wedged.
   ========================================================================== */
(function () {
  "use strict";

  var el = {
    chips: document.getElementById("chips"),
    stream: document.getElementById("stream"),
    empty: document.getElementById("empty"),
    dock: document.getElementById("dock"),
    deskHead: document.getElementById("desk-head"),
    deskTitle: document.getElementById("desk-title"),
    deskModel: document.getElementById("desk-model"),
    deskCwd: document.getElementById("desk-cwd"),
    working: document.getElementById("working"),
    workingTxt: document.getElementById("working-txt"),
    stopbtn: document.getElementById("stopbtn"),
    replybox: document.getElementById("replybox"),
    sendbtn: document.getElementById("sendbtn"),
    pastes: document.getElementById("pastes"),
    clipbtn: document.getElementById("clipbtn"),
    clipinput: document.getElementById("clipinput"),
    newbtn: document.getElementById("newbtn"),
    newform: document.getElementById("newform"),
    nfCancel: document.getElementById("nf-cancel")
  };

  var current = null;         // active slug
  var threads = [];           // last thread list
  var pending = [];           // pending paste attachments {path,url}
  var lastTurnSig = "";       // to detect new turns for autoscroll

  /* ---------- scroll memory (2026-07-22) ----------
     Two things destroy the reading position, and both had to be handled:
       1. renderThread() rebuilds the stream every poll (innerHTML = "" then append). Clearing the
          children collapses scrollHeight, which clamps scrollTop to 0 -- so a poll tick could drop
          the operator at the top mid-read.
       2. The cockpit tab flip sets pane-mic[hidden], i.e. display:none. A display:none element
          reports scrollTop/scrollHeight/clientHeight as 0 and IGNORES writes to scrollTop, so the
          position could not survive the flip and the autoscroll that fired while hidden was a no-op.
          Coming back therefore landed at the very top of a long conversation.
     So the position is kept HERE, in JS, never read back off a hidden element. The rule the operator asked
     for: keep your exact spot -- unless you were already parked at the bottom following live output, in
     which case follow to the new bottom. */
  var micScroll = { top: 0, atBottom: true };
  var BOTTOM_SLOP = 40;       // px; "close enough to the bottom" that you were clearly following along
  var restorePending = false; // see the race note in rememberScroll()

  function micPaneHidden() {
    var p = document.getElementById("pane-mic");
    return !!(p && p.hidden);
  }
  // WHICH ELEMENT ACTUALLY SCROLLS -- and it is not the same one on both machines.
  //   Desktop: body is height:100vh + overflow:hidden, so .stream (flex + overflow-y:auto) is the
  //            scroller.
  //   Phone (the @media max-width:720px block): that is released -- body{overflow:auto;height:auto}
  //            and .app{height:auto} -- so .stream grows to fit its content and the DOCUMENT
  //            scrolls instead.
  // The first two passes at this fix only ever touched .stream, whose scrollTop on a phone is
  // permanently 0. They were correct on a desktop and did nothing at all on the device the operator was
  // actually testing. Detect the real scroller at runtime rather than re-encoding the breakpoint
  // here, so a CSS change cannot silently un-fix this again.
  function scrollEl() {
    var d = document.scrollingElement || document.documentElement;
    if (d && d.scrollHeight > d.clientHeight + 4) return d;   // the page scrolls (phone)
    return el.stream;                                          // the stream scrolls (desktop)
  }
  function rememberScroll() {
    // Never record while hidden -- those reads are all zeros and would erase the real position.
    if (micPaneHidden()) return;
    // ...and never record in the gap between revealing the pane and restoring into it. On reveal
    // the element is visible again but its scrollTop is still 0 (display:none discarded it), so a
    // poll landing in that window would bank 0 as "where you were" and the restore would then
    // faithfully put you at the top -- the exact bug we are fixing, just harder to reproduce.
    if (restorePending) return;
    var s = scrollEl(); if (!s) return;
    micScroll.top = s.scrollTop;
    micScroll.atBottom = (s.scrollHeight - s.scrollTop - s.clientHeight) < BOTTOM_SLOP;
  }
  function applyScroll(isNew) {
    if (micPaneHidden()) return;              // writes are ignored anyway; restored on reveal
    var s = scrollEl(); if (!s) return;
    if (micScroll.atBottom && isNew) {
      s.scrollTop = s.scrollHeight;           // you were following the live turn -- stay with it
      micScroll.top = s.scrollTop;
    } else {
      s.scrollTop = micScroll.top;            // you had stopped somewhere to read -- leave you there
    }
    restorePending = false;
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  /* ---------- the thread strip ---------- */
  function renderChips() {
    el.chips.innerHTML = "";
    threads.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "chip" + (t.slug === current ? " active" : "");
      b.onclick = function () { selectThread(t.slug); };

      var title = document.createElement("div");
      title.className = "chip-title";
      title.textContent = t.title;
      b.appendChild(title);

      var meta = document.createElement("div");
      meta.className = "chip-meta";
      meta.textContent = t.turnCount + " turn" + (t.turnCount === 1 ? "" : "s") +
        " · " + shortModel(t.model);
      b.appendChild(meta);

      if (t.busy) {
        var run = document.createElement("span");
        run.className = "chip-run";
        run.title = "working";
        b.appendChild(run);
      } else if (t.unread > 0 && t.slug !== current) {
        var badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = t.unread;
        b.appendChild(badge);
      }
      el.chips.appendChild(b);
    });
    renderLinesMenu();
  }

  /* ---------- the phone's Lines dropdown ----------
     Same data as the strip, same dot vocabulary (rust = waiting on the operator, green = working).
     It exists because on a phone the strip sits at the TOP of the mic pane, so switching lines
     used to require being scrolled to the top -- and once the cockpit flip started restoring the operator
     to mid-page, your other lines were simply unreachable. */
  function renderLinesMenu() {
    var menu = document.getElementById("linesmenu");
    if (!menu) return;
    menu.innerHTML = "";
    threads.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "lineitem" + (t.slug === current ? " active" : "");
      b.setAttribute("role", "menuitem");
      b.onclick = function () { closeLinesMenu(); selectThread(t.slug); };

      var title = document.createElement("div");
      title.className = "lineitem-title";
      title.textContent = t.title;
      b.appendChild(title);

      var meta = document.createElement("div");
      meta.className = "lineitem-meta";
      meta.textContent = t.turnCount + " turn" + (t.turnCount === 1 ? "" : "s") +
        " · " + shortModel(t.model);
      b.appendChild(meta);

      if (t.busy) {
        var dot = document.createElement("span");
        dot.className = "lineitem-dot is-working";   // NOT "working" -- collides with the dock's .working{display:none}
        dot.title = "working";
        b.appendChild(dot);
      } else if (t.unread > 0 && t.slug !== current) {
        var n = document.createElement("span");
        n.className = "lineitem-count";
        n.textContent = t.unread;
        b.appendChild(n);
      }
      menu.appendChild(b);
    });
    if (!threads.length) {
      var empty = document.createElement("div");
      empty.className = "lineitem-meta";
      empty.style.padding = "8px 4px";
      empty.textContent = "no open lines";
      menu.appendChild(empty);
    }
  }
  function closeLinesMenu() {
    var menu = document.getElementById("linesmenu");
    var tab = document.getElementById("tab-lines");
    if (menu) { menu.classList.remove("open"); menu.hidden = true; }
    if (tab) tab.setAttribute("aria-expanded", "false");
  }
  function toggleLinesMenu() {
    var menu = document.getElementById("linesmenu");
    var tab = document.getElementById("tab-lines");
    if (!menu || !tab) return;
    var open = !menu.classList.contains("open");
    menu.classList.toggle("open", open);
    menu.hidden = !open;
    tab.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function shortModel(m) {
    if (!m) return "";
    return m.replace(/^claude-/, "").replace(/-\d+-\d+$/, function (s) { return s; });
  }

  /* ---------- select + render a thread ---------- */
  function selectThread(slug) {
    current = slug;
    lastTurnSig = "";
    el.newform.classList.add("hidden");
    // A freshly opened line should land on its LATEST turn, not inherit wherever you happened to be
    // parked in the previous one. Reset the scroll memory to "at the bottom" so applyScroll follows
    // the new line down. (Without this, switching lines from the phone menu could drop you into the
    // middle of a conversation you have not read yet.)
    micScroll.top = 0;
    micScroll.atBottom = true;
    // ...and fence it. renderThread() calls rememberScroll() before it swaps content in, which
    // would recompute atBottom from where you were in the PREVIOUS line and undo the reset above.
    // restorePending makes rememberScroll stand down until applyScroll has honored this decision.
    restorePending = true;
    // Selecting a line always means "show me the Microphone" -- you may be on the Cockpit tab.
    var micTab = document.getElementById("tab-mic");
    if (micTab && document.getElementById("pane-mic") && document.getElementById("pane-mic").hidden) {
      micTab.click();
    }
    renderChips();
    loadThread(true);
  }

  function loadThread(markRead) {
    if (!current) return;
    api("/api/thread?slug=" + encodeURIComponent(current) + (markRead ? "&markRead=1" : ""))
      .then(function (t) {
        renderThread(t);
        if (markRead) refreshChips();   // clear the badge we just read
      })
      .catch(function (e) { console.warn(e); });
  }

  function turnSignature(t) {
    return t.turns.map(function (x) { return x.file; }).join(",") + "|" + t.busy;
  }

  function renderThread(t) {
    el.empty.style.display = "none";
    el.deskHead.style.display = "flex";
    el.dock.style.display = "block";
    el.deskTitle.textContent = t.title;
    el.deskModel.value = t.model || "";
    if (el.deskModel.value !== (t.model || "")) {
      // a model id outside the standard four -- add it so the pill can show it
      var extra = document.createElement("option");
      extra.value = t.model; extra.textContent = shortModel(t.model);
      el.deskModel.appendChild(extra);
      el.deskModel.value = t.model;
    }
    el.deskCwd.textContent = t.cwd;

    var sig = turnSignature(t);
    var isNew = sig !== lastTurnSig;
    lastTurnSig = sig;

    // build the stream
    var wrap = document.createElement("div");
    wrap.className = "stream-inner";

    if (t.turns.length === 0) {
      var hint = document.createElement("div");
      hint.className = "empty";
      hint.innerHTML = "<div><div class='mark'>&#8635;</div><h2>" +
        Glass.escapeHtml(t.title) + "</h2><p>No turns yet. Send the first message below to open the session.</p></div>";
      wrap.appendChild(hint);
    } else {
      t.turns.forEach(function (turn, idx) {
        wrap.appendChild(renderTurn(turn, idx === t.turns.length - 1));
      });
    }

    // QUEUED REPLIES ARE VISIBLE (the operator, 2026-08-01 night: sent a message mid-turn and could see
    // only "1 queued" -- your own words gone from every surface until the turn ran). Ghost turns
    // at the stream's end show exactly what waits; the server redacts the arming word before
    // these ever leave it. textContent only -- a queued reply is raw input, never markup.
    (t.queuedTexts || []).forEach(function (q) {
      var g = document.createElement("div");
      g.className = "turn user queued";
      var gt = document.createElement("div");
      gt.className = "turn-tag";
      var gw = document.createElement("span");
      gw.className = "turn-who";
      gw.textContent = "the operator";
      gt.appendChild(gw);
      var chip = document.createElement("span");
      chip.className = "queued-chip";
      chip.textContent = "QUEUED — runs when this turn ends";
      gt.appendChild(chip);
      g.appendChild(gt);
      var gb = document.createElement("div");
      gb.className = "turn-body";
      gb.textContent = q;
      g.appendChild(gb);
      wrap.appendChild(g);
    });

    // working state
    if (t.busy) {
      el.working.classList.add("on");
      el.workingTxt.textContent = "working…" + (t.queued ? " (" + t.queued + " queued)" : "");
      el.replybox.disabled = false;   // the operator may queue the next reply
      el.sendbtn.disabled = false;
    } else {
      el.working.classList.remove("on");
      el.replybox.disabled = false;
      el.sendbtn.disabled = false;
    }

    // swap in -- capture the reading position FIRST; clearing the children clamps scrollTop to 0
    rememberScroll();
    el.stream.innerHTML = "";
    el.stream.appendChild(wrap);

    // linkify file paths across the whole stream (skips code/links)
    Glass.linkify(wrap);

    applyScroll(isNew);
  }

  function renderTurn(turn, isLatest) {
    var div = document.createElement("div");
    div.className = "turn " + turn.role + (turn.armed ? " armed" : "") + (isLatest ? " latest" : "");

    var tag = document.createElement("div");
    tag.className = "turn-tag";
    var who = document.createElement("span");
    who.className = "turn-who";
    who.textContent = turn.role === "assistant" ? "Operator" :
                      turn.role === "user" ? "the operator" : "the mic";
    tag.appendChild(who);
    // the Foreman Door: a rust badge on the turn the operator armed (the word they said is
    // already redacted server-side, so this only marks THAT an armed turn happened).
    if (turn.armed) {
      var armedChip = document.createElement("span");
      armedChip.className = "armed-chip";
      armedChip.textContent = "ARMED";
      armedChip.title = "This turn ran with the Foreman's elevated tools.";
      tag.appendChild(armedChip);
    }
    var meta = document.createElement("span");
    meta.className = "turn-meta";
    var bits = [];
    if (turn.ts) bits.push(fmtTime(turn.ts));
    if (turn.model) bits.push(shortModel(turn.model));
    if (turn.cost) bits.push("$" + Number(turn.cost).toFixed(4));
    meta.textContent = bits.join("  ·  ");
    tag.appendChild(meta);
    div.appendChild(tag);

    var body = document.createElement("div");
    body.className = "turn-body";
    body.innerHTML = Glass.md(turn.body || "");
    // images in a turn that reference /file paths already resolve; pasted-image
    // markdown was written with a /file?path= url by the server.

    // copy buttons on code blocks (the operator's ask, 2026-07-19): one click grabs the
    // whole block -- no scroll-selecting a wide kickoff block by hand.
    body.querySelectorAll("pre").forEach(function (pre) {
      var wrap = document.createElement("div");
      wrap.className = "prewrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement("button");
      btn.className = "copybtn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.onclick = function (e) {
        e.stopPropagation();
        var text = pre.innerText.replace(/ /g, " ");
        function done() {
          btn.textContent = "copied ✓";
          setTimeout(function () { btn.textContent = "copy"; }, 1600);
        }
        function fallback() {
          var ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); done(); }
          catch (err) { alert("Copy failed — select the text by hand."); }
          document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else { fallback(); }
      };
      wrap.appendChild(btn);
    });
    div.appendChild(body);
    return div;
  }

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return iso; }
  }

  /* ---------- sending a reply ---------- */
  function send() {
    if (!current) return;
    var text = el.replybox.value.trim();
    var images = pending.map(function (p) { return p.path; });
    if (!text && images.length === 0) return;

    el.replybox.value = "";
    autosize();
    var carry = pending.slice();
    pending = [];
    renderPastes();

    api("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: current, text: text, images: images })
    }).then(function () {
      loadThread(false);   // show the operator's turn immediately + working state
      refreshChips();
    }).catch(function (e) {
      // restore on failure
      el.replybox.value = text;
      pending = carry;
      renderPastes();
      alert("Send failed: " + e.message);
    });
  }

  el.sendbtn.onclick = send;
  el.replybox.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  el.replybox.addEventListener("input", autosize);
  function autosize() {
    el.replybox.style.height = "auto";
    el.replybox.style.height = Math.min(el.replybox.scrollHeight, 200) + "px";
  }

  /* ---------- stop ---------- */
  el.stopbtn.onclick = function () {
    if (!current) return;
    api("/api/stop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: current })
    }).then(function () { loadThread(false); refreshChips(); })
      .catch(function (e) { console.warn(e); });
  };

  /* ---------- mid-line model switch (the 2026-07-19 dogfood fix) ----------
     The header pill is a selector; a change takes effect on the line's NEXT
     turn (the server just updates thread.json -- no restart, no rebirth). */
  el.deskModel.onchange = function () {
    if (!current) return;
    api("/api/model", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: current, model: el.deskModel.value })
    }).then(function () { refreshChips(); })
      .catch(function (e) { alert("Model switch failed: " + e.message); loadThread(false); });
  };

  /* ---------- paste a screenshot (load-bearing) ---------- */
  el.replybox.addEventListener("paste", function (e) {
    if (!current) return;
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var file = items[i].getAsFile();
        if (file) { e.preventDefault(); uploadPaste(file); }
      }
    }
  });

  /* ---------- the paperclip: attach from the phone (2026-08-02) ----------
     Same pipeline as a paste, different door. Pasting is a desk gesture -- a phone
     has no way to paste a photo it just took -- so the image lane was desk-only.
     The button opens the OS picker (Camera / Photo Library on a phone), and every
     image it hands back goes through uploadPaste(), unchanged.
     The type guard is here rather than at the server because the picker is where a
     phone can hand you something the server won't take (iOS HEIC, mainly): a named
     "can't take a .heic" beats the server's opaque "not an image data URL". */
  var CLIP_OK = { "image/png": 1, "image/jpeg": 1, "image/jpg": 1, "image/gif": 1, "image/webp": 1 };

  if (el.clipbtn && el.clipinput) {
    el.clipbtn.onclick = function () {
      if (!current) return;
      el.clipinput.click();
    };
    el.clipinput.addEventListener("change", function () {
      var files = el.clipinput.files || [];
      var rejected = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (CLIP_OK[(f.type || "").toLowerCase()]) uploadPaste(f);
        else rejected.push((f.name || "that file") + " (" + (f.type || "unknown type") + ")");
      }
      // reset, or picking the SAME photo twice in a row fires no change event
      el.clipinput.value = "";
      if (rejected.length) {
        alert("Can't attach " + rejected.join(", ") +
              ".\nThe Mic takes PNG, JPEG, GIF and WebP." +
              "\n(iPhone: Settings > Camera > Formats > Most Compatible saves photos as JPEG.)");
      }
    });
  }

  function uploadPaste(file) {
    var reader = new FileReader();
    reader.onload = function () {
      api("/api/paste", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: current, dataURL: reader.result })
      }).then(function (r) {
        pending.push({ path: r.path, url: r.url });
        renderPastes();
      }).catch(function (e) { alert("Attach failed: " + e.message); });
    };
    reader.readAsDataURL(file);
  }

  function renderPastes() {
    el.pastes.innerHTML = "";
    pending.forEach(function (p, idx) {
      var chip = document.createElement("div");
      chip.className = "pchip";
      var img = document.createElement("img");
      img.src = p.url;
      chip.appendChild(img);
      var x = document.createElement("button");
      x.className = "x"; x.textContent = "×";
      x.title = "remove";
      x.onclick = function () { pending.splice(idx, 1); renderPastes(); };
      chip.appendChild(x);
      el.pastes.appendChild(chip);
    });
  }

  /* ---------- the "where it works" shortcuts ----------
     Any folders you list in mic.config.json are appended to the picker once, at first load.
     The first option -- the workspace root, value "" -- is authored in index.html and always
     stays, so an empty or missing list simply means the picker offers the sensible default and
     nothing else. Paths are never written into the page; they arrive from the server. */
  var foldersFilled = false;
  function fillFolders(list) {
    if (foldersFilled || !Array.isArray(list) || !list.length) return;
    var sel = document.getElementById("nf-cwd");
    if (!sel) return;
    list.forEach(function (f) {
      if (!f || typeof f.path !== "string" || !f.path) return;
      var o = document.createElement("option");
      o.value = f.path;
      o.textContent = f.label || f.path;
      sel.appendChild(o);
    });
    foldersFilled = true;
  }

  /* ---------- new-thread form ---------- */
  el.newbtn.onclick = function () {
    el.newform.classList.toggle("hidden");
    if (!el.newform.classList.contains("hidden")) document.getElementById("nf-title").focus();
  };
  el.nfCancel.onclick = function () { el.newform.classList.add("hidden"); };
  el.newform.onsubmit = function (e) {
    e.preventDefault();
    var body = {
      title: document.getElementById("nf-title").value,
      cwd: document.getElementById("nf-cwd").value,
      model: document.getElementById("nf-model").value
    };
    api("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      el.newform.classList.add("hidden");
      el.newform.reset();
      return refreshChips().then(function () { selectThread(r.thread.slug); });
    }).catch(function (e) { alert("Could not open the line: " + e.message); });
  };

  /* ---------- polling: strip badges + busy state ---------- */
  function refreshChips() {
    return api("/api/threads").then(function (r) {
      threads = r.threads || [];
      renderChips();
      fillFolders((r.env || {}).folders);
      // the mic tab's status dot (visible from the Cockpit tab):
      // rust = something waits on the operator (wins) · green = lines working · none = quiet
      var micdot = document.getElementById("micdot");
      if (micdot) {
        var anyUnread = threads.some(function (t) { return (t.unread || 0) > 0; });
        var anyBusy = threads.some(function (t) { return t.busy || (t.queued || 0) > 0; });
        // "is-working", not "working" -- the bare .working belongs to the dock's spinner row
        micdot.className = "tabdot" + (anyUnread ? " unread" : (anyBusy ? " is-working" : ""));
      }
      // the Lines tab carries the same aggregate dot -- on a phone that tab is where you look
      var linesdot = document.getElementById("linesdot");
      if (linesdot) {
        var u = threads.some(function (t) { return (t.unread || 0) > 0; });
        var w = threads.some(function (t) { return t.busy || (t.queued || 0) > 0; });
        linesdot.className = "tabdot" + (u ? " unread" : (w ? " is-working" : ""));
      }
      // if the active thread's turn set or busy state changed, re-pull it
      if (current) {
        var t = threads.filter(function (x) { return x.slug === current; })[0];
        if (t) {
          var sig = t.turns ? "" : ("" + t.turnCount + "|" + t.busy);
          // cheap heuristic: reload the active thread if its turnCount/busy moved
          loadThreadIfChanged(t);
        } else {
          // the active line was CLOSED (archived off the strip) -- clear the pane
          current = null;
          activeSnapshot = { turnCount: -1, busy: null };
          if (el.deskHead) el.deskHead.style.display = "none";
          if (el.dock) el.dock.style.display = "none";
          if (el.empty) el.empty.style.display = "";
          if (el.stream) {
            var turns = el.stream.querySelectorAll(".turn");
            for (var i = 0; i < turns.length; i++) turns[i].remove();
          }
        }
      }
    }).catch(function (e) { console.warn(e); });
  }

  var activeSnapshot = { turnCount: -1, busy: null };
  function loadThreadIfChanged(t) {
    if (t.turnCount !== activeSnapshot.turnCount || t.busy !== activeSnapshot.busy) {
      activeSnapshot = { turnCount: t.turnCount, busy: t.busy };
      loadThread(false);
    }
  }

  // poll every 1.6s -- chat cadence, thin
  setInterval(refreshChips, 1600);

  /* ---------- tabs: Microphone | Cockpit ---------- */
  (function tabs() {
    var tabbar = document.getElementById("tabbar");
    if (!tabbar) return;
    var buttons = tabbar.querySelectorAll(".tab");
    var panes = {
      mic: document.getElementById("pane-mic"),
      cockpit: document.getElementById("pane-cockpit")
    };
    function show(which) {
      // instant flip -- both panes stay mounted; we only toggle visibility, so
      // the mic pane keeps its polling and the cockpit iframe keeps its loaded state.
      // No reload either way. The mic's SCROLL, though, does not survive display:none
      // (see the scroll-memory block above), so bank it before hiding and put it back
      // after showing -- on the next frame, once layout has run and the metrics are real.
      if (which !== "mic") rememberScroll();
      Object.keys(panes).forEach(function (k) {
        if (panes[k]) panes[k].hidden = (k !== which);
      });
      if (which === "mic") {
        // Restore once layout has run. restorePending fences the gap so a poll landing in
        // between cannot bank the (still-zero) scrollTop as your position.
        restorePending = true;
        applyScroll(true);                                   // usually enough on its own
        requestAnimationFrame(function () {
          restorePending = true;
          applyScroll(true);                                 // ...and again once metrics are real
          // On a phone the DOCUMENT is the scroller, and it only grows back to full height once
          // the revealed mic pane has re-laid-out. A restore that runs before that clamps against
          // a still-short page -- i.e. lands near the top, which is the whole bug. One more pass
          // after it settles.
          setTimeout(function () { restorePending = true; applyScroll(true); }, 60);
        });
      }
      buttons.forEach(function (b) {
        var pane = b.getAttribute("data-pane");
        if (!pane) return;            // the Lines tab is a menu -- it owns aria-expanded, not aria-selected
        var on = pane === which;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    // The Lines tab is a menu, not a pane -- it carries no data-pane and must not run show().
    var linesTab = document.getElementById("tab-lines");
    if (linesTab) {
      linesTab.onclick = function (e) { e.stopPropagation(); toggleLinesMenu(); };
      // tap anywhere else, or Escape, closes it
      document.addEventListener("click", function (e) {
        var menu = document.getElementById("linesmenu");
        if (!menu || !menu.classList.contains("open")) return;
        if (menu.contains(e.target) || e.target === linesTab) return;
        closeLinesMenu();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeLinesMenu();
      });
    }

    buttons.forEach(function (b) {
      var which0 = b.getAttribute("data-pane");
      if (!which0) return;                       // skip the Lines tab
      b.onclick = function () {
        var which = b.getAttribute("data-pane");
        closeLinesMenu();
        show(which);
        try { history.replaceState(null, "", which === "cockpit" ? "#cockpit" : "#"); } catch (e) {}
      };
    });
    // deep-link: #cockpit opens straight to the cockpit tab (bookmarkable)
    if ((location.hash || "").toLowerCase() === "#cockpit") show("cockpit");
  })();

  /* ---------- boot ---------- */
  refreshChips().then(function () {
    if (threads.length && !current) selectThread(threads[0].slug);
  });
})();

/* ============================================================================
   THE IN-APP FILE VIEWER -- file links open in an overlay INSIDE the
   Microphone, never a new browser tab (the operator's shadow-week refinement of the
   file-links ruling). Esc or the X closes; "open in tab" is the escape hatch.
   ========================================================================== */
(function () {
  "use strict";
  var ov = document.createElement("div");
  ov.className = "viewer hidden";
  ov.innerHTML =
    '<div class="viewer-card">' +
    '  <div class="viewer-head">' +
    '    <span class="viewer-path" id="viewer-path"></span>' +
    '    <button class="viewer-btn" id="viewer-newtab">open in tab</button>' +
    '    <button class="viewer-btn" id="viewer-close">&#10005; close</button>' +
    '  </div>' +
    '  <iframe class="viewer-frame" id="viewer-frame" title="File viewer"></iframe>' +
    '</div>';
  document.body.appendChild(ov);
  var frame = document.getElementById("viewer-frame");
  var pathEl = document.getElementById("viewer-path");
  var currentUrl = "";

  function open(url) {
    currentUrl = url;
    try {
      var q = url.split("path=")[1] || "";
      pathEl.textContent = decodeURIComponent(q.split("&")[0]);
    } catch (e) { pathEl.textContent = url; }
    frame.src = url;
    ov.classList.remove("hidden");
  }
  function close() {
    ov.classList.add("hidden");
    frame.src = "about:blank";
  }
  document.getElementById("viewer-close").onclick = close;
  document.getElementById("viewer-newtab").onclick = function () {
    if (currentUrl) window.open(currentUrl, "_blank");
    close();
  };
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !ov.classList.contains("hidden")) close();
  });
  // intercept every /file link on the page (turns render them constantly)
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("/file?path=") !== 0) return;
    e.preventDefault();
    open(href);
  }, true);
  // inside the viewer iframe, dir-listing links navigate the IFRAME (same
  // origin, no interception needed there) -- so folder browsing stays in-app.
})();
