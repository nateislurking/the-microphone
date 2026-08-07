# Operating it — the manual

*How you actually run this thing day to day. The internals are in `ARCHITECTURE.md`; this is the
part you read once and then just know.*

---

## The shape, in words

- **The Microphone** — one window: the strip of lines on the left, the open line's conversation on
  the right, the Cockpit tab beside it.
- **The Desk** — the standing line that never closes. You talk to it first. It routes, answers
  quick things, and opens lines for everything else.
- **Lines** — one per job. Each is its own agent session with its own model, folder, and charter.
- **You** — the only person here. There are no accounts and no other users.

---

## Opening a line

Say it to the Desk: **"Open a line for the inbox cleanup, on Sonnet."**

- **Name the model or don't.** No model named means the server's default. The Desk names the model
  back in its confirmation so you can correct it in one word.
- **Switch mid-line.** The model pill in the line's header is a selector. The change takes effect
  on that line's next turn — no restart, no lost context.
- **The + button** at the bottom of the strip is the manual path, for when the Desk itself is the
  thing that's wedged.

A useful habit: one line per *job*, not per *topic*. A line holds context, and context is the
whole value — a line you've been working in for two days knows things a fresh one doesn't.

---

## Working with a line

- Lines answer in **full prose** and end on a decision point. When blocked they stop and ask,
  listing independent items you grant **by number** — a grant sticks for that chunk of work.
- **File paths render as links.** Long ones display shortened with the full path on hover. A line
  that shows you a dead truncated path is violating its own charter; tell it to use full paths.
- **Code blocks carry a copy button.**
- **Attach an image** two ways: paste a screenshot straight into the reply box, or tap the
  paperclip. On a phone the paperclip opens Camera / Photo Library — which is the only way to get
  a photo you just took into a conversation, since phones have no paste path for one.
- **Stop** kills a runaway turn. You lose that turn and nothing else.
- Bullets, dashes, anything — your replies travel by stdin, so no character in your message can
  be read as an option.

---

## Wrapping and closing — your two sentences

**"Wrap."** The line settles: says what's done, names every deliverable with full paths, writes
its one-line report. The wrap is a *settle*, not a backup. Nothing is committed by wrapping.

**"Close this line."** The line runs its close ceremony and the server moves its whole folder —
turns, work files, everything — into `threads/_closed/`, kept forever. **Closing never deletes
anything.**

### The sweep gate — the one rule worth knowing before you close things

A line's `work/` folder is untracked scratch, and closing runs no sweep. It only renames the
folder. So "closing never deletes anything" was true and still misleading: nothing was deleted,
but nothing would ever *lift* it either.

So the server **refuses to archive a line while its `work/` holds anything but the stamped
`CLAUDE.md`.** The line stays open and gets a turn on its own archive, listing the exact absolute
paths you need to lift first. The gate opens by itself once `work/` is clear.

When the sandbox files really are spent: **`[CLOSE-LINE:FORCE]`**. It closes and logs that it
discarded N files, deliberately — throwing work away should be a decision someone made, not a side
effect of a folder rename.

**The habit that avoids all of this:** have lines write into your real tree, not their sandbox.
A line whose cwd is a real folder produces ordinary uncommitted edits, which is exactly what you
want.

---

## Where a line's work lives

- **Writes into your real workspace** → ordinary uncommitted changes in your tree. Same durability
  as any edit you made yourself.
- **Writes into its own sandbox** (`threads/<line>/work/`) → on-disk only, untracked. Durable the
  moment you lift it somewhere real. The sweep gate exists to make sure you get the chance.

The only genuine exposure is disk failure between doing work and committing it — which is the same
exposure as every uncommitted edit on the machine.

---

## Restarting

Code changes to `server.js` only go live on a restart.

- **As a systemd user service** (the recommended setup on Linux): `systemctl --user restart mic`.
  ⚠ Do not hand-launch `node server.js` once the unit exists. A hand-launched server *looks*
  alive — the page renders, the API answers — but it doesn't carry the unit's environment, so
  every line turn dies on a missing binary. And note a **clean** exit stays dead:
  `Restart=on-failure` won't resurrect a process that exited 0, which is deliberate.
- **Run by hand:** Ctrl-C and start it again.

In-flight turns error harmlessly on a restart. The line is fine; the transcript is on disk.

---

## Reading the strip

- **A dot on a line** means it's working.
- **A number badge** means unread turns waiting for you.
- **The tab dot** aggregates: rust means something is waiting on you and wins over green, which
  means lines are working. No dot means quiet.

That vocabulary is the same everywhere in the interface, on purpose.

---

## Time

Timestamps in the API are UTC (`...Z`). If your machine runs in another timezone — and it does —
convert before writing a time into anything you'll read later. This has bitten before: a line that
opened at 09:45 local got recorded as "14:45," and it was a surface being read in real time. The
API is right; reading it as local is the error.

---

## Honest edges

- **Wrap reports don't mechanically reach the Desk.** A line's report is text in its own turn.
  If you want it somewhere else, move it.
- **Lines have no eyes.** Anything visual — a rendered page, an image you want judged — needs a
  human or a session that can actually look. A line will describe what it *believes* it made.
- **A closed line's context is gone.** The files all remain; the conversation doesn't. A fresh
  line starts from its charter and whatever you point it at.
- **Deploys and first sends deserve a watched ceremony.** Not because the machinery is unreliable,
  but because those are the actions with no undo.
