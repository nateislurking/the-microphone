# Architecture — how the Microphone works

*One server file, three ideas, no dependencies. If you read one thing before changing the code,
read "the resume spawner" — everything else follows from it.*

---

## The shape

```
   your phone / your browser
            │
            │  http, loopback only
            ▼
   ┌──────────────────────┐
   │  server.js           │   node stdlib only, one file
   │                      │
   │   /api/threads       │──── the strip: every line, unread counts
   │   /api/thread        │──── one line's turns
   │   /api/reply         │──── you say something  ──┐
   │   /api/paste         │──── an image                │
   │   /api/shop          │──── the Cockpit's files     │
   │   /file              │──── the whitelisted viewer   │
   └──────────────────────┘                              │
            │                                            │
            │  threads/<slug>/                           │
            ▼                                            ▼
   ┌──────────────────────┐              ┌────────────────────────────┐
   │  the truth, on disk  │              │  claude -p --resume <id>   │
   │  thread.json         │◀─────────────│  cwd = the line's folder   │
   │  turns/*.json        │   writes     │  short-lived, one per turn │
   │  work/CLAUDE.md      │              └────────────────────────────┘
   └──────────────────────┘
```

**Nothing is held in memory that matters.** Kill the server mid-conversation and you lose the
in-flight turn, nothing else. The page is a window onto files.

---

## Idea one: the resume spawner

There is no long-lived agent process. A reply is delivered by spawning a short-lived
`claude -p --resume <sessionId>` whose working directory is that line's folder. It answers, writes
its turn, and exits.

This is the decision everything else hangs off, and it buys three things:

- **No process to babysit.** Nothing to supervise, leak, or reap. The server's job is files and
  HTTP.
- **Conversations survive everything.** The transcript lives on disk. Restart the server, reboot
  the machine, come back in a week — resume picks up where it left off.
- **Cost scales with use, not with uptime.** Ten idle lines cost nothing.

The one hard constraint it creates: **sessions do not lock**. Two concurrent resumes of the same
session fork the transcript. So replies are serialized strictly per line — one in-flight child per
line, everything else queued. That queue is why you can fire three messages at a line from your
phone and get one coherent answer.

## Idea two: lines, and the charter stamped at birth

A **line** is a department. It has its own folder, its own session, its own model, and its own
working directory. You open one per job — "the invoice line," "the website line" — and it holds
that context until you close it.

Every line is born with a **charter** written into its folder as `CLAUDE.md`, so the session loads
it natively on the very first turn. The charters live in `charters/` and are **re-stamped from the
template before every single spawn**. That matters more than it sounds: it means editing a charter
reaches every line at its next turn, with no retrofit sweep and no line stranded on an old copy.

It also means the reverse — anything hand-edited into a line's own `CLAUDE.md` is overwritten on
the next turn. Edit the template, never the copy.

Three charters ship:

| Charter | Who gets it | What it adds |
|---|---|---|
| `LINE-CHARTER.md` | every line | how to carry a turn: full prose, numbered decisions, real paths |
| `DESK-CHARTER.md` | the Desk | routing, opening lines, never inventing a model id |
| `FOREMAN-CHARTER.md` | the Foreman | the two postures, staging vs executing |
| `AUTOPILOT-CHARTER.md` | autopilot seats | running a mission you handed off and stepped away from |

**These are the soul of the thing.** The code is a few thousand lines of plumbing; the charters are
what make a line behave like a colleague instead of a chat box. Rewrite them to sound like you.

## Idea three: standing lines vs ordinary lines

- **The Desk** never closes. It is the router — you talk to it first, it answers small things and
  opens lines for the rest. It runs on the cheap fast model on purpose.
- **The Foreman** (optional, off by default) is the one line that can be handed elevated helpers
  for a single turn. See `SECURITY.md`.
- **Ordinary lines** live until you close them: five minutes or five days.

Standing lines are enforced by `role` in the server: the close endpoint refuses them even with
`force`. They rotate instead — a rotation archives the transcript and starts a fresh session in
the same seat, so context stays manageable without the seat ever leaving the strip.

---

## The things that look like details and are not

**Turn pairing.** Turns are stored as separate files and paired for display. A user turn with no
assistant answer renders as visibly unanswered rather than silently vanishing — which is what you
want after a crash, because "my message disappeared" is the worst possible failure mode for a
thing you talk to from a phone.

**Scroll memory.** The page keeps your reading position in JS, never by reading it back off a
hidden element (a `display:none` element reports zeros and ignores writes). And it detects *which*
element actually scrolls at runtime — the stream on a desktop, the document on a phone — rather
than re-encoding the CSS breakpoint in JavaScript, so a stylesheet change cannot silently un-fix
it.

**The sweep gate.** A line's `work/` folder is untracked scratch. Closing a line only renames its
folder — it lifts nothing. So the server **refuses to archive a line whose `work/` still holds
files**, and gives the line a turn on its own archive listing exactly what must be lifted first.
At one or two closes a day you would catch this by hand. At fifteen you would not, and work would
get buried by a folder rename. `[CLOSE-LINE:FORCE]` is the deliberate escape, and it logs that it
discarded things, on purpose: throwing work away should be a decision someone made.

**The fold.** No line commits anything — that's a charter rule, and it exists so two lines working
the same tree can't clobber each other. Which means somebody has to do the committing, or work
piles up uncommitted forever. When a line closes, the server drops a row in the Foreman's in-tray,
and that tray is injected into the Foreman's next turn. No turn is spawned by a close (at fifteen
closes a day that would be pure noise) — the work just waits somewhere visible until you say "fold
the shop." The Cockpit reads the same tray for its awaiting-fold count.

**The day boundary.** Nothing resets on a clock. A timer at midnight cuts off whoever works late,
and a card raised while you sleep is a card you already blew past. The check runs on your first
turn of a sitting — the only moment you can answer it — and it asks; it never acts.

---

## What is deliberately not here

- **No database.** Files. You can read the whole state in a text editor, which is the point.
- **No npm dependencies.** `http`, `fs`, `path`, `child_process`, `crypto`, `os`, `url`. Nothing to
  audit, nothing to update, no supply chain.
- **No build step.** The page you edit is the page that serves.
- **No liveness beyond "working…".** No token counters, no tool-call feed, no sub-agent chatter.
  A line shows you prose. That is a considered choice, and it has a real cost — see the note about
  refusals in `SECURITY.md`.
- **No user accounts.** One person, one machine.

---

## Where to start reading

`server.js` is long but linear, and the comments explain *why* rather than *what* — most of them
were written the day something broke. Reading it top to bottom is a reasonable afternoon.

The load-bearing functions, in order: `runTurn` (the spawner and its env), `makeThread` (birth and
charter stamping), `closeLine` (the sweep gate), and the `/api/reply` handler (queueing).
