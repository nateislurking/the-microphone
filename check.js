#!/usr/bin/env node
/* ============================================================================
   check.js  --  the package's own consistency checker.  `node check.js`
   ----------------------------------------------------------------------------
   Run it before you commit. It exits 0 when everything agrees and NON-ZERO with
   a named failure when it doesn't, so it can sit in a pre-commit hook or CI.

   WHY IT EXISTS -- the failure it was written for, stated plainly:

     server.js contains the string "follow THE FOLD in your charter", injected
     into the Foreman on every turn. During a packaging pass, the charter section
     called THE FOLD was deleted. Nothing broke. Nothing warned. The server went
     on confidently pointing an agent at instructions that no longer existed, and
     the only symptom would have been an agent quietly doing the wrong thing at
     the one moment it was trusted with a commit.

   That is the whole class of bug this file hunts: TWO THINGS THAT MUST AGREE,
   living in two files, with nothing checking that they still do. A rule with no
   checker is a hope. Every check below is one of those pairs.

   Node stdlib only, same as the server. No dependencies, nothing to install.
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const failures = [];
const notes = [];
let checksRun = 0;

function fail(check, detail, fix) {
  failures.push({ check, detail, fix });
}
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return null; }
}
function exists(rel) {
  try { fs.statSync(path.join(ROOT, rel)); return true; } catch (e) { return false; }
}
function listFiles(dir, out = []) {
  for (const name of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (name.name === ".git" || name.name === "node_modules" || name.name === "threads") continue;
    const rel = path.posix.join(dir, name.name);
    if (name.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}
const ALL = listFiles(".").map(p => p.replace(/^\.\//, ""));
const TEXT = ALL.filter(p => /\.(js|mjs|md|html|css|json|sh|service\.example|cmd)$/.test(p) || p.endsWith(".example"));

/* ==========================================================================
   CHECK 1 -- the charter templates the server reads must exist.
   The server resolves charter filenames as string literals. Rename a charter
   and the read silently falls back to a stub that says "(template missing)" --
   which a line then reports as its charter. Measured: a real line answered
   "I can see the Line Charter section, but the template is marked as missing."
   ========================================================================== */
{
  checksRun++;
  const server = read("server.js") || "";
  const wanted = [...server.matchAll(/TEMPLATES_DIR,\s*"([^"]+\.md)"/g)].map(m => m[1]);
  if (!wanted.length) {
    fail("charter-files", "found no TEMPLATES_DIR reads in server.js — this check has gone blind",
         "the server's charter-reading code changed shape; update CHECK 1's pattern");
  }
  for (const f of new Set(wanted)) {
    if (!exists(path.posix.join("charters", f))) {
      fail("charter-files", `server.js reads charters/${f} — that file does not exist`,
           `create charters/${f}, or fix the filename in server.js`);
    }
  }
}

