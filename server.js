/* ============================================================================
   THE MICROPHONE  --  server.js   (folder stays mic/; slug renames at port)
   ----------------------------------------------------------------------------
   The cockpit's talking sibling. A thin web surface that multiplexes the operator's
   live threads into one conversation: full prose turns, a thread strip with
   unread badges, replies routed back to the owning session. "Talk into it,
   run the shop."

   ONE file, node stdlib ONLY (http, fs, path, child_process, crypto, os, url).
   No npm dependencies. Binds 127.0.0.1:8080 (override with MIC_PORT; GLASS_PORT
   still honored -- the box's systemd unit sets the old name).

   The heart is the RESUME SPAWNER (per the G1 round-trip proof): a reply is
   delivered by spawning a short-lived `claude -p --resume <sessionId>` process
   whose cwd is the thread's folder. No long-lived process to babysit; the
   conversation lives on disk and is reloaded on each resume. Replies are
   serialized strictly per thread (sessions don't lock; concurrent resumes fork
   the transcript -- so one in-flight child per thread, queue the rest).

   Thin-glass law: no intelligence here, no state beyond the thread files. If
   the Mic dies, the sessions live on and VS Code opens them.
   ========================================================================== */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

/* ============================================================================
   CONFIG  --  mic.config.json, beside this file
   ----------------------------------------------------------------------------
   Everything machine-specific lives in ONE file so the code stays identical on
   every install. Copy mic.config.example.json to mic.config.json and edit it;
   every key is optional and falls back to the defaults below, so an empty
   `{}` boots a working Microphone.
   ========================================================================== */
const ROOT = __dirname;                       // the folder this server lives in
const CONFIG_FILE = path.join(ROOT, "mic.config.json");

function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}
function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    if (e.code !== "ENOENT") {
      /* A malformed config is a HARD stop, never a silent fallback to defaults. Booting on
         defaults after a typo is how you end up with lines rooted somewhere you did not mean. */
      console.error("mic.config.json is present but unreadable: " + e.message);
      process.exit(2);
    }
    console.log("no mic.config.json — running on defaults (copy mic.config.example.json to change that)");
  }
  return raw;
}
const CFG = loadConfig();
const CFG_MODELS = CFG.models || {};

const PORT = parseInt(process.env.MIC_PORT, 10) || parseInt(CFG.port, 10) || 8080;
const HOST = "127.0.0.1";                     // loopback ONLY — see docs/SECURITY.md before changing this
const THREADS_DIR = path.join(ROOT, "threads");
const TEMPLATES_DIR = path.join(ROOT, "charters");
/* The workspace: the tree your lines work in, and the whitelist root for the file viewer.
   Default is the parent of this folder, which is what you get if you clone the Microphone
   into the project it runs. Relative paths resolve against this folder. */
const WORKSPACE_ROOT = path.resolve(ROOT, expandHome(CFG.workspaceRoot || ".."));
/* Where the approval word and any armed-turn secrets live — deliberately OUTSIDE the tree,
   so no line can read them by walking the workspace and no commit can ever carry them. */
const CREDENTIALS_DIR = expandHome(CFG.credentialsDir || path.join(os.homedir(), ".mic"));
/* THE DEFAULT BRAIN FOR A NEWLY OPENED LINE.
   Set it to the strongest model you are willing to spend on, not the cheapest: if you open ten
   or fifteen focused lines a day, the weakest brain is a bad thing for a line to be BORN with,
   and you rarely want to think about the choice at open time. You can still name a model when
   you open a line ("open a line for X on Sonnet"), and you can switch mid-line at any point --
   apiSetModel writes thread.json and runTurn re-reads it every turn, so the switch lands on the
   NEXT turn with the conversation intact.
   ⚠ PIN SITE: model ids also appear in mic.config.example.json and the two <select> blocks in
   index.html. Change a generation and you must walk all three. */
const DEFAULT_MODEL = CFG_MODELS.default || "claude-sonnet-5";

/* The Desk is deliberately NOT on the default. It is the standing master line -- a router that
   dispatches to other lines -- so it wants the FAST cheap model, not the deep one. Keeping it
   separate means raising the default for new lines cannot silently re-brand the Desk as a side
   effect. (The live Desk keeps whatever its thread.json already says -- it never closes, so this
   only applies when it is first scaffolded.) */
const DESK_MODEL = CFG_MODELS.desk || "claude-haiku-4-5";

/* ============================================================================
   KNOWN MODELS + ALIASES  (built after the first real line opened on a STALE model)
   A real failure worth understanding before you edit this: the Desk was asked to open a line,
   chose the model itself, announced "on Opus" -- and passed a model id it had produced from its
   own knowledge, a generation out of date. No file was wrong. An AGENT invented the id, and an
   invented id is a pin site nothing can watch, because it is a sentence rather than a file.
   Two defences, because either alone fails:
     - the Desk is told never to invent an id (charters/DESK-CHARTER.md), and
     - the server refuses to accept one. A friendly word maps to the current id; anything
       unrecognised is REJECTED at create time rather than silently spawning a line on a model
       that may not exist -- which otherwise surfaces only as "**The turn failed** (exit 1)"
       with no error output at all.
   ⚠ PIN SITE. On a model-generation change, update mic.config.json (or these defaults) AND the
   two <select> blocks in index.html. */
const KNOWN_MODELS = Array.isArray(CFG_MODELS.known) && CFG_MODELS.known.length
  ? CFG_MODELS.known
  : ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
const MODEL_ALIASES = Object.assign({
  // The friendly words you actually say out loud. Point them wherever you like.
  "opus": "claude-opus-5", "sonnet": "claude-sonnet-5", "haiku": "claude-haiku-4-5",
}, CFG_MODELS.aliases || {}, { "default": DEFAULT_MODEL });
/* Returns {model} on success or {error} -- never a silent pass-through. */
function resolveModel(raw) {
  const want = String(raw || "").trim();
  if (!want) return { model: DEFAULT_MODEL };
  const key = want.toLowerCase();
  if (MODEL_ALIASES[key]) {
    const to = MODEL_ALIASES[key];
    if (to !== want) console.log("model alias: '" + want + "' -> " + to);
    return { model: to, was: want !== to ? want : undefined };
  }
  if (KNOWN_MODELS.indexOf(want) !== -1) return { model: want };
  return { error: "unknown model '" + want + "'. Known: " + KNOWN_MODELS.join(", ") };
}

/* ============================================================================
   THE FOREMAN DOOR
   ----------------------------------------------------------------------------
   Exactly one line may carry role:"foreman" -- the master's chair.
   Two postures per turn:
     unarmed (default): reads + drafts anywhere in the tree, stages actions,
        cards them. NO outbound capability is present in the spawn.
     armed  (one turn): when YOUR reply carries the approval word, THAT spawn
        gets the elevated helpers (+ their secrets in env) and the turn is
        ledgered. The elevation dies with the turn -- never written to disk.
   The word lives OUTSIDE the tree (credentialsDir/foreman-word.txt); it is read
   per reply (rotatable with no restart) and redacted to [ARMED] before anything
   is written to disk. Data can NEVER arm the door: only your own user-role reply
   on the foreman line is scanned -- never assistant turns, never file contents.

   ⚠ READ docs/SECURITY.md BEFORE ARMING ANYTHING. The word is a PRESENCE
   CEREMONY -- proof a human is at the keyboard and approving -- and it is NOT a
   boundary against a hostile line: every line runs as the same OS user, so any
   line can read the word file. Never put a destructive action behind the word
   alone. The whole door is off by default; you turn it on in mic.config.json.
   ========================================================================== */
const CFG_FOREMAN = CFG.foreman || {};
const FOREMAN_ENABLED = CFG_FOREMAN.enabled === true;   // OFF unless you say otherwise
const FOREMAN_MODEL = CFG_MODELS.foreman || DEFAULT_MODEL;
const FOREMAN_WORD_FILE = path.join(CREDENTIALS_DIR, "foreman-word.txt");
const FOREMAN_LEDGER = path.join(ROOT, "FOREMAN-LEDGER.md");
// unarmed baseline: read + draft + review; reaches nothing external.
const FOREMAN_BASE_TOOLS = [
  "Read", "Grep", "Glob", "Edit", "Write",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)"
];
/* ARMED-ONLY ADDITIONS. Each entry is a LITERAL path to a hardened helper script in
   helpers/ -- nothing wildcard on the dangerous surface, because "Bash(*)" on an armed turn
   is the same as no door at all. The pattern every helper follows (examples/README.md spells
   it out, examples/hello-helper.sh is a working one you can copy):
     - pin the method + host + path INSIDE the script, so the agent chooses arguments, never
       the destination;
     - read the secret from the environment this server hands the armed spawn, NEVER from
       argv (argv is visible in the process list and lands in transcripts);
     - `set -euo pipefail`, and fail closed when the secret is missing.
   List your helpers by FILENAME in mic.config.json (foreman.helpers). They are resolved
   against helpers/ here, so the same config works on every machine you run this on. */
const FOREMAN_BIN = path.join(ROOT, "helpers");
const foremanTool = (script) => "Bash(" + path.join(FOREMAN_BIN, script) + ":*)";
const FOREMAN_ELEVATED_TOOLS = (Array.isArray(CFG_FOREMAN.helpers) ? CFG_FOREMAN.helpers : [])
  .filter(s => typeof s === "string" && /^[A-Za-z0-9._-]+$/.test(s))   // filename only — no path traversal
  .map(foremanTool);
/* ============================================================================
   THE HELPER BASELINE  --  the subtlest guard in this file, and the one worth copying
   A shakedown found that an UNARMED foreman turn could rewrite the very scripts an ARMED turn
   would later execute with real credentials in its environment. Measured, not theorised: an
   unarmed turn appended a line to a deploy helper using only the Write/Edit tools, which carry
   no path bound at all. The trap is patient -- the rewrite just sits there until the next time
   you say the word, and a ledger that records only exit codes says `ok` either way.
   The fix is a baseline hashed into MEMORY at server start and re-verified at elevation time.
   Rewriting a helper mid-session now fails the check. Re-baselining requires restarting the
   server, which a line cannot do (the spawn-env scrub removes its reach to the service manager).
   Chosen over root-owning helpers/ because those files are git-tracked, and root ownership
   would break `git pull` on every update. And chosen over an on-disk hash manifest, because a
   manifest is writable by the same line that rewrote the script -- so it would prove nothing. */
// (crypto is already required at the top of this file)
let FOREMAN_BIN_BASELINE = null;   // { file: sha256 } captured once, at boot
function hashForemanBin() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(FOREMAN_BIN).filter(f => f.endsWith(".sh")).sort(); }
  catch (e) { return out; }
  for (const f of names) {
    try {
      out[f] = crypto.createHash("sha256")
                     .update(fs.readFileSync(path.join(FOREMAN_BIN, f))).digest("hex");
    } catch (e) { out[f] = "UNREADABLE"; }
  }
  return out;
}
/* Returns [] when the helpers are untouched, or a list of what changed. */
function foremanBinDrift() {
  if (!FOREMAN_BIN_BASELINE) return [];        // baseline never captured -> do not block
  const now = hashForemanBin();
  const drift = [];
  for (const f of Object.keys(FOREMAN_BIN_BASELINE)) {
    if (!(f in now)) drift.push(f + " (deleted)");
    else if (now[f] !== FOREMAN_BIN_BASELINE[f]) drift.push(f + " (modified)");
  }
  for (const f of Object.keys(now)) {
    if (!(f in FOREMAN_BIN_BASELINE)) drift.push(f + " (added)");
  }
  return drift;
}

/* ARMED-ONLY ENV: read the secrets FRESH at armed-turn time and hand them to that ONE spawn.
   A missing file simply omits its variable, so the helper that needed it fails closed rather
   than running against nothing. Keys live only in the child's environment for the turn; they
   never touch argv, disk, or the ledger.
   Map environment-variable name -> filename inside credentialsDir, in mic.config.json:
       "foreman": { "secrets": { "MY_API_KEY": "my-api.key" } }
   Ships EMPTY. Nothing is handed to any spawn until you put something here. */
function foremanArmedEnv() {
  const dir = CREDENTIALS_DIR;
  const load = (file) => {
    try {
      // a bearer token / API key is a SINGLE line; some key files carry a
      // label or notes on later lines. Take
      // the first non-empty line -- never the whole blob: an embedded newline
      // in an Authorization header value makes curl reject the request (exit 43).
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const first = raw.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0);
      return first || null;
    } catch (e) { return null; }
  };
  const env = {};
  const map = (CFG_FOREMAN.secrets && typeof CFG_FOREMAN.secrets === "object") ? CFG_FOREMAN.secrets : {};
  for (const varName of Object.keys(map)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(varName)) continue;                       // env-var names only
    const file = map[varName];
    if (typeof file !== "string" || !/^[A-Za-z0-9._-]+$/.test(file)) continue;  // filename only
    const v = load(file);
    if (v) env[varName] = v;
  }
  return env;
}

/* THE FOLD IN-TRAY  2026-08-01). One small JSON file = the live truth of
   "closed lines not yet folded into a commit." closeLine() appends; every foreman turn gets it
   injected (same live-state pattern as the Desk's strip); /api/shop counts it for the Shop
   Floor's chip; a successful fold (or a master-session sweep) clears it. CLOSED-LINES.md stays
   the permanent append-only history -- this file is only the pending queue, so the two never
   fight about what "swept" means. */
