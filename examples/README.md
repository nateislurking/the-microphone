# Elevated helpers — the pattern

*Read `docs/SECURITY.md` first. This folder is examples only; nothing here is wired up.*

The Foreman is one line that runs **unarmed by default** — it can read and draft anywhere in
your workspace, but it holds no capability to reach the outside world. When your reply carries
the approval word, that **one turn** is spawned with a small set of hardened scripts on its tool
list and their secrets in its environment. The elevation dies with the turn.

The scripts are the whole design. An armed turn with `Bash(*)` on its tool list is the same as no
door at all — the point is that the agent chooses *arguments*, never *destinations*.

## Where they live

Put your own scripts in `helpers/` beside the server, list them by filename in `mic.config.json`:

```json
"foreman": {
  "enabled": true,
  "helpers": ["send-note.sh"],
  "secrets": { "NOTE_API_KEY": "note-api.key" }
}
```

`helpers/` is gitignored. What you actually wire up points at your accounts and is yours, not
this package's. The `secrets` map reads `note-api.key` out of your `credentialsDir` and hands it
to the armed spawn as `$NOTE_API_KEY`, for that one turn only.

## The five rules every helper follows

1. **Pin the method, host and path inside the script.** The agent supplies a payload; it never
   supplies a destination. A helper that takes a URL as an argument is not a helper, it's `curl`.
2. **Read secrets from the environment, never from `argv`.** Arguments are visible in the process
   list and they end up quoted in transcripts. Environment variables handed to one child do not.
3. **`set -euo pipefail`, and fail closed.** A missing secret must stop the script, not let it run
   against nothing and report success.
4. **Do one thing.** "Send an email" and "create a draft" are two helpers, because you will want
   to grant one and not the other.
5. **Say out loud when it cannot be undone.** A real send has no undo; the comment at the top of
   the script is the last place a person can notice that.
6. **If a helper CREATES something, write its undo in the same sitting.** This one was learned the
   expensive way. A door that can mint a live API key and cannot revoke one is the wrong shape —
   and the agent will notice before you do: ours once refused a perfectly reasonable action partly
   *because* it knew it had no way to take it back. That is correct behaviour, and it is telling
   you the door is half-built. Create and un-create are one piece of work, not two.

## The baseline check — why rule 1 isn't enough on its own

An **unarmed** Foreman turn can still use `Write` and `Edit`, which carry no path bound. So it can
rewrite the very script an **armed** turn will later run with live credentials. This was found by
measuring it, not by theorising: an unarmed turn appended a line to a deploy helper, and the trap
just sat there waiting for the next time the word was said.

So the server hashes every helper into memory at boot and re-checks before arming. If a helper
changed while the server was running, arming is **refused** and the line is told which file moved.
Re-baselining requires a restart, which a line cannot do — the spawn-env scrub removes its reach
to the service manager.

If you take one idea from this whole package, take that one: **the thing that grants a capability
must not be writable by the thing being granted it.**

## A working example

`hello-helper.sh` in this folder does nothing dangerous — it prints its argument and proves the
secret arrived. Copy it to `helpers/`, list it, arm a turn, and watch the ledger row appear. That
round trip is worth doing once before you point a helper at anything real.