/* ==========================================================================
   CHECK 2 -- THE ONE THIS FILE EXISTS FOR.
   Every charter SECTION the shipped code names must be a real heading in a
   shipped charter. The code tells agents to "follow X in your charter"; if X
   isn't there, the agent is being pointed at nothing.
   ========================================================================== */
{
  checksRun++;
  const headings = [];
  for (const f of ALL.filter(p => p.startsWith("charters/") && p.endsWith(".md"))) {
    for (const line of (read(f) || "").split("\n")) {
      if (/^#{1,3}\s/.test(line)) headings.push({ file: f, text: line.replace(/^#+\s*/, "") });
    }
  }
  const normalize = s => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const haystack = headings.map(h => normalize(h.text));

  // The shapes the code actually uses to point at a charter section.
  const POINTERS = [
    /follow\s+([A-Z][A-Z0-9' -]{2,40}?)\s+in\s+(?:your|the)\s+charter/g,
    /([A-Z][A-Z0-9' -]{2,40}?)\s+in\s+(?:your|the)\s+charter/g,
    /charter'?s?\s+([A-Z][A-Z0-9' -]{2,40}?)\s+section/g,
  ];
  let pointersFound = 0;
  const seen = new Set();   // two of the patterns overlap on purpose; report each pair once
  // check.js is skipped: it QUOTES the pointer shapes in its own header to explain itself.
  for (const f of TEXT.filter(p => /\.(js|html)$/.test(p) && p !== "check.js")) {
    const src = read(f) || "";
    for (const re of POINTERS) {
      for (const m of src.matchAll(re)) {
        const want = normalize(m[1]);
        if (want.length < 3) continue;
        const key = f + "|" + want;
        if (seen.has(key)) continue;
        seen.add(key);
        pointersFound++;
        const hit = haystack.some(h => h.includes(want) || want.includes(h));
        if (!hit) {
          fail("charter-sections",
               `${f} points agents at charter section "${m[1].trim()}" — no such heading in charters/`,
               `add that section to the right charter, or stop referencing it in ${f}`);
        }
      }
    }
  }
  notes.push(`charter-section pointers checked: ${pointersFound}`);
  if (!pointersFound) {
    notes.push("  ⚠ none found — if the code still says \"in your charter\" somewhere, CHECK 2 has gone blind");
  }
}

/* ==========================================================================
   CHECK 3 -- every internal file reference resolves.
   Docs cross-link constantly (README -> docs/SECURITY.md -> examples/README.md).
   A dead link is the same failure as a dead charter pointer, one layer out.
   ========================================================================== */
{
  checksRun++;
  const REF = /(?:\]\(|`)((?:docs|charters|examples|units|assets|test)\/[A-Za-z0-9._/-]+)(?:\)|`)/g;
  let refs = 0;
  for (const f of TEXT) {
    for (const m of (read(f) || "").matchAll(REF)) {
      const target = m[1].replace(/[.,;:]$/, "");
      if (target.endsWith("/")) continue;
      refs++;
      if (!exists(target)) {
        fail("dead-reference", `${f} references ${target} — that file does not exist`,
             `create it, or fix the reference in ${f}`);
      }
    }
  }
  notes.push(`internal file references checked: ${refs}`);
}

/* ==========================================================================
   CHECK 4 -- the config contract, both directions.
   A key the server reads but the example never mentions is undiscoverable.
   A key the example documents but nothing reads is a lie in writing.
   ========================================================================== */
{
  checksRun++;
  const server = read("server.js") || "";
  const exampleRaw = read("mic.config.example.json") || "{}";
  let example = {};
  try { example = JSON.parse(exampleRaw); }
  catch (e) { fail("config", "mic.config.example.json is not valid JSON: " + e.message,
                   "fix the JSON — the server hard-exits on a malformed config, and so would a user's"); }

  const documented = Object.keys(example).filter(k => !k.startsWith("_"));
  const readInCode = new Set([...server.matchAll(/\bCFG\.([A-Za-z][A-Za-z0-9]*)/g)].map(m => m[1]));
  // nested blocks the server pulls into their own constants rather than via CFG.x
  for (const nested of ["models", "foreman", "cockpit"]) {
    if (new RegExp(`CFG\\.${nested}\\b|CFG_${nested.toUpperCase()}`).test(server)) readInCode.add(nested);
  }

  for (const k of documented) {
    if (!readInCode.has(k)) {
      fail("config", `mic.config.example.json documents "${k}" but server.js never reads it`,
           `wire it up in server.js, or drop it from the example so it stops promising something`);
    }
  }
  for (const k of readInCode) {
    if (!documented.includes(k)) {
      fail("config", `server.js reads config key "${k}" but mic.config.example.json never mentions it`,
           `document "${k}" in the example file — an undocumented key is an undiscoverable one`);
    }
  }
  notes.push(`config keys checked: ${documented.length} documented, ${readInCode.size} read`);
}

/* ==========================================================================
   CHECK 5 -- nothing private ships.
   This package was cut from a working install. These are the shapes of things
   that must never come back with it: real hostnames, real key material, machine
   paths, the original operator's name outside the license.
   ========================================================================== */
{
  checksRun++;
  const DENY = [
    { re: /\bsk-[A-Za-z0-9]{16,}/,            what: "what looks like an API key" },
    { re: /\bghp_[A-Za-z0-9]{20,}/,           what: "what looks like a GitHub token" },
    { re: /\bre_[A-Za-z0-9]{16,}/,            what: "what looks like a Resend key" },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
    { re: /\b[a-z0-9-]+\.ts\.net\b/,          what: "a real tailnet hostname" },
    { re: /\/home\/[a-z]+\/ai-environment/,   what: "an absolute path from the machine this came from" },
    { re: /\bnate-os\b/,                      what: "a reference to the private workspace it was cut from" },
  ];
  const ALLOW_IN = { "LICENSE": true, "check.js": true };   // the license names a copyright holder; this file names the patterns
  let scanned = 0;
  for (const f of TEXT) {
    if (ALLOW_IN[f]) continue;
    const src = read(f);
    if (src == null) continue;
    scanned++;
    for (const d of DENY) {
      const m = src.match(d.re);
      if (m) {
        fail("private-residue", `${f} contains ${d.what}: ${JSON.stringify(m[0].slice(0, 48))}`,
             `remove it — this package is meant to be public`);
      }
    }
  }
  notes.push(`files scanned for private residue: ${scanned}`);
}

/* ==========================================================================
   CHECK 6 -- the code still parses.
   Cheap, and it catches the edit that was "obviously fine".
   ========================================================================== */
{
  checksRun++;
  for (const f of ALL.filter(p => p.endsWith(".js") && !p.startsWith("assets/"))) {
    try { new (require("vm").Script)(read(f), { filename: f }); }
    catch (e) { fail("syntax", `${f} does not parse: ${e.message}`, "fix the syntax error"); }
  }
}

/* ========================================================================== */
const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", OFF = "\x1b[0m";
console.log("");
for (const n of notes) console.log(DIM + "  " + n + OFF);
console.log("");
if (!failures.length) {
  console.log(GREEN + `  PASS` + OFF + ` — ${checksRun} checks, nothing disagrees.`);
  console.log("");
  process.exit(0);
}
console.log(RED + `  FAIL` + OFF + ` — ${failures.length} problem(s) across ${checksRun} checks:\n`);
for (const f of failures) {
  console.log(RED + "  ✗ " + f.check + OFF + "  " + f.detail);
  console.log(DIM + "      fix: " + f.fix + OFF);
}
console.log("");
process.exit(1);