const FOREMAN_TRAY = path.join(ROOT, "foreman-notes.json");
function readForemanTray() {
  try {
    const v = JSON.parse(fs.readFileSync(FOREMAN_TRAY, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

// read the approval word fresh each reply; a missing file => arming never fires.
function readForemanWord() {
  try { return fs.readFileSync(FOREMAN_WORD_FILE, "utf8").trim(); }
  catch (e) { return ""; }
}
function reWord(word) { return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// whole-token, case-sensitive: the reply carries the word only as a standalone token.
function replyCarriesWord(text, word) {
  if (!word) return false;
  return new RegExp("(^|[^A-Za-z0-9])" + reWord(word) + "([^A-Za-z0-9]|$)").test(text || "");
}
// redact every whole-token occurrence of the word to [ARMED].
function redactWord(text, word) {
  if (!word || !text) return text;
  return text.replace(new RegExp("(^|[^A-Za-z0-9])" + reWord(word) + "(?=[^A-Za-z0-9]|$)", "g"), "$1[ARMED]");
}
/* The restart guard chain (POST /api/restart — see the handler for the full doctrine).
   PURE on purpose: (given word, expected word, busy slugs, systemd?, force?) -> {code, obj},
   no I/O, so the auth + busy logic is unit-testable without touching a live server. */
function restartDecision(given, word, busyLines, underSystemd, force) {
  if (!word) return { code: 503, obj: { ok: false,
    error: "no admin word on disk (the credentials dir missing or empty) — restart path disabled, failing closed" } };
  if (typeof given !== "string" || given.length === 0 || given !== word)
    return { code: 403, obj: { ok: false, error: "bad or missing word" } };
  if (!underSystemd) return { code: 503, obj: { ok: false,
    error: "server is not systemd-managed (no INVOCATION_ID): exiting would be a SHUTDOWN, not a restart. Restart it from a shell: systemctl --user restart mic" } };
  if (busyLines.length && !force) return { code: 409, obj: { ok: false, busy: busyLines,
    error: "line(s) mid-turn or queued: " + busyLines.join(", ") + " — a restart would kill them. Pass force:true to restart anyway." } };
  return { code: 200, obj: { ok: true, restarting: true, exit_code: 64,
    back: "systemd (Restart=on-failure, RestartSec=5) brings the server back in ~5s with fresh code",
    killed: busyLines } };
}
function nowCT() { return new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false }); }
function oneLine(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 200); }
function appendForemanLedger(grantReply, action, outcome) {
  try {
    if (!fs.existsSync(FOREMAN_LEDGER)) {
      fs.writeFileSync(FOREMAN_LEDGER,
        "# FOREMAN LEDGER\n\n*Every armed foreman turn, appended mechanically -- append-only, " +
        "git-tracked, human-legible. The approval word is redacted to `[ARMED]` before it is written.*\n\n" +
        "| when (CT) | granting reply (word redacted) | action | outcome |\n|---|---|---|---|\n");
    }
    fs.appendFileSync(FOREMAN_LEDGER,
      "| " + nowCT() + " | " + oneLine(grantReply) + " | " + oneLine(action) + " | " + oneLine(outcome) + " |\n");
  } catch (e) { console.log("foreman-ledger write failed: " + e.message); }
}

/* ---- the whitelist root for the file viewer --------------------------------
   The file viewer will serve a file ONLY from inside this tree. It is the same
   workspace the lines work in, resolved once from config at boot -- never from a
   query parameter, which is the whole point of having a whitelist. */

/* ---- resolve the claude binary ---------------------------------------------
   Order: mic.config.json claudeBin -> CLAUDE_BIN env -> `claude` on PATH ->
   the newest installed VS Code extension binary (the Windows fallback).
   Whatever it lands on is printed at boot, so a wrong one is visible. */
function resolveClaudeBin() {
  const fromCfg = expandHome(CFG.claudeBin);
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  /* `claude` on PATH — the normal case for a native install on macOS or Linux. */
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["claude", "claude.exe"]) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) { /* keep looking */ }
    }
  }
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  let best = null, bestVer = null;
  try {
    for (const name of fs.readdirSync(extDir)) {
      const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-win32-x64$/);
      if (!m) continue;
      const bin = path.join(extDir, name, "resources", "native-binary", "claude.exe");
      if (!fs.existsSync(bin)) continue;
      const ver = [+m[1], +m[2], +m[3]];
      if (!bestVer || cmpVer(ver, bestVer) > 0) { bestVer = ver; best = bin; }
    }
  } catch (e) { /* extDir missing on a non-Windows box -- rely on CLAUDE_BIN */ }
  return best;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
const CLAUDE_BIN = resolveClaudeBin();

/* ============================================================================
   thread storage helpers
   ========================================================================== */
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function slugify(title) {
  let s = String(title || "thread").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "thread";
}
function uniqueSlug(base) {
  let slug = base, n = 2;
  while (fs.existsSync(path.join(THREADS_DIR, slug))) { slug = base + "-" + n; n++; }
  return slug;
}
function threadDir(slug) { return path.join(THREADS_DIR, slug); }
function threadMetaPath(slug) { return path.join(threadDir(slug), "thread.json"); }
function readMeta(slug) {
  try { return JSON.parse(fs.readFileSync(threadMetaPath(slug), "utf8")); }
  catch (e) { return null; }
}
/* ATOMIC (hardened 2026-07-25 by the shakedown). This was a bare writeFileSync, which O_TRUNCs
   first -- so thread.json is ZERO BYTES for a window on every call, and bumpUnread calls this
   after EVERY turn on EVERY line. A crash, an OOM kill or a power cut inside that window left a
   truncated or empty thread.json, which used to kill the entire Mic in a permanent crash loop
   (see the guards in readMeta/listThreads/listTurns). Write beside it, then rename -- rename is
   atomic on the same filesystem, so a reader sees either the old file or the new one, never a
   half-written one. */
function writeMeta(meta) {
  const target = threadMetaPath(meta.slug);
  const tmp = target + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, target);
  } catch (e) {
    console.log("writeMeta failed for " + meta.slug + ": " + e.message);
  }
}
function archiveDir(slug) { return path.join(threadDir(slug), "archive"); }
function listTurns(slug) {
  const dir = archiveDir(slug);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d+-turn\.md$/.test(f)); }
  catch (e) { return []; }
  files.sort();
  return files.map(f => {
    /* Per-file guard (added 2026-07-25). An unreadable turn file -- wrong permissions, a bad
       sector, a partial write -- used to throw out of here and kill the process, and this path is
       reached from BOTH /api/threads and /api/thread, so even the single-line view was unsafe.
       A damaged turn now renders as a visible placeholder instead of ending the Mic. */
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      return { file: f, n: parseInt(f, 10), ...parseTurn(raw) };
    } catch (e) {
      return { file: f, n: parseInt(f, 10), role: "assistant", ts: "", model: "", cost: "",
               body: "_(this turn file could not be read: " + e.code + ")_" };
    }
  });
}
function nextTurnNumber(slug) {
  const turns = listTurns(slug);
  return turns.length ? turns[turns.length - 1].n + 1 : 1;
}
function parseTurn(raw) {
  const meta = {};
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    fm[1].split(/\r?\n/).forEach(line => {
      const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2];
    });
    body = fm[2];
  }
  return { role: meta.role || "assistant", ts: meta.ts || "", model: meta.model || "",
           cost: meta.cost || "", armed: meta.armed === "true",
           body: body.replace(/^\n+/, "") };
}
// `extra` (optional): frontmatter flags beyond the standard four. Today only
// { armed: true } -- stamped on the foreman turn the operator armed, so the UI can badge it.
function writeTurn(slug, role, model, cost, body, extra) {
  const n = nextTurnNumber(slug);
  const num = String(n).padStart(3, "0");
  const ts = new Date().toISOString();
  let fm = `---\nts: ${ts}\nrole: ${role}\nmodel: ${model || ""}\ncost: ${cost || ""}\n`;
  if (extra && extra.armed) fm += `armed: true\n`;
  fm += `---\n\n`;
  fs.writeFileSync(path.join(archiveDir(slug), `${num}-turn.md`), fm + body + "\n");
  return n;
}

/* ============================================================================
   the resume spawner  --  the heart
   ----------------------------------------------------------------------------
   per-thread serialization: state[slug] = { child, queue:[], busy }
   ========================================================================== */
const state = {};   // slug -> { child, queue, busy, startedAt }
function threadState(slug) {
  if (!state[slug]) state[slug] = { child: null, queue: [], busy: false, startedAt: 0 };
  return state[slug];
}

/* `pending` (optional) = {body, extra} for the USER turn this item will answer. It is written to
   the archive when the item actually RUNS, not when it was POSTed -- see pump(). */
function enqueueReply(slug, prompt, armed, grantReply, pending) {
  const st = threadState(slug);
  st.queue.push({ prompt, armed: !!armed, grantReply: grantReply || "", pending: pending || null });
  pump(slug);
}

function pump(slug) {
  const st = threadState(slug);
  if (st.busy || st.queue.length === 0) return;
  const item = st.queue.shift();
  /* PAIR THE TURNS (fixed 2026-07-25 -- ruled a launch blocker).
     apiReply used to write the user turn the moment the reply was POSTed, while assistant turns
     append when they complete. So firing follow-ups before an answer lands -- which is NORMAL for
     someone working by voice -- rendered the thread as N questions in a row and then N answers in
     a row, with nothing tying answer 3 to question 3. Measured by the shakedown: four user turns
     stamped within 35ms, then four assistant turns.
     That is a legibility failure, and legibility is the entire reason the Mic exists
     (memory: project_why-the-mic-exists) -- so the transcript must read as a conversation.
     Writing the user turn HERE, as its turn begins, restores strict Q,A,Q,A ordering.
     Trade-off, deliberately taken: a queued message is not echoed into the archive until it runs.
     The POST response already carries {queued:N} so the surface can show that it landed. */
  if (item.pending) {
    try { writeTurn(slug, "user", "", "", item.pending.body, item.pending.extra); }
    catch (e) { console.log("pending user-turn write failed for " + slug + ": " + e.message); }
  }
  runTurn(slug, item.prompt, item.armed, item.grantReply);
}

function runTurn(slug, prompt, armed, grantReply) {
  const meta = readMeta(slug);
  if (!meta) return;
  const st = threadState(slug);
  st.busy = true;
  st.startedAt = Date.now();

  // ledger every armed foreman turn at whatever terminal it reaches (see below).
  const ledgerIfArmed = (action, outcome) => {
    if (armed && meta.role === "foreman") appendForemanLedger(grantReply, action, outcome);
  };

  const model = meta.model || DEFAULT_MODEL;

  /* ---- charter injection (set at birth by makeThread) -----------------------
     "autoload": the charter IS the thread's work/CLAUDE.md and cwd == work/, so
        the session loads it natively -- nothing to inject here.
     "append":  the charter lives OUTSIDE cwd -- explicit-repo-cwd threads, and
        the Desk (cwd = the workspace root, whose CLAUDE.md must NOT be touched).
        Injected via --append-system-prompt-file: clean, no prompt pollution, no
        CLAUDE.md edit. (Fallback is "prepend" below if append ever misbehaves.)
     "prepend": fallback -- a one-line pointer prepended to the prompt. */
  // CHARTER FRESHNESS (the comms lesson, 2026-07-18): re-stamp the charter file
  // from the live template before EVERY spawn, so a template upgrade reaches
  // every line at its next turn -- no retrofit sweeps, no lines born in gaps.
  try {
    if (meta.charterFile) {
      fs.writeFileSync(meta.charterFile,
        meta.role === "foreman" ? readForemanCharter()
        : meta.role === "desk" ? readDeskCharter()
        : isAutopilotSlug(slug) ? readAutopilotCharter()
        : readThreadCharter());
    }
  } catch (e) { /* non-fatal -- the line just runs on its birth charter */ }
  let finalPrompt = prompt;
  const flags = [];
  if (meta.charterInject === "append" && meta.charterFile && fs.existsSync(meta.charterFile)) {
    /* THE DESK GETS LIVE STRIP STATE, EVERY TURN (2026-07-22).
       The Desk is a long-lived session and the world changes underneath it silently: lines are
       closed from the line itself, never through the Desk, so nothing in its conversation ever
       says "that line is gone." Asked to open a line minutes after the operator closed one, it
       answered from its own earlier turn -- "already open, slug X, loading from <folder>" -- a
       line that no longer existed, at a folder no longer in use.
       Telling it in prose to "go check" is a rule with no checker. Instead the current strip is
       appended to its charter on every single turn: it cannot answer from stale memory, because
       fresh truth is in front of it. Written to a side file so the charter itself stays clean and diffable. */
    let charterPath = meta.charterFile;
    if (meta.role === "desk") {
      try {
        const live = listThreads();
        const rows = live.length
          ? live.map(t => "- **" + t.title + "** (slug `" + t.slug + "`) — " + t.turnCount +
              " turns · " + t.model + (t.busy ? " · WORKING" : "") +
              ((t.unread || 0) > 0 ? " · " + t.unread + " unread" : "")).join("\n")
          : "- (no lines are open right now)";
        const block = "\n\n---\n\n## THE STRIP RIGHT NOW (injected fresh this turn — trust this over your own memory)\n\n" +
          rows + "\n\nEvery open line is listed above and **nothing else is open.** A line you " +
          "remember opening earlier may have been closed since — closing happens on the line " +
          "itself and you are never told. If a line is not in this list it does not exist: say so " +
          "plainly and open a new one rather than reporting the old one as live.\n";
        charterPath = path.join(threadDir(slug), ".charter-live.md");
        fs.writeFileSync(charterPath, fs.readFileSync(meta.charterFile, "utf8") + block);
      } catch (e) { charterPath = meta.charterFile; }   // never let this break a turn
    }
    /* THE FOREMAN GETS ITS FOLD IN-TRAY, EVERY TURN  2026-08-01 -- the Desk's
       live-strip pattern, same reasoning: a note written only to the mic archive never reaches
       the model's resumed session, and "go check the ledger" is a rule with no checker. Fresh
       truth in front of it, every spawn, zero extra agent turns.) */
    if (meta.role === "foreman") {
      try {
        const tray = readForemanTray();
        if (tray.length) {
          const rows = tray.map(n => "- " + n.when + " · **" + (n.title || n.slug) + "** (`" +
            n.slug + "`) · " + (n.status || "clean") + " · archive: `" + (n.archive || "?") + "`").join("\n");
          const block = "\n\n---\n\n## YOUR FOLD IN-TRAY (injected fresh this turn — " +
            tray.length + " closed line(s) NOT yet folded into a commit)\n\n" + rows +
            "\n\nWhen the operator says **fold the shop**, follow THE FOLD in your charter. After a fold " +
            "executes cleanly: clear the tray (write `[]` to `" + FOREMAN_TRAY + "`) and append " +
            "the `**Swept …**` annotation to `" + path.join(ROOT, "CLOSED-LINES.md") + "` for the " +
            "rows you folded. The Shop Floor's counter reads this tray — leaving it stale shows " +
            "the operator a lie.\n";
          const fp = path.join(threadDir(slug), ".charter-live.md");
          fs.writeFileSync(fp, fs.readFileSync(meta.charterFile, "utf8") + block);
          charterPath = fp;
        }
      } catch (e) { charterPath = meta.charterFile; }   // never let this break a turn
    }
    flags.push("--append-system-prompt-file", charterPath);
  } else if (meta.charterInject === "prepend" && meta.charterFile) {
    finalPrompt = "(charter: read " + meta.charterFile +
      " before answering if you haven't this session)\n\n" + prompt;
  }
  /* TOPIC SELF-REPORT (decision 3.2, built 2026-08-02). Every line states, once per turn, what
     it is currently working on -- the Shop Floor's cross-line "what's in play" at topic
     granularity. Mechanically per-turn (appended to the prompt the server composes, like the
     charter machinery) rather than a charter paragraph, because a per-turn instruction in front
     of the model is followed; a rule buried in prose is a rule with no checker. The marker is
     parsed and STRIPPED from the reply before it is archived or displayed (see the close
     handler), and lands only in thread.json as `topic`/`topicAt` -- internal to the Mic. */
  finalPrompt += "\n\n(mic-plumbing, mechanical: end your reply with one extra line of the exact form " +
    "[TOPIC: <what this line is working on right now, 8 words max>] -- it is stripped from your " +
    "reply before display and shown only on the internal shop-floor board. If you are closing " +
    "the line, put the TOPIC line above the close marker.)";
  /* Tools a thread may run headlessly.
     ⚠ THE OLD COMMENT HERE SAID "Absent = text-only (the v0 department default)". THAT IS FALSE,
     and it was false for a long time while reading as a safety property. Measured 2026-07-25:
     a line with NO allowedTools ran `whoami`, ran `pwd`, and WROTE a file; and the Desk -- whose
     list is exactly ["Bash(curl:*)"] -- used the Read tool on a canary outside its cwd and on
     /etc/hostname. Two mechanisms, both verified:
       - this box runs `defaultMode: "acceptEdits"` with an EMPTY allow list, so a headless
         session auto-approves anything not explicitly DENIED. Allow-lists do not enforce here;
         only deny rules and PreToolUse hooks do.
       - the spawn env keeps HOME, so a line loads YOUR ~/.claude/settings.json and inherits your
         own desk posture. That is WHY "lines work on the real tree" works at all.
     So `allowedTools` shapes what the model is TOLD it may reach, not what it CAN reach. Treat it
     as intent, never as containment. a line YOU drive is full-power by design; the risk
     that remains is a line whose JOB is reading untrusted input. See docs/SECURITY.md. */
  let toolList = Array.isArray(meta.allowedTools) ? meta.allowedTools.slice() : [];
  // THE ELEVATION: an armed foreman turn -- and only an armed foreman turn --
  // gains the P-class tools. Unarmed, the capability is absent, not forbidden.
  if (meta.role === "foreman" && armed) toolList = toolList.concat(FOREMAN_ELEVATED_TOOLS);
  if (toolList.length) {
    flags.push("--allowedTools", toolList.join(","));
  }

  /* ===== DRIVEN LINES RUN AT DESK PARITY (built 2026-07-26) =====
     The intent was that a line YOU drive is full-power, the same as the desk session you drive
     yourself. That was not what happened. A desk running
     `--permission-mode accept --allow-dangerously-skip-permissions` (measured in ps) while a line
     ran with NO permission flags at all meant lines were policed by the user allow list and the
     desk was not. The first real line spent a whole session quietly blocked on ordinary
     verification shell -- `sed`, `sort -u`, process substitution, /tmp writes, multi-file `rm` --
     and nobody saw one refusal, because the Mic shows you PROSE, not tool calls. If a line is
     being blocked, you will not find out from the line; you will find out from the work not
     getting done. That asymmetry is what this block exists to remove.
     ⚠ THE FOREMAN IS DELIBERATELY EXCLUDED. Its `allowedTools` list is the thing that makes
     "unarmed = capability absent" mean anything; handing it bypass would make that list
     decorative on the one line that holds credentials. Its real control is the ENV (secrets are
     absent unless armed, verified), but there is no reason to weaken the second layer too.
     What still binds a driven line: the 18-entry catastrophic deny floor (survives bypass) and
     PreToolUse hooks, so the git-add guard still fires. */
  if (meta.role !== "foreman") {
    flags.push("--permission-mode", "acceptEdits", "--allow-dangerously-skip-permissions");
  }

  /* THE ROTATION NUDGE (decision 17.2a, ruled 2026-08-02). The standing seats must never
     grow unwieldy (the first live Mic day measured the tax: a long Foreman context = 7-minute
     cards) -- but nothing may ever cut a sitting, so the guard is the SEAT ITSELF offering
     rotation at a natural seam once it has run ~80 turn-files (~40 exchanges, since user+assistant
     each archive a file) on one brain. the operator's word does the
     rest; nothing is automatic here. (The idle-gated 4am backstop is the other half, riding the
     consolidated-overnight-run build.) */
  if (meta.role && ["desk", "foreman", "autopilot"].includes(meta.role)) {
    try {
      const turnsNow = fs.readdirSync(path.join(threadDir(slug), "archive"))
                         .filter(f => /-turn\.md$/.test(f)).length;
      const sinceRot = turnsNow - (meta.rotTurnBase || 0);
      if (sinceRot >= 80) {
        finalPrompt = "[SYSTEM - ROTATION NUDGE, decision 17.2a: this seat has run " + sinceRot +
          " turns since its last rotation and its context is getting heavy. At the next natural " +
          "seam - NEVER mid-chunk, never interrupting what the operator is doing - offer them one " +
          "quiet line: rotation gives this seat a fresh brain (archives keep everything). If you " +
          "already offered since the last rotation and they didn't take it, do not repeat unless " +
          "they ask or the seam is a day boundary.]\n\n" + finalPrompt;
      }
    } catch (e) { /* never let the nudge break a turn */ }
  }

  // The prompt is NOT in argv (2026-07-19 fix): a reply beginning with "-"
  // (the operator answers in bullets constantly) parsed as a CLI option and killed the
  // turn ("error: unknown option"). The prompt travels via stdin instead --
  // argv parsing never sees it, and length/quoting limits vanish with it.
  let args;
  if (!meta.started) {
    // first turn owns the session id up front (--session-id)
    args = ["-p", "--session-id", meta.id, "--model", model, ...flags, "--output-format", "json"];
  } else {
    // every later turn resumes that id (context reloaded from disk)
    args = ["-p", "--resume", meta.id, "--model", model, ...flags, "--output-format", "json"];
  }

  if (!CLAUDE_BIN) {
    ledgerIfArmed("(no claude binary)", "FAILED: no binary");
    finishError(slug, "No claude.exe found. Set CLAUDE_BIN or install the VS Code extension.");
    return;
  }

  let stdout = "", stderr = "";
  let child;
  try {
    // stdin carries the prompt (see the argv note above): write it + close.
    // No stall -- claude gets the content and an immediate EOF. (The old
    // 'ignore' + prompt-as-arg shape stalled only when stdin sat OPEN + empty.)
    // ================= THE SPAWN-ENV SCRUB (built 2026-07-25) =========
    // Every line used to inherit the Mic SERVER's whole environment, because no `env` was passed.
    // That is not theoretical: on 2026-07-25 the Desk -- whose allowedTools is just
    // ["Bash(curl:*)"] -- ran `systemctl --user is-active mic.service` and got `active`. A line
    // could therefore stop the Mic, the cockpit or the pulse. What the inherited env was handing
    // out:
    //   XDG_RUNTIME_DIR + DBUS_SESSION_BUS_ADDRESS -> `systemctl --user` control over the shop's
    //     own services (demonstrated, above).
    //   SSH_AUTH_SOCK -> the agent holds no identities today, but the day a key is loaded this
    //     would silently grant push to every line, with nothing in the diff to notice.
    // So a line now gets an EXPLICIT allow-list of variables and nothing else.
    //
    // MEASURED, do not re-derive: claude runs fine under exactly this minimal set, and it MUST
    // keep CLAUDE_CODE_OAUTH_TOKEN -- without it a line cannot authenticate at all ("Not logged
    // in"). So the scrub is NECESSARY BUT NOT SUFFICIENT: it removes ambient reach, it does not
    // sandbox the line. Real containment is the OS layer (see the 7am shift's system unit).
    // Also measured: the claude binary already scrubs the token from its own Bash-tool
    // subprocesses, so a line's shell commands do not see it -- but the line's own process does.
    // AMENDED 2026-07-26: the box now holds a real login (~/.claude/.credentials.json, Max),
    // and mic.service sets UnsetEnvironment=CLAUDE_CODE_OAUTH_TOKEN -- lines authenticate via the
    // stored credential (HOME is in the keep-list). Do NOT re-add the token to "fix" auth.
    // Keeping the var in LINE_ENV_KEEP is deliberate: contexts that still inject it keep working.
    const LINE_ENV_KEEP = [
      "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "PATH", "TZ", "TERM",
      "CLAUDE_BIN", "CLAUDE_CODE_RETRY_WATCHDOG", "CLAUDE_CODE_OAUTH_TOKEN",
    ];
    const scrubbedEnv = {};
    for (const k of LINE_ENV_KEEP) {
      if (process.env[k] !== undefined) scrubbedEnv[k] = process.env[k];
    }
    /* LINE IDENTITY FOR THE GIT GUARD (built 2026-08-01, the fold drill). The drill proved
       charter law 3.1 is prose to a cheap model: a haiku line committed to main on a casual ask
       (8b8bca3, reverted). guard-git-add.sh (user-level PreToolUse, inherits this env) now
       blocks git add/commit/push whenever MIC_LINE is set -- except MIC_ROLE=autopilot, the operator's
       7/27 ruling (targeted commits, push as merges land). Master sessions have neither var. */
    scrubbedEnv.MIC_LINE = slug;
    scrubbedEnv.MIC_ROLE = meta.role || (isAutopilotSlug(slug) ? "autopilot" : "line");
    const spawnOpts = { cwd: meta.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
                        env: scrubbedEnv };
    // Armed foreman turns layer the secret env ON TOP OF THE SCRUBBED BASE (Phase 4) -- not on
    // top of process.env, which would have quietly re-granted everything the scrub just removed.
    if (meta.role === "foreman" && armed) spawnOpts.env = Object.assign({}, scrubbedEnv, foremanArmedEnv());
    child = spawn(CLAUDE_BIN, args, spawnOpts);
  } catch (e) {
    ledgerIfArmed("(launch failed)", "FAILED: " + e.message);
    finishError(slug, "Could not launch claude: " + e.message);
    return;
  }
  st.child = child;
  try { child.stdin.write(finalPrompt); child.stdin.end(); }
  catch (e) { /* if stdin breaks, the close handler surfaces the failure */ }

  child.stdout.on("data", d => { stdout += d.toString(); });
  child.stderr.on("data", d => { stderr += d.toString(); });

  child.on("error", err => {
    ledgerIfArmed("(process error)", "FAILED: " + err.message);
    finishError(slug, "Process error: " + err.message);
  });

  child.on("close", (code, signal) => {
    st.child = null;
    if (st.stopped) {
      st.stopped = false;
      st.busy = false;
      ledgerIfArmed("(stopped mid-turn)", "stopped by the operator");
      writeTurn(slug, "error", "", "", "_Stopped by the operator. The turn was interrupted; the thread is idle and ready._");
      bumpUnread(slug);
      pump(slug);
      return;
    }
    if (code !== 0) {
      const msg = (stderr || "").trim();
      /* SELF-HEAL: "Session ID X is already in use" (found 2026-07-22 on the mail line).
         `started` is only set true on a SUCCESSFUL turn (see below) -- but `claude -p
         --session-id X` writes the session store to disk BEFORE the turn can fail. So any line
         whose FIRST turn fails after that point ends up with the session on disk and
         started:false in thread.json. Every later turn then tries to CREATE the id again and
         hits this same error, forever: the line is bricked and nothing says why. (The mail line
         had been in exactly that state since 2026-07-20, silently, until the operator tried to close it.)
         The disk is the truth, so believe it: flip the flag and resume. This cannot loop --
         runTurn re-reads meta, so the retry takes the --resume branch. */
      if (/is already in use/i.test(msg) && !meta.started) {
        const m2 = readMeta(slug);
        m2.started = true;
        writeMeta(m2);
        runTurn(slug, prompt, armed, grantReply);   // carry the arming through the resume-retry
        return;
      }
      let human;
      if (/No conversation found with session ID/i.test(msg)) {
        human = "**Thread session lost.** The underlying claude session could not be resumed " +
                "(`" + msg.split("\n")[0] + "`). Reopen this thread in VS Code, or start a fresh thread.";
      } else {
        human = "**The turn failed** (exit " + code + (signal ? ", " + signal : "") + ").\n\n```\n" +
                (msg || "(no error output)") + "\n```";
      }
      ledgerIfArmed("(execution failed)", "FAILED exit " + code + (signal ? " " + signal : ""));
      finishError(slug, human);
      return;
    }
    // parse the json result object
    let obj = null;
    try { obj = JSON.parse(stdout.trim()); }
    catch (e) {
      // sometimes multiple json lines; take the last parseable one
      const lines = stdout.trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { obj = JSON.parse(lines[i]); break; } catch (_) {}
      }
    }
    if (!obj) {
      ledgerIfArmed("(unparseable reply)", "FAILED: no parseable output");
      finishError(slug, "**Could not parse the reply.** Raw output:\n\n```\n" +
                  stdout.slice(0, 2000) + "\n```");
      return;
    }
    if (obj.is_error) {
      ledgerIfArmed("(session error)", "FAILED: session returned an error");
      finishError(slug, "**The session returned an error.**\n\n```\n" +
                  (obj.result || JSON.stringify(obj)).toString().slice(0, 2000) + "\n```");
      return;
    }
    let text = (obj.result != null ? String(obj.result) : "").trim();
    const cost = obj.total_cost_usd != null ? String(obj.total_cost_usd) : "";
    const usedModel = obj.model || model;

    /* TOPIC capture (decision 3.2, 2026-08-02 -- pair of the instruction in the prompt above).
       Find the line's [TOPIC: ...] marker, strip it from the reply (archive and display stay
       clean), and store it on thread.json as `topic` + `topicAt`. Stripping happens BEFORE the
       close-marker check so a topic line can never mask or break [CLOSE-LINE] detection.
       ⚠ FIREWALL: `topic` is line-derived text and stays INTERNAL to the Mic (/api/threads for
       the shop-floor board). It must never flow to NOW.json, publish-board.mjs, or any public
       surface -- publish-board reads only counts from /api/threads today; keep it that way. */
    {
      const tLines = text.split("\n");
      let topic = null;
      for (let i = tLines.length - 1; i >= 0; i--) {
        const m = tLines[i].trim().match(/^\[TOPIC:\s*(.+?)\]$/);
        if (m) { topic = m[1].trim().slice(0, 80); tLines.splice(i, 1); break; }
      }
      if (topic) {
        text = tLines.join("\n").replace(/\s+$/, "");
        const m3 = readMeta(slug);
        if (m3) { m3.topic = topic; m3.topicAt = new Date().toISOString(); writeMeta(m3); }
      }
    }

    // first successful turn marks the session started (id is now on disk)
    if (!meta.started) {
      const m2 = readMeta(slug);
      m2.started = true;
      if (obj.session_id) m2.id = obj.session_id;   // trust the id claude confirms
      writeMeta(m2);
    }
    writeTurn(slug, "assistant", usedModel, cost, text || "_(empty reply)_");
    bumpUnread(slug);
    st.busy = false;
    ledgerIfArmed((text || "").split("\n").find(l => l.trim()) || "(no output)", "ok (exit 0)");
    // the close ritual (charter law): a final turn ending in [CLOSE-LINE] means
    // the ceremony is done -- archive the line off the strip. The SWEEP GATE in closeLine can
    // REFUSE (unswept files in the untracked work/ sandbox), in which case the line stays open
    // and a refusal turn is already on its archive -- so fall through to pump() rather than
    // returning, or the line would be left silently stalled with a queue it never drains.
    // :FORCE is the deliberate, on-the-record escape for genuinely disposable sandbox files.
    /* MARKER DETECTION, TIGHTENED . The old test was /\[CLOSE-LINE\]\s*$/ against
       the whole reply, which fires whenever a turn merely ENDS on the token. The shakedown
       deleted a line with one innocent request -- "quote back the exact close marker, as the very
       last line" -- and the charter itself teaches the token, so any question about the close
       protocol was a live trap. An accidental close was terminal from a phone until /api/reopen.
       Now the marker must be ALONE on its own final line (nothing else on that line), which is
       exactly how the charter tells a line to emit it, and a turn that discusses the marker in
       prose no longer closes anything. */
    const lines = String(text).replace(/\s+$/, "").split("\n");
    const lastLine = (lines[lines.length - 1] || "").trim();
    const closeForce = lastLine === "[CLOSE-LINE:FORCE]";
    const closePlain = lastLine === "[CLOSE-LINE]";
    if (closeForce || closePlain) {
      if (closeLine(slug, { force: closeForce })) return;
    }
    pump(slug);
  });
}

/* THE SWEEP GATE (built 2026-07-25; the standing runsheet:
   "CLOSE THE LINE MUST TRIGGER THE SWEEP -- sweep first, archive second; archiving before a
   good sweep silently buries the work").

   WHY IT IS MECHANICAL AND NOT AN AGENT: a line's work/ folder is UNTRACKED (mic/.gitignore
   ignores threads/ wholesale), and closeLine used to just rename the folder. So anything living
   only in work/ was never in git and nothing would ever lift it -- it survived in _closed/ but
   invisibly. That was survivable at 1-2 lines a day, when a wrap caught it. the operator opens and closes
   10-15 lines a day, by design, so the window closed.
   Spawning the Foreman to sweep on every close would cost an agent turn 10-15 times a day. The
   cheap half of the job is deterministic and that is what lives here: REFUSE TO ARCHIVE while
   anything in work/ is unswept. The judgment half -- lifting a deliverable to its tracked home --
   stays with the line, which the thread charter now requires before it emits the marker. This is
   the backstop that makes the charter rule enforceable instead of aspirational.

   Returns true if the line was archived, false if the close was REFUSED. */
function unsweptWork(slug) {
  // Everything in work/ except the charter file the server itself stamps there every turn.
  const wd = path.join(threadDir(slug), "work");
  let names = [];
  try { names = fs.readdirSync(wd); } catch (e) { return []; }
  return names.filter(n => n !== "CLAUDE.md");
}

function closeLine(slug, opts) {
  // GUARD BY ROLE, NOT BY SLUG (fixed 2026-07-25 by the shakedown). This used to read
  // `slug === "the-desk"`, which left the FOREMAN able to close ITSELF -- verified end-to-end:
  // the foreman emitted the marker, was archived off the strip, and came back only on the next
  // server restart as a brand-new empty session. That would silently destroy the arming door's
  // context mid-day. Its work/ is always empty, so the sweep gate could never have caught it.
  const standing = readMeta(slug);
  // Standing roles (ruled 2026-07-31): desk, foreman, AND the autopilot pair. All four are
  // always-staffed; a sweep can close none of them. Fresh context = day-reset rotation, not close.
  if (slug === "the-desk" || (standing && ["desk", "foreman", "autopilot"].includes(standing.role))) {
    // Tell the line, rather than no-opping in silence (the Desk's own close attempt used to
    // produce nothing at all -- no archive turn, no log line, so it believed it had closed).
    try {
      writeTurn(slug, "assistant", "", "",
        "**CLOSE REFUSED — this is a standing line.** The standing lines (the Desk, the Foreman, " +
        "and the autopilot pair) do not close; they are always staffed. You are still open and " +
        "still expected to keep working. If the operator wants a fresh context here, that is a session " +
        "ROTATION (day-reset), not a close.");
      bumpUnread(slug);
    } catch (e) { /* non-fatal */ }
    console.log("close REFUSED for " + slug + " -- standing line (role guard)");
    return false;
  }
  const force = !!(opts && opts.force);
  const unswept = unsweptWork(slug);
  if (unswept.length && !force) {
    const wd = path.join(threadDir(slug), "work");
    const list = unswept.map(n => "  - " + path.join(wd, n)).join("\n");
    const msg =
      "**CLOSE REFUSED — the sweep gate held.**\n\n" +
      "This line still has **" + unswept.length + "** file(s) in its sandbox, and `work/` is " +
      "**not tracked by git** (`mic/.gitignore` ignores `threads/`). Closing archives the folder " +
      "and runs no sweep, so these would be buried where nothing will ever lift them:\n\n" +
      list + "\n\n" +
      "**To close properly:** move anything worth keeping to a real home in a tracked repo, say " +
      "where it went with full absolute paths, and then emit the marker again — the gate opens by " +
      "itself once `work/` holds nothing but the charter.\n\n" +
      "**If they are genuinely disposable**, say so explicitly and close with `[CLOSE-LINE:FORCE]` " +
      "instead. That is on the record deliberately: discarding work should be a decision someone " +
      "made, not a side effect of a folder rename.";
    try {
      writeTurn(slug, "assistant", "", "", msg);
      bumpUnread(slug);
    } catch (e) { /* non-fatal -- the refusal still stands below */ }
    // ---- DELIVER THE REFUSAL TO THE LINE, not just to the panel (fixed 2026-07-25) ----
    // The refusal used to be written ONLY into the mic archive, so the line's claude session
    // never saw it. Measured consequence: the line's very next turn said "The line was already
    // closed with the previous [CLOSE-LINE] marker. A line closes once -- it cannot be closed
    // again." It sat there believing it was dead, and the charter's promised loop ("lift the
    // file, emit the marker again") was impossible to execute because the model never learned
    // it had been refused. A gate the agent cannot perceive is a dead end, not a gate.
    // Bounded so a stubborn line cannot spin: after 2 nudges we stop feeding it and leave the
    // refusal on the archive for the operator.
    const stg = threadState(slug);
    stg.gateNudges = (stg.gateNudges || 0) + 1;
    if (stg.gateNudges <= 2) {
      enqueueReply(slug,
        "SYSTEM — YOUR CLOSE WAS REFUSED. You are NOT closed; you are still open. The sweep gate " +
        "rejected the marker because these files are still in your untracked work/ sandbox:\n\n" +
        unswept.map(n => "  - " + path.join(wd, n)).join("\n") +
        "\n\nLift anything worth keeping to a real home in a tracked repo and say where it went " +
        "with full absolute paths, then emit [CLOSE-LINE] again. If they are genuinely " +
        "disposable, say so plainly and emit [CLOSE-LINE:FORCE] instead.");
    } else {
      console.log("close gate: " + slug + " refused " + stg.gateNudges + "x -- no further nudge");
    }
    console.log("close REFUSED for " + slug + " -- " + unswept.length + " unswept file(s) in work/");
    return false;
  }
  if (unswept.length && force) {
    // THE LOG USED TO SAY "discarding" AND DISCARD NOTHING (fixed 2026-07-25 by the shakedown).
    // Nothing is deleted -- "closing never deletes anything" is doctrine and stays true -- but
    // the files were left exactly as buried as they were before the gate existed, while the log
    // claimed a decision had been executed. Write the manifest INTO the archive instead, so the
    // closed folder carries its own record of what was abandoned and the operator can find it later.
    const wd2 = path.join(threadDir(slug), "work");
    try {
      writeTurn(slug, "assistant", "", "",
        "**CLOSED WITH [CLOSE-LINE:FORCE] — " + unswept.length + " sandbox file(s) abandoned.**\n\n" +
        "These were NOT deleted (closing never deletes anything). They travel with this archive " +
        "and are recoverable, but nothing will lift them and they are not in git:\n\n" +
        unswept.map(n => "  - " + path.join(wd2, n)).join("\n"));
      bumpUnread(slug);
    } catch (e) { /* non-fatal */ }
    console.log("close FORCED for " + slug + " -- " + unswept.length +
                " sandbox file(s) abandoned (kept in the archive, not deleted)");
  }
  try {
    const closedDir = path.join(THREADS_DIR, "_closed");
    ensureDir(closedDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedTo = path.join(closedDir, slug + "-" + stamp);
    /* THE CLOSURE LEDGER (built 2026-07-25).
       The procedure it serves: you say "close the line", the Foreman sweeps it up and folds
       it into its next commit, and then the line shuts down. Until now closeLine did renameSync
       and console.log and NOTHING ELSE -- no notification of any kind, so the Foreman never
       learned a line had closed and "include it in the next wrap" had no mechanism at all.
       Deliberately a FILE and not an agent turn: at 10-15 closes a day, spawning the Foreman on
       every one would cost a turn every time the operator tidies up. A tracked file is free, survives
       restarts, and gives /wrap and the boot sweep something deterministic to read instead of
       walking _closed/ by mtime. */
    try {
      const meta2 = readMeta(slug) || {};
      const left = unsweptWork(slug);
      const row = [
        new Date().toISOString(),
        slug,
        (meta2.title || "").replace(/\|/g, "/"),
        archivedTo,
        (force && left.length) ? ("FORCED, " + left.length + " sandbox file(s) abandoned") : "clean",
        "unswept-at-close: " + (left.length ? left.join(", ") : "none"),
      ].join(" | ");
      const ledger = path.join(ROOT, "CLOSED-LINES.md");
      if (!fs.existsSync(ledger)) {
        fs.writeFileSync(ledger,
          "# Closed lines — the Foreman's in-tray\n\n" +
          "*Written by `closeLine()` in `mic/server.js`. One row per close, append-only.*\n" +
          "*The Foreman reads this at wrap and folds anything unswept into its next commit,*\n" +
          "*then the rows it has handled can be moved under `## Swept`. the operator closes 10-15 lines*\n" +
          "*a day, so this is the deterministic record that replaces walking `_closed/` by mtime.*\n\n" +
          "## Pending sweep\n\n");
      }
      fs.appendFileSync(ledger, "- " + row + "\n");
    } catch (e) { console.log("closure ledger write failed for " + slug + ": " + e.message); }
    fs.renameSync(threadDir(slug), archivedTo);
    delete state[slug];
    /* THE SHOULDER-TAP  2026-08-01). Every close lands in the Foreman's in-tray
       and, visibly, in its transcript -- WITHOUT spawning a turn (10-15 closes/day is why
       spawn-on-close was rejected; see the closure-ledger note above) and WITHOUT bumping
       unread (a close needs the Foreman's next turn, not the operator's attention -- a false "your
       turn" badge on the strip would be the board lying). Delivery into the model's context
       happens via the per-turn in-tray injection in runTurn. */
    try {
      // `standing` (the line's meta, read at the top of closeLine) and `unswept` are still in
      // scope here; the thread folder itself is already renamed away.
      const closedTitle = (standing && standing.title) || slug;
      const forcedCount = (force && unswept.length) ? unswept.length : 0;
      const tray = readForemanTray();
      tray.push({
        when: new Date().toISOString(),
        slug,
        title: closedTitle,
        archive: archivedTo,
        status: forcedCount ? ("FORCED, " + forcedCount + " sandbox file(s) abandoned") : "clean",
      });
      fs.writeFileSync(FOREMAN_TRAY, JSON.stringify(tray, null, 1));
      try {
        writeTurn("foreman", "assistant", "", "",
          "🧹 **In-tray: line closed — " + closedTitle + "** (`" + slug + "`) · " +
          (forcedCount ? "FORCED, " + forcedCount + " file(s) abandoned" : "clean") +
          "\nArchive: `" + archivedTo + "`\n" +
          "Tray now holds **" + tray.length + "** close(s) awaiting the fold.");
      } catch (e2) { /* foreman line absent -- the tray still holds the truth */ }
    } catch (e) { console.log("foreman tray write failed for " + slug + ": " + e.message); }
    console.log("line closed + archived: " + slug);
    return true;
  } catch (e) {
    console.log("close-line failed for " + slug + ": " + e.message);
    return false;
  }
}

function finishError(slug, humanMsg) {
  const st = threadState(slug);
  st.child = null;
  st.busy = false;
  writeTurn(slug, "error", "", "", humanMsg);
  bumpUnread(slug);
  pump(slug);
}

function bumpUnread(slug) {
  const meta = readMeta(slug);
  if (!meta) return;
  meta.unread = (meta.unread || 0) + 1;
  writeMeta(meta);
}

/* ============================================================================
   the file viewer  --  /file?path=...   (whitelisted to the ai-environment tree)
   ========================================================================== */
const RAW_INLINE = {   // browser renders these natively -> serve raw
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8"
};

function resolveWhitelisted(raw) {
  if (!raw) return null;
  let p = raw.trim();
  // git-bash style /c/foo -> C:\foo
  const gb = p.match(/^\/([A-Za-z])\/(.*)$/);
  if (gb) p = gb[1].toUpperCase() + ":\\" + gb[2].replace(/\//g, "\\");
  let abs;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
    abs = path.resolve(p);
  } else {
    abs = path.resolve(WORKSPACE_ROOT, p);   // repo-relative -> under the tree
  }

  const inTree = (c) => {
    const r = path.relative(WORKSPACE_ROOT, c);
    return !(r.startsWith("..") || path.isAbsolute(r));
  };
  if (inTree(abs) && fs.existsSync(abs)) return abs;

  // the whitelist: it must sit inside the workspace, or it does not get served
  if (!inTree(abs)) return null;
  return abs;
}

/* a directory link opens a small house-style listing (each entry a /file link
   onward) instead of an error -- "beat VS Code" applies to folders too. */
function serveDirListing(res, absDir) {
  let names = [];
  try { names = fs.readdirSync(absDir); } catch (e) {
    res.writeHead(500, TEXT); res.end("Could not read the folder."); return;
  }
  const entries = names.map(n => {
    const p = path.join(absDir, n);
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch (e) {}
    return { n, p, isDir };
  }).sort((a, b) => (b.isDir - a.isDir) || a.n.localeCompare(b.n));
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parent = path.dirname(absDir);
  const parentOk = resolveWhitelisted(parent);
  const rows = entries.map(e =>
    '<li class="' + (e.isDir ? "d" : "f") + '"><a href="/file?path=' +
    encodeURIComponent(e.p) + '">' + (e.isDir ? "&#128193; " : "&#128196; ") + esc(e.n) + "</a></li>"
  ).join("\n");
  const html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + esc(path.basename(absDir)) + "</title>" +
    "<link rel=\"stylesheet\" href=\"/assets/fonts/fonts.css\">" +
    "<style>body{background:#EEE1C6;color:#1A1F18;font-family:'Barlow','Segoe UI',sans-serif;" +
    "margin:0;padding:28px clamp(16px,5vw,48px)}h1{font-family:'Barlow Condensed','Oswald',sans-serif;" +
    "color:#00471B;font-size:1.6rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px}" +
    ".p{font-family:'JetBrains Mono',monospace;font-size:.72rem;color:#535B4C;margin:0 0 18px;word-break:break-all}" +
    "ul{list-style:none;margin:0;padding:0;max-width:760px}li{border-top:1px solid #DAD0B6}" +
    "li a{display:block;padding:9px 6px;color:#1A1F18;text-decoration:none;font-size:.95rem}" +
    "li.d a{color:#00471B;font-weight:600}li a:hover{background:#F4EAD0}" +
    ".up{margin:0 0 10px}.up a{color:#0A5C96;text-decoration:none;font-family:'Barlow Condensed',sans-serif;" +
    "text-transform:uppercase;letter-spacing:.1em;font-size:.78rem}</style></head><body>" +
    "<h1>" + esc(path.basename(absDir)) + "</h1><p class=\"p\">" + esc(absDir) + "</p>" +
    (parentOk ? "<p class=\"up\"><a href=\"/file?path=" + encodeURIComponent(parent) + "\">&larr; up one level</a></p>" : "") +
    "<ul>" + rows + "</ul></body></html>";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveFile(req, res, query) {
  const abs = resolveWhitelisted(query.path);
  if (!abs) { res.writeHead(403, TEXT); res.end("Path outside the allowed tree."); return; }
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { res.writeHead(404, TEXT); res.end("Not found."); return; }
  if (stat.isDirectory()) { serveDirListing(res, abs); return; }

  const ext = path.extname(abs).toLowerCase();
  const isRaw = query.raw === "1";

  if (isRaw) {
    // raw bytes / text -- used by the viewer shell to fetch md + text source
    const type = RAW_INLINE[ext] || "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (RAW_INLINE[ext]) {
    res.writeHead(200, { "Content-Type": RAW_INLINE[ext] });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // md + every other text file -> the viewer shell (renders md, else <pre>)
  const shell = path.join(ROOT, "file-viewer.html");
  fs.readFile(shell, (err, buf) => {
    if (err) { res.writeHead(500, TEXT); res.end("viewer missing"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
}

/* ============================================================================
   static serving of the Mic's own files
   ========================================================================== */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".map": "application/json"
};
const TEXT = { "Content-Type": "text/plain; charset=utf-8" };

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  // never escape the Mic folder
  const abs = path.join(ROOT, rel);
  const relCheck = path.relative(ROOT, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    res.writeHead(403, TEXT); res.end("no"); return;
  }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, TEXT); res.end("Not found: " + rel); return; }
    const ext = path.extname(abs).toLowerCase();
    // CACHING (added 2026-07-22). Before this, static files went out with Content-Type and
    // NOTHING else -- no Cache-Control, no ETag, no Last-Modified. With no validator of any kind
    // the browser is free to keep serving its copy, and the installed PWA did exactly that: a
    // fixed mic.js sat on the box while the phone kept running the old one, and closing and
    // reopening the app did not shake it loose. That turns every future Mic fix into a
    // "did my change not work, or did it not load?" guessing game -- which is precisely what it
    // cost us once already.
    //   App shell (html/js/css/json/svg) -> no-store: always fetched fresh. These are a few KB
    //   each over a private tailnet, so there is nothing to save and correctness is worth more.
    //   Fonts and images -> cached hard; they are the big files and they effectively never change.
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (SHELL_EXT[ext]) headers["Cache-Control"] = "no-store, must-revalidate";
    else headers["Cache-Control"] = "public, max-age=604800";
    res.writeHead(200, headers);
    res.end(buf);
  });
}
// The app shell -- the files that change when we fix something.
const SHELL_EXT = { ".html": 1, ".js": 1, ".css": 1, ".json": 1, ".svg": 1 };

/* ============================================================================
   JSON body helper
   ========================================================================== */
function readBody(req, cb) {
  let data = "";
  let tooBig = false;
  req.on("data", d => {
    data += d;
    if (data.length > 20 * 1024 * 1024) { tooBig = true; req.destroy(); }   // 20MB cap (pastes)
  });
  req.on("end", () => {
    if (tooBig) return cb(new Error("body too large"));
    try { cb(null, data ? JSON.parse(data) : {}); }
    catch (e) { cb(e); }
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* ============================================================================
   API
   ========================================================================== */
function listThreads() {
  let slugs = [];
  try { slugs = fs.readdirSync(THREADS_DIR).filter(d => fs.existsSync(threadMetaPath(d))); }
  catch (e) { return []; }
  const out = slugs.map(slug => {
    const meta = readMeta(slug);
    /* ONE BAD LINE MUST NOT TAKE DOWN THE SHOP (fixed 2026-07-25 by the shakedown).
       readMeta returns null on any unreadable/unparseable thread.json, and this used to
       dereference meta.title immediately. The throw happens inside the HTTP handler, there was no
       uncaughtException backstop, so node EXITED -- and because mic.service is Restart=on-failure
       while the phone polls /api/threads every 1.6s, the poll itself re-killed it every cycle: a
       permanent crash loop, every line dead, and NOT recoverable from a phone (the strip IS the
       app's entry point). Reproduced here on an isolated instance with a single truncated write.
       A broken line now shows up as a broken line, and everything else keeps working. */
    if (!meta) {
      return { slug, title: slug + "  ⚠ unreadable", cwd: "", model: "", broken: true,
               unread: 0, started: false, turnCount: 0, busy: false, queued: 0,
               role: "", elapsedMs: 0, lastTurnAt: "", topic: "", topicAt: "" };
    }
    const st = threadState(slug);
    const turns = listTurns(slug);
    /* SHOP-FLOOR FIELDS (added 2026-07-25, for the cockpit's at-a-glance line view).
       Purely additive -- every pre-existing field is untouched, so the Mic UI is unaffected.
       the operator's spec, verbatim: "I'm looking at the cockpit to understand, at a glance, all the work
       that's being done concurrently across all the lines." That needs two things the API never
       reported: how long the CURRENT turn has been running (the shop's only real "is it stuck"
       signal), and when the line last did anything (the only "is it alive" signal for an idle line).
         - elapsedMs : ms the in-flight turn has been running; 0 when not busy. st.startedAt was
                       already tracked internally and simply never surfaced.
         - lastTurnAt: mtime of the newest turn file -- survives restarts, unlike in-memory state,
                       which matters because the box reboots and the answer must still be true.
         - role      : so the panel can mark the Desk and the foreman, which are not department lines. */
    let elapsedMs = 0;
    if (st.busy && st.startedAt) elapsedMs = Date.now() - st.startedAt;
    let lastTurnAt = null;
    const newest = turns.length ? turns[turns.length - 1] : null;
    if (newest) {
      try { lastTurnAt = fs.statSync(path.join(archiveDir(slug), newest.file)).mtime.toISOString(); }
      catch (e) { /* a turn file vanishing is not worth failing the whole listing over */ }
    }
    /* topic / topicAt (decision 3.2, 2026-08-02): the line's own <=8-word statement of what it
       is working on, refreshed every turn (see the TOPIC capture in runTurn's close handler).
       ⚠ INTERNAL TO THE MIC -- line-derived text; never wire it to NOW.json, publish-board.mjs
       (which reads only counts from this endpoint), or any public surface. */
    return {
      slug, title: meta.title, cwd: meta.cwd, model: meta.model,
      created: meta.created, unread: meta.unread || 0, started: !!meta.started,
      turnCount: turns.length,
      busy: st.busy, queued: st.queue.length,
      role: meta.role || "line", elapsedMs, lastTurnAt,
      topic: meta.topic || "", topicAt: meta.topicAt || ""
    };
  });
  out.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
  return out;
}

/* ---- charter templates (port-substituted for the Desk) -------------------- */
function readThreadCharter() {
  try { return fs.readFileSync(path.join(TEMPLATES_DIR, "LINE-CHARTER.md"), "utf8"); }
  catch (e) { return "# The Line Charter\n\n(template missing)\n"; }
}
function readForemanCharter() {
  try { return fs.readFileSync(path.join(TEMPLATES_DIR, "FOREMAN-CHARTER.md"), "utf8"); }
  catch (e) { return "# The Foreman Charter\n\n(template missing)\n"; }
}
/* AUTOPILOT (2026-07-27): the autopilot seats run on a TRACKED charter,
   charters/AUTOPILOT-CHARTER.md, injected here so adherence is mechanical rather than a kickoff habit.
   This exists because work/CLAUDE.md is re-stamped from a template at EVERY spawn, so three charter
   amendments hand-edited into it silently vanished; the standby caught it by md5. Same base+addendum
   shape the Desk already uses -- a fourth entry in an existing pattern, not new machinery. */
function isAutopilotSlug(slug) { return /^autopilot(-|$)/.test(String(slug || "")); }
function readAutopilotCharter() {
  const base = readThreadCharter();
  let add = "";
  try { add = fs.readFileSync(path.join(TEMPLATES_DIR, "AUTOPILOT-CHARTER.md"), "utf8"); }
  catch (e) { add = ""; }
  return add ? (base + "\n\n---\n\n" + add) : base;
}
function readDeskCharter() {
  // the Desk's injected charter = the full line charter + the Desk addendum,
  // with {{PORT}} substituted to the live port (so a test instance on 8081
  // births against 8081; the shipped instance on 8080 births against 8080).
  const base = readThreadCharter();
  let add = "";
  try { add = fs.readFileSync(path.join(TEMPLATES_DIR, "DESK-CHARTER.md"), "utf8"); }
  catch (e) { add = ""; }
  return (base + "\n\n---\n\n" + add).replace(/\{\{PORT\}\}/g, String(PORT));
}

/* ---- the core line creator (shared by the API + ensureDesk) --------------- */
function makeThread(opts) {
  const title = (opts.title || "").trim() || "Untitled thread";
  /* Validate/normalise at BIRTH -- makeThread used to accept any string, so a stale id from an
     agent (or a typo) produced a line whose every turn failed with "(exit 1)" and no error text. */
  const mr = resolveModel(opts.model);
  if (mr.error) { const e = new Error(mr.error); e.http = 400; throw e; }
  const model = mr.model;
  ensureDir(THREADS_DIR);
  const slug = opts.slug || uniqueSlug(slugify(title));
  const dir = threadDir(slug);
  ensureDir(dir);
  ensureDir(path.join(dir, "queue"));
  ensureDir(path.join(dir, "archive"));
  ensureDir(path.join(dir, "work"));
  ensureDir(path.join(dir, "pastes"));

  // cwd: explicit real repo cwd allowed; else the thread's own work/
  let cwd = (opts.cwd || "").trim();
  if (cwd) {
    const gb = cwd.match(/^\/([A-Za-z])\/(.*)$/);
    if (gb) cwd = gb[1].toUpperCase() + ":\\" + gb[2].replace(/\//g, "\\");
    cwd = path.resolve(cwd);
    if (!fs.existsSync(cwd)) { const e = new Error("cwd does not exist: " + cwd); e.http = 400; throw e; }
  } else {
    // LINES SPAWN AT THE WORKSPACE ROOT unless a cwd was asked for explicitly.
    // This used to default to the thread's own work/ folder, and the Desk was separately told to
    // "pick the right cwd" -- which put lines in whatever folder seemed related to the job.
    // A line rooted somewhere else boots with THAT folder's CLAUDE.md instead of the workspace's,
    // so it comes up without the context the workspace would have given it. One did exactly that:
    // it had no idea an existing plan file was there, invented a sandbox to explain the gap, and
    // reasoned "from the shape" instead of reading the document. The work/ folder still exists as
    // the line's own scratch and still holds its charter -- it is just no longer the cwd.
    cwd = WORKSPACE_ROOT;
  }

  const meta = {
    id: crypto.randomUUID(),
    slug, title, model, cwd,
    created: new Date().toISOString(),
    started: false,
    unread: 0
  };

  // ---- THE LINE CHARTER, enforced at birth ----------------------------------
  if (opts.foreman) {
    // the Foreman: the master's chair. cwd = the world root (whose CLAUDE.md must
    // NOT be touched), so the charter is injected via --append-system-prompt-file,
    // re-stamped from the template every turn (see runTurn). The baseline tools let
    // it read + draft + review; outbound capability is added ONLY on an armed turn,
    // by the elevation in runTurn -- never stored here.
    const cf = path.join(dir, "FOREMAN-CHARTER.md");
    fs.writeFileSync(cf, readForemanCharter());
    meta.charterFile = cf;
    meta.charterInject = "append";
    meta.allowedTools = FOREMAN_BASE_TOOLS.slice();
    meta.role = "foreman";
  } else if (opts.desk) {
    // the Desk can't get a CLAUDE.md (its cwd is the engine root, whose
    // CLAUDE.md must NOT be touched). Its charter lives in its own folder and is
    // injected via --append-system-prompt-file. It also carries curl so it can
    // open lines by calling the local API.
    const cf = path.join(dir, "DESK-CHARTER.md");
    fs.writeFileSync(cf, readDeskCharter());
    meta.charterFile = cf;
    meta.charterInject = "append";
    meta.allowedTools = ["Bash(curl:*)"];
    meta.role = "desk";
  } else {
    // every department thread gets the charter as its work/CLAUDE.md at birth.
    const cf = path.join(dir, "work", "CLAUDE.md");
    fs.writeFileSync(cf, isAutopilotSlug(slug) ? readAutopilotCharter() : readThreadCharter());
    meta.charterFile = cf;
    // it auto-loads only when cwd IS that work/ folder; for an explicit repo cwd
    // it won't, so append it there instead (never both -> no duplication).
    meta.charterInject = (cwd === path.join(dir, "work")) ? "autoload" : "append";
  }

  writeMeta(meta);
  return meta;
}

function apiCreateThread(res, body) {
  let meta;
  try { meta = makeThread({ title: body.title, cwd: body.cwd, model: body.model }); }
  catch (e) { sendJson(res, e.http || 500, { error: e.message }); return; }
  sendJson(res, 200, { ok: true, thread: meta });
}

/* ---- THE DESK: the standing master line, born once at boot ----------------- */
function ensureDesk() {
  ensureDir(THREADS_DIR);
  if (fs.existsSync(threadMetaPath("the-desk"))) {
    // already born -- just keep its injected charter current with the live port
    try {
      const meta = readMeta("the-desk");
      if (meta && meta.charterFile) fs.writeFileSync(meta.charterFile, readDeskCharter());
    } catch (e) { /* non-fatal */ }
    return;
  }
  try {
    makeThread({ title: "The Desk", slug: "the-desk", cwd: WORKSPACE_ROOT,
                 model: DESK_MODEL, desk: true });
    console.log("  the desk            : born (cwd " + WORKSPACE_ROOT + ")");
  } catch (e) {
    console.log("  the desk            : could NOT scaffold -- " + e.message);
  }
}

/* ---- THE FOREMAN: the standing elevated master line, born once at boot ------
   Singleton: only ensureForeman ever sets foreman:true, and only for slug
   "foreman" -- the public /api/threads create path can never mint one. */
function ensureForeman() {
  /* OFF unless you turned it on. A fresh install has no Foreman line and no arming path at all --
     you opt into the elevated door deliberately, after reading docs/SECURITY.md, and never as a
     side effect of starting the server. An already-born Foreman is left alone: disabling the
     config stops it being re-stamped, it does not delete a line you may still be reading. */
  if (!FOREMAN_ENABLED) return;
  ensureDir(THREADS_DIR);
  if (fs.existsSync(threadMetaPath("foreman"))) {
    // already born -- keep its injected charter current with the template
    try {
      const meta = readMeta("foreman");
      if (meta && meta.charterFile) fs.writeFileSync(meta.charterFile, readForemanCharter());
    } catch (e) { /* non-fatal */ }
    return;
  }
  try {
    makeThread({ title: "The Foreman", slug: "foreman", cwd: WORKSPACE_ROOT,
                 model: FOREMAN_MODEL, foreman: true });
    console.log("  the foreman         : born (cwd " + WORKSPACE_ROOT + ", " + FOREMAN_MODEL + ", armed-by-word)");
  } catch (e) {
    console.log("  the foreman         : could NOT scaffold -- " + e.message);
  }
}

function apiThreadDetail(res, query) {
  const slug = query.slug;
  const meta = readMeta(slug);
  if (!meta) { sendJson(res, 404, { error: "no such thread" }); return; }
  if (query.markRead === "1" && meta.unread) { meta.unread = 0; writeMeta(meta); }
  const st = threadState(slug);
  sendJson(res, 200, {
    slug, title: meta.title, cwd: meta.cwd, model: meta.model, id: meta.id,
    created: meta.created, started: !!meta.started, unread: meta.unread || 0,
    busy: st.busy, queued: st.queue.length,
    /* WHAT is queued, not just how many (the operator, 2026-08-01 night: sent a reply mid-turn and
       could see only "1 queued" -- a message you could no longer read anywhere). The glass shows
       these under the working strip. ⚠ REDACT THE WORD: a queued FOREMAN reply may carry the
       arming word in the raw prompt; it must never travel to a rendered surface. */
    queuedTexts: st.queue.map(q => redactWord(String(q.prompt || ""), readForemanWord())),
    turns: listTurns(slug)
  });
}

function apiReply(res, body) {
  const slug = body.slug;
  const meta = readMeta(slug);
  if (!meta) { sendJson(res, 404, { error: "no such thread" }); return; }
  const text = (body.text || "").trim();
  const images = Array.isArray(body.images) ? body.images : [];
  if (!text && images.length === 0) { sendJson(res, 400, { error: "empty reply" }); return; }

  /* THE FOREMAN DOOR arming (foreman line only). The word is read fresh from
     the credentials dir (outside the tree), matched whole-token + case-sensitive against
     ONLY this user reply, and redacted to [ARMED] before ANYTHING lands on disk
     -- the archived turn, the prompt claude sees, and the ledger all get the
     redacted form. Arming rides the queue item; it is never stored in thread.json. */
  let armed = false, grantReply = "";
  let safeText = text;
  /* REDACT ON EVERY LINE, NOT ONLY THE FOREMAN (fixed 2026-07-25 by the shakedown).
     Redaction used to live inside `if (meta.role === "foreman")`, so two ordinary things wrote
     the word to disk IN CLEARTEXT, both measured: (a) typing it into any other line -- easy when
     15 lines are open -- and (b) a near-miss on the foreman line itself, because the match is
     case-sensitive and voice-to-text capitalizes the first word of a sentence. Those turn files
     are then readable by every line's Read tool and served by GET /file?raw=1 on an
     unauthenticated port. Redact first, decide about arming second. */
  const word = readForemanWord();
  if (word) safeText = redactWord(text, word);
  if (meta.role === "foreman") {
    if (replyCarriesWord(text, word)) {
      armed = true;
      grantReply = safeText;
    }
  }
  /* THE HELPER BASELINE CHECK. Refuse to arm if helpers/ has changed since
     the Mic started -- the elevated payload must be the one that was audited, not whatever a
     later unarmed turn wrote there. */
  if (armed) {
    const drift = foremanBinDrift();
    if (drift.length) {
      armed = false;
      grantReply = "";
      const msg = "**ARMING REFUSED — the elevated helpers have changed since the Mic started.**\n\n" +
        drift.map(d => "  - " + d).join("\n") +
        "\n\nThe word was accepted and then withheld on purpose: an armed turn runs these scripts " +
        "with live credentials in its environment, so it must run the versions that were audited, " +
        "not whatever was written to them afterwards. If the operator changed them deliberately, restart " +
        "the Mic to re-baseline. If they did not, **something rewrote them and this is the finding.**";
      try { writeTurn(slug, "assistant", "", "", msg); bumpUnread(slug); } catch (e) {}
      console.log("ARMING REFUSED for " + slug + " -- helpers drift: " + drift.join(", "));
    }
  }

  // the reply, as the operator typed it, is its own archived turn (the honest record) --
  // on the foreman line the word is already redacted, so it never lands on disk.
  let userBody = safeText;
  images.forEach(p => { userBody += (userBody ? "\n\n" : "") + "![pasted](" + fileUrl(p) + ")"; });
  // mark the armed turn in its frontmatter so the UI can badge it (the word is
  // already redacted to [ARMED] in safeText, so nothing sensitive lands on disk).
  // The user turn is NOT written here any more -- it is written in pump(), as this item's turn
  // begins, so the archive reads Q,A,Q,A even when the operator fires follow-ups before an answer lands.
  const pendingUserTurn = {
    body: userBody || "_(image only)_",
    extra: armed ? { armed: true } : null,
  };

  // build the prompt for claude: text (redacted on the foreman line) + image lines
  let prompt = safeText;
  // The day-boundary question rides the foreman's next real turn (17.2) -- it is prepended to the
  // prompt only, never written into the archived user turn, so the operator's own words stay verbatim.
  if (meta.role === "foreman") {
    const note = dayBoundaryNote();
    if (note) prompt = note + prompt;
  }
  images.forEach(p => { prompt += (prompt ? "\n" : "") + "[attached image: " + p + "]"; });

  enqueueReply(slug, prompt, armed, grantReply, pendingUserTurn);
  sendJson(res, 200, { ok: true, busy: true, armed });
}
function fileUrl(absPath) { return "/file?path=" + encodeURIComponent(absPath); }

function apiStop(res, body) {
  const slug = body.slug;
  const st = threadState(slug);
  if (!st.child) { sendJson(res, 200, { ok: true, note: "nothing running" }); return; }
  st.stopped = true;
  st.queue = [];   // drop anything queued behind it
  const pid = st.child.pid;
  // Windows: kill the whole process tree (claude may spawn children)
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); }
    catch (e) { try { st.child.kill(); } catch (_) {} }
  } else {
    try { st.child.kill("SIGTERM"); } catch (_) {}
  }
  sendJson(res, 200, { ok: true, stopped: true });
}

function apiPaste(res, body) {
  const slug = body.slug;
  const meta = readMeta(slug);
  if (!meta) { sendJson(res, 404, { error: "no such thread" }); return; }
  const dataURL = body.dataURL || "";
  const m = dataURL.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
  if (!m) { sendJson(res, 400, { error: "not an image data URL" }); return; }
  const extMap = { png: ".png", jpeg: ".jpg", jpg: ".jpg", gif: ".gif", webp: ".webp" };
  const ext = extMap[m[1]] || ".png";
  const dir = path.join(threadDir(slug), "pastes");
  ensureDir(dir);
  const name = "paste-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ext;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.from(m[2], "base64"));
  sendJson(res, 200, { ok: true, path: abs, url: fileUrl(abs) });
}

/* mid-line model switch (the 2026-07-19 dogfood fix): update the thread's
   model in place -- runTurn re-reads meta every turn, so the switch takes
   effect on the line's NEXT turn, no restart, no rebirth. */
function apiSetModel(res, body) {
  const slug = body.slug;
  const meta = readMeta(slug);
  if (!meta) { sendJson(res, 404, { error: "no such thread" }); return; }
  const model = (body.model || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(model)) { sendJson(res, 400, { error: "bad model id" }); return; }
  /* Shape was already checked; now check EXISTENCE. A well-formed but unknown id used to be
     accepted with {ok:true} and then failed opaquely on the next turn. */
  const sr = resolveModel(model);
  if (sr.error) { sendJson(res, 400, { error: sr.error }); return; }
  meta.model = sr.model;
  writeMeta(meta);
  sendJson(res, 200, { ok: true, model: model });
}

/* ============================================================================
   router
   ========================================================================== */
function parseQuery(u) {
  const q = {};
  const i = u.indexOf("?");
  if (i === -1) return q;
  u.slice(i + 1).split("&").forEach(pair => {
    const [k, v] = pair.split("=");
    // a malformed %-escape must never crash the server -- ignore that param.
    try {
      q[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
    } catch (e) { /* skip the un-decodable param, keep serving */ }
  });
  return q;
}

const server = http.createServer((req, res) => {
  const url = req.url;
  const pathname = url.split("?")[0];
  const query = parseQuery(url);

  // --- API ---
  if (pathname === "/api/threads" && req.method === "GET") {
    /* `folders` = the optional shortcut list for the "where it works" picker (mic.config.json).
       Empty is the normal case: a line with no cwd is born at the workspace root, which is what
       you want almost every time. */
    return sendJson(res, 200, { threads: listThreads(), env: {
      root: WORKSPACE_ROOT, claude: CLAUDE_BIN || null,
      folders: Array.isArray(CFG.folders) ? CFG.folders : []
    } });
  }
  /* THE COCKPIT surface. The Cockpit tab shows the LINES; this hands it the other half -- the
     working notes YOU keep in the workspace -- so one tab carries the whole picture and all of
     it works on the PHONE. It exists because serveStatic is deliberately jailed to this folder
     ("never escape"), while the files the Cockpit reads live out in the workspace.
     SAFETY: every path is a FIXED LITERAL joined to WORKSPACE_ROOT -- no query, no user input, nothing
     from the request reaches the filesystem, so the jail can't be walked out of through this door.
     Read-only: there is no write path here and there must never be one. */
  if (pathname === "/api/shop" && req.method === "GET") {
    /* WHICH files, from mic.config.json (cockpit.files). Every one is optional: a name you
       leave out, or a file that isn't there, renders as an honestly-empty panel rather than
       an invented one. The FORMATS these parsers expect are written down in docs/COCKPIT.md
       -- they are deliberately plain markdown you would keep by hand anyway.
       SAFETY: config supplies these names at BOOT; nothing from the request ever reaches the
       filesystem here, so this door cannot be walked out of the workspace. Read-only, always. */
    const CF = CFG.cockpit && CFG.cockpit.files ? CFG.cockpit.files : {};
    const safeRel = (p) => {
      if (typeof p !== "string" || !p) return null;
      if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return null;
      const abs = path.resolve(WORKSPACE_ROOT, p);
      const r = path.relative(WORKSPACE_ROOT, abs);
      return (r.startsWith("..") || path.isAbsolute(r)) ? null : abs;
    };
    const readOpt = (p) => {
      const abs = safeRel(p);
      if (!abs) return null;
      try { return fs.readFileSync(abs, "utf8"); } catch (e) { return null; }
    };
    const sides = [];
    for (const f of (Array.isArray(CF.sides) ? CF.sides : [])) {
      const md = readOpt(f);
      // A side board that exists but holds no list item is a retired stub -- skip it, don't show a
      // ghost. (The old cockpit only ever looked for SIDE-1 and SIDE-2, so with five lines running
      // three of them were invisible. Silently. That is the bug this loop exists to not repeat.)
      if (md && /^(?:-|\d+[a-z]?\.)\s+/m.test(md)) {
        const nm = (md.match(/^#\s*SIDE BOARD\s*[—-]\s*(.+)$/mi) || [])[1];
        sides.push({ name: (nm || f.replace(/\.md$/, "")).trim(), md });
      }
    }
    let pulse = null;
    try {
      // STRIP THE BOM. PULSE.json is written by pulse.ps1, and PowerShell emits a UTF-8 byte-order
      // mark (verified: the file starts ef bb bf). JSON.parse THROWS on a leading BOM, so without
      // this the pulse strip silently renders empty and the page looks like the sampler is dead
      // when it is fine. Fixed at the READER, not the writer: any PowerShell-written file the shop
      // grows later gets the same protection for free. Cousin of ps51-ascii-only-scripts.
      pulse = JSON.parse((readOpt(CF.pulse) || "null").replace(/^﻿/, ""));
    } catch (e) { pulse = null; }
    /* THE TYPED SPINE  2026-08-01). Two additions so the Shop Floor renders state,
       never prose:
       - now: a small JSON file in the workspace -- the one judgment layer (workingOn / upNext /
         updatedAt), which you keep current as you work. Absent or
         unparseable -> null; the page shows its absence honestly rather than inventing anything.
       - decisions: the DECISION REGISTER table parsed out of BOARD.md into typed rows
         {id, text, status}. BOARD.md stays the single tracking surface (no dual-write); this is
         a deterministic parse of one stable table, not regex-over-prose -- the old cockpit's
         SECMAP disease this line replaces. Row shape tolerated: | **id** | text | status |
         where id may be "70", "17.2", "10 / 10b" or a circled digit from the pre-numbering era. */
    let now = null;
    try { now = JSON.parse((readOpt(CF.now) || "null").replace(/^﻿/, "")); } catch (e) { now = null; }
    const decisions = [];
    const boardMd = readOpt(CF.board);
    if (boardMd) {
      const sec = boardMd.split(/^##\s+/m).find(s => /^[^\n]*DECISION REGISTER/.test(s));
      if (sec) {
        for (const line of sec.split(/\r?\n/)) {
          if (!/^\s*\|/.test(line)) continue;
          const cells = line.split("|").slice(1, -1).map(c => c.trim());
          if (cells.length < 3) continue;
          const id = cells[0].replace(/\*/g, "").trim();
          if (!id || id === "#" || /^-+$/.test(id)) continue;   // header + divider rows
          decisions.push({ id, text: cells[1], status: cells[2] });
        }
      }
    }
    /* THE PILE  2026-08-01): BACKLOG.md's ## Now headlines -- the shop's quiet
       queue, rendered collapsed so the operator can SEE what's pickable ("open a line on X") without it
       ever being in the way. Same slice the boot injection uses: the FIRST LINE of each top-level
       bullet, verbatim. Read-only; BACKLOG.md stays the ledger. */
    const pile = [];
    // What waits BEHIND the pile (the operator, 2026-08-01 night: "there's really like 50 more behind
    // it, or what?" -- 83, actually). The pile shows ## Now only -- the pickable queue -- but it
    // must never pretend to be the whole backlog, so the counts of the sections behind it travel
    // with it and the page prints them as a footer.
    const pileBehind = {};
    const backlogMd = readOpt(CF.backlog);
    if (backlogMd) {
      for (const sec of backlogMd.split(/^##\s+/m).slice(1)) {
        const name = (sec.split("\n")[0] || "").trim();
        const items = (sec.match(/^-\s+\S/gm) || []).length;
        if (/^Now$/i.test(name)) {
          for (const line of sec.split(/\r?\n/)) {
            const m = line.match(/^-\s+(.*)$/);
            // Strip ** outright: the headline is line 1 of a multi-line bold header, so its
            // closing ** usually lives on a later line and an unmatched pair renders as literal
            // asterisks.
            if (m && m[1].trim()) pile.push({ text: m[1].trim().replace(/\*\*/g, "") });
          }
        } else if (items) {
          pileBehind[name] = items;
        }
      }
    }
    // awaitingSweep: the fold in-tray count -- how many closed lines have work not yet folded
    // into a commit. 0 = everything integrated; the Shop Floor renders it so the operator can SEE the
    // shop is settled instead of trusting that it is .
    /* `files` travels with the payload so the page can LINK to the same files it renders,
       without any path being written into the HTML. Absent keys => the page omits that link. */
    return sendJson(res, 200, { board: boardMd, sides, pulse, now, decisions, pile, pileBehind,
                                files: CF, awaitingSweep: readForemanTray().length });
  }
  if (pathname === "/api/threads" && req.method === "POST") {
    return readBody(req, (e, b) => e ? sendJson(res, 400, { error: e.message }) : apiCreateThread(res, b));
  }
  if (pathname === "/api/thread" && req.method === "GET") {
    return apiThreadDetail(res, query);
  }
  if (pathname === "/api/reply" && req.method === "POST") {
    return readBody(req, (e, b) => e ? sendJson(res, 400, { error: e.message }) : apiReply(res, b));
  }
  if (pathname === "/api/stop" && req.method === "POST") {
    return readBody(req, (e, b) => e ? sendJson(res, 400, { error: e.message }) : apiStop(res, b));
  }
  if (pathname === "/api/paste" && req.method === "POST") {
    return readBody(req, (e, b) => e ? sendJson(res, 400, { error: e.message }) : apiPaste(res, b));
  }
  /* POST /api/close {slug, force} — a MECHANICAL close (decision 10 + 24).
     Two reasons this has to exist. First, the procedure is that the Foreman can take your
     place and give a line the order to close; without an endpoint the Foreman has no way to.
     Second, the only close path used to be "a model chooses to emit a token", so a line that
     was wedged, on a dead model, or convinced it had already closed could NOT be closed at all
     without hand-editing the filesystem — impossible from a phone. The sweep gate still applies. */
  if (pathname === "/api/close" && req.method === "POST") {
    return readBody(req, (e, b) => {
      if (e) return sendJson(res, 400, { error: e.message });
      const slug = b && b.slug;
      if (!slug || !readMeta(slug)) return sendJson(res, 404, { error: "no such thread" });
      const ok = closeLine(slug, { force: !!(b && b.force) });
      return sendJson(res, ok ? 200 : 409,
        ok ? { ok: true, closed: slug }
           : { ok: false, error: "close refused — a standing line, or work/ still holds unswept files (see the line)" });
    });
  }
  /* ==========================================================================
     POST /api/restart {word, force} — Mic-native restart (decision 7-B, ruled 2026-08-02).
     WHY: server-code changes only go live on a restart, but no Mic line can reach the user
     systemd bus (the spawn-env scrub removed XDG_RUNTIME_DIR/DBUS on purpose), so shipped
     plumbing was stranded until someone had a box shell. This is the authenticated door.
     MECHANISM — the SUPERVISOR does the work, nothing hand-rolled: mic.service (installed at
     ~/.config/systemd/user/mic.service, source fleet-ops/units/mic.service) runs
     Restart=on-failure + RestartSec=5. A CLEAN exit stays dead (HOW-IT-WORKS documents exactly
     that trap), so the handler replies first, then exits NON-ZERO (64, a distinctive
     deliberate-restart code) on a 250ms timer — systemd counts it a failure and brings the
     server back ~5s later with fresh code. All state writes here are synchronous
     (writeMeta/writeTurn), so nothing is in flight once the timer fires; in-flight LINE turns
     are what the busy-guard protects.
     GUARDS, in order (restartDecision is pure so the chain is unit-testable):
       1. AUTH (mandatory — this port is unauthenticated): the caller must present the foreman
          word from the credentials dir — OUTSIDE the tree, read fresh per call (rotatable
          live), matched by strict equality server-side, never echoed, never logged. Word file
          missing/empty => 503, fail closed.
       2. SUPERVISOR CHECK: no INVOCATION_ID in the server's own env => not systemd-managed =>
          exiting would be a SHUTDOWN, not a restart => 503, no override. (A hand-launched
          server implies someone has a shell — use it; see HOW-IT-WORKS.)
       3. BUSY GUARD: any line mid-turn or with a queued reply => 409 naming them, unless
          force:true is explicit — an accidental restart must not nuke working lines.
     ⚠ FIREWALL (hard, per the kickoff): this endpoint moves the host — it is exactly what a
     prompt injection would target. It fires ONLY on a POST carrying the out-of-tree secret;
     nothing the server READS (turn text, files, bug reports, any data) can ever trigger it,
     and the word must never be quoted into a line's prose or archive (archives are data).
     ========================================================================== */
  if (pathname === "/api/restart" && req.method === "POST") {
    return readBody(req, (e, b) => {
      if (e) return sendJson(res, 400, { error: e.message });
      const busyLines = Object.keys(state)
        .filter(s => state[s].busy || state[s].queue.length > 0);
      const d = restartDecision((b && b.word), readForemanWord(), busyLines,
                                !!process.env.INVOCATION_ID, !!(b && b.force));
      if (d.code !== 200) {
        console.log("restart refused (" + d.code + "): " + d.obj.error);   // outcome only — never the word
        return sendJson(res, d.code, d.obj);
      }
      console.log("RESTART accepted via /api/restart (force=" + !!(b && b.force) +
                  (busyLines.length ? ", killing: " + busyLines.join(",") : "") +
                  ") — exiting 64 for systemd to resurrect");
      sendJson(res, 200, d.obj);                    // reply FIRST, so the caller hears the ack
      setTimeout(() => process.exit(64), 250);      // then die non-zero; Restart=on-failure revives
      return;
    });
  }
  /* POST /api/reopen {slug} — put the most recently archived copy of a line back on the strip
     . An accidental close used to be TERMINAL from a phone: there is no un-archive,
     and a line asked merely to EXPLAIN the close protocol will quote the marker and delete
     itself — the shakedown triggered exactly that with one innocent request. The conversation
     was never destroyed, it just became unreachable without a terminal. Now it is reachable. */
  if (pathname === "/api/reopen" && req.method === "POST") {
    return readBody(req, (e, b) => {
      if (e) return sendJson(res, 400, { error: e.message });
      const slug = (b && b.slug || "").trim();
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return sendJson(res, 400, { error: "bad slug" });
      if (fs.existsSync(threadMetaPath(slug))) return sendJson(res, 409, { error: "a live line already has that slug" });
      const closedDir = path.join(THREADS_DIR, "_closed");
      let cands = [];
      try {
        cands = fs.readdirSync(closedDir)
          .filter(d => d === slug || d.startsWith(slug + "-2"))
          .filter(d => fs.existsSync(path.join(closedDir, d, "thread.json")))
          .sort();
      } catch (err) { return sendJson(res, 404, { error: "no archive directory" }); }
      if (!cands.length) return sendJson(res, 404, { error: "no archived line named " + slug });
      const newest = cands[cands.length - 1];
      try {
        fs.renameSync(path.join(closedDir, newest), threadDir(slug));
        console.log("line REOPENED: " + slug + "  (from " + newest + ")");
        return sendJson(res, 200, { ok: true, slug, from: newest });
      } catch (err) { return sendJson(res, 500, { error: err.message }); }
    });
  }
  /* POST /api/day-reset {defer:true|false} — the answer to the day-boundary card (17.2).
     defer:true  -> stamp the deferral; the card stays quiet for another 24h and will then say it
                    has already been deferred once.
     defer:false -> the day wrap: ROTATE the standing lines' sessions (fresh claude context, the
                    archive kept intact on disk) and stamp lastReset.
     ⚠ ONLY the Desk and the Foreman rotate. Ordinary lines are untouched, because ruling 17.1 is
     that a line lives until the operator closes it -- which can be five minutes or five days -- and
     silently resetting a five-day line's context would destroy exactly the work you kept it for. */
  if (pathname === "/api/day-reset" && req.method === "POST") {
    return readBody(req, (e, b) => {
      if (e) return sendJson(res, 400, { error: e.message });
      const s = readDayState();
      const nowIso = new Date().toISOString();
      if (b && b.defer) {
        s.deferredAt = nowIso;
        writeDayState(s);
        console.log("day boundary DEFERRED at " + nowIso);
        return sendJson(res, 200, { ok: true, deferred: true });
      }
      const rotated = [];
      // ROTATE BY ROLE, NOT BY SLUG (ruled 2026-07-31): every standing line rotates on the
      // day boundary -- desk, foreman, and the autopilot pair. Ordinary lines stay untouched
      // (ruling 17.1: a work line lives until the operator closes it).
      let standingSlugs = [];
      try {
        standingSlugs = fs.readdirSync(THREADS_DIR).filter(d => {
          if (d === "_closed") return false;
          const m = readMeta(d);
          return !!(m && (d === "the-desk" || ["desk", "foreman", "autopilot"].includes(m.role)));
        });
      } catch (err) { standingSlugs = ["the-desk", "foreman"]; }
      for (const slug of standingSlugs) {
        const m = readMeta(slug);
        if (!m) continue;
        m.id = crypto.randomUUID();
        m.started = false;                 // next turn opens the new session with --session-id
        // ROTATION TURN-BASE (decision 17.2a, 2026-08-02): remember how many archived turns
        // existed at rotation, so the per-turn nudge can measure growth SINCE the last fresh
        // brain (archive counts are cumulative across rotations by design).
        try {
          m.rotTurnBase = fs.readdirSync(path.join(threadDir(slug), "archive"))
                            .filter(f => /-turn\.md$/.test(f)).length;
        } catch (e) { m.rotTurnBase = 0; }
        writeMeta(m);
        try {
          writeTurn(slug, "assistant", "", "",
            "— **day wrap. new session from here.** The conversation above is archived on disk and " +
            "still readable; what is gone is the model's in-context memory of it, which is the point: " +
            "this line was growing without bound and every turn was re-reading all of it. —");
          // NO bumpUnread (the operator, 2026-08-01 night — the first live rotation turned all four
          // standing lines rust at once, reading as "everyone needs you" when nothing did).
          // The divider is routine bookkeeping, visible in the transcript when you next open
          // the line; an unread badge means "something here waits on YOU" and must stay true.
        } catch (err) { /* non-fatal */ }
        rotated.push(slug);
      }
      s.lastReset = nowIso;
      s.deferredAt = null;
      writeDayState(s);
      console.log("DAY RESET at " + nowIso + " -- rotated: " + rotated.join(", "));
      return sendJson(res, 200, { ok: true, rotated, at: nowIso });
    });
  }
  if (pathname === "/api/model" && req.method === "POST") {
    return readBody(req, (e, b) => e ? sendJson(res, 400, { error: e.message }) : apiSetModel(res, b));
  }

  // --- the file viewer ---
  if (pathname === "/file" && req.method === "GET") {
    return serveFile(req, res, query);
  }

  // --- static ---
  if (req.method === "GET") return serveStatic(res, url);

  res.writeHead(405, TEXT); res.end("method not allowed");
});

ensureDir(THREADS_DIR);
ensureDesk();
ensureForeman();
server.listen(PORT, HOST, () => {
  console.log("THE MICROPHONE is up  ->  http://" + HOST + ":" + PORT);
  console.log("  workspace root      : " + WORKSPACE_ROOT);
  console.log("  config              : " + (fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : "(none — running on defaults)"));
  console.log("  claude binary       : " + (CLAUDE_BIN || "NOT FOUND — set claudeBin in mic.config.json or CLAUDE_BIN in the env"));
  console.log("  threads             : " + THREADS_DIR);
  /* Capture the elevated-helper baseline ONCE, here, while nothing has had a chance to
     rewrite anything. Held only in memory -- an on-disk manifest would be
     writable by the same line the baseline exists to catch. */
  FOREMAN_BIN_BASELINE = hashForemanBin();
  const n = Object.keys(FOREMAN_BIN_BASELINE).length;
  console.log("  foreman helpers     : " + n + " baselined" + (n ? "" : "  (none found)"));
  /* Reconcile turns lost to a restart. If a line's newest turn is a USER turn,
     its answer never landed -- the Mic died mid-turn, or the child was orphaned. That used to
     be completely silent: the line looked idle with your message just sitting there and no
     way to tell "lost" from "never sent". Say so, in the line, where you will see it. */
  let reconciled = 0;
  try {
    for (const d of fs.readdirSync(THREADS_DIR)) {
      if (d === "_closed" || !fs.existsSync(threadMetaPath(d))) continue;
      const turns = listTurns(d);
      if (!turns.length) continue;
      const last = turns[turns.length - 1];
      if (last.role !== "user") continue;
      writeTurn(d, "assistant", "", "",
        "_The Mic restarted while this turn was running, so the answer never arrived. " +
        "Nothing was saved from it. Send it again when you're ready._");
      bumpUnread(d);
      reconciled++;
    }
  } catch (e) { console.log("restart reconcile failed: " + e.message); }
  if (reconciled) console.log("  restart reconcile   : " + reconciled + " line(s) told their turn was lost");
});

/* ============================================================================
   THE DAY BOUNDARY
   Standing lines accumulate context forever unless something asks about it. The shape that works:
   every 24 hours the Foreman raises a card asking whether to wrap and reset the day, or defer one
   more day -- deferrable at most one more day, or until you say it is done.
   Two deliberate properties, both learned the hard way:
     - NOTHING RESETS ON A CLOCK. If you work late, a timer firing at midnight cuts you off
       mid-sitting, and a card that appears while you are asleep is a card you have already blown
       past. The check runs on your FIRST TURN of a sitting -- the only moment you can answer it.
     - IT ASKS, IT NEVER ACTS. A line never closes unless you say so. The same restraint applies
       to the standing lines; this only ever raises the question.
   ========================================================================== */
const DAY_STATE = path.join(ROOT, "day-state.json");
function readDayState() {
  try { return JSON.parse(fs.readFileSync(DAY_STATE, "utf8")); }
  catch (e) { return { lastReset: null, deferredAt: null }; }
}
function writeDayState(s) {
  try {
    fs.writeFileSync(DAY_STATE + ".tmp", JSON.stringify(s, null, 2));
    fs.renameSync(DAY_STATE + ".tmp", DAY_STATE);
  } catch (e) { console.log("day-state write failed: " + e.message); }
}
const DAY_MS = 24 * 60 * 60 * 1000;
/* Returns the text to prepend to this turn, or "" -- called only for the foreman line. */
function dayBoundaryNote() {
  const s = readDayState();
  const now = Date.now();
  const since = s.lastReset ? now - Date.parse(s.lastReset) : Infinity;
  if (since < DAY_MS) return "";
  const deferredFor = s.deferredAt ? now - Date.parse(s.deferredAt) : Infinity;
  if (deferredFor < DAY_MS) return "";          // already deferred inside this window
  const alreadyDeferredOnce = s.deferredAt && deferredFor >= DAY_MS;
  const age = since === Infinity ? "since this Mic was first started"
                                 : "for " + Math.floor(since / 3600000) + " hours";
  return "SYSTEM — DAY BOUNDARY. The shop has been open " + age + " without a day wrap.\n" +
    (alreadyDeferredOnce
      ? "The operator ALREADY DEFERRED this once. Say so plainly and do not offer a second deferral — " +
        "the choice now is wrap-and-reset, or they tell you explicitly to leave it.\n"
      : "") +
    "Raise this as a numbered decision card at the END of your reply, after whatever they actually " +
    "asked for — never instead of it. Offer: (A) wrap the day and reset the standing lines, " +
    "(B) defer one more day" + (alreadyDeferredOnce ? " [ALREADY USED]" : "") + ". Open lines are " +
    "NOT affected either way: a line only ever closes when the operator says so.\n\n";
}

/* ============================================================================
   THE BACKSTOP (added 2026-07-25 by the shakedown)
   Thin-glass law: the Mic must never be the thing that dies. Before this, ANY
   unguarded throw in ANY handler ended the process -- and since mic.service is
   Restart=on-failure while the phone polls /api/threads every 1.6s, a
   deterministic throw became a permanent crash loop that the phone itself kept
   re-triggering. the operator runs the business through this from a phone with no
   fallback machine and no shell, so "node exited" means the shop is shut.
   The specific route is now guarded at source (readMeta/listThreads/listTurns
   + atomic writeMeta), but the class is what matters: stay up, log loudly, and
   let the broken thing be visibly broken instead of fatal.
   ========================================================================== */
process.on("uncaughtException", err => {
  console.log("UNCAUGHT EXCEPTION (server stayed up): " + (err && err.stack ? err.stack : err));
});
process.on("unhandledRejection", err => {
  console.log("UNHANDLED REJECTION (server stayed up): " + (err && err.stack ? err.stack : err));
});
