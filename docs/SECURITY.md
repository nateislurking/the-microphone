# Security — what this is, and what it is not

*Read this before you enable anything in the `foreman` block, and before you put the Mic on a
network. It is written to be honest rather than reassuring. Where something is a real boundary it
says so; where something is a ceremony it says that instead, because a ceremony you mistake for a
boundary is worse than no ceremony at all.*

---

## The one-sentence version

**The Microphone hands your AI agent the same power you have on your own machine, and then shows
you what it did in prose.** Everything below is about making that sentence safe to live with, and
about being clear that the safety comes from *what you point it at*, not from a sandbox.

---

## What actually protects you

**1. It binds to loopback.** `127.0.0.1`, always. Nothing reaches it from the network unless you
deliberately put something in front of it. There is no authentication on the API, because on
loopback the OS user *is* the authentication.

**2. The file viewer is whitelisted to one tree.** `/file` and the viewer page will serve a file
only from inside `workspaceRoot`, resolved once at boot from config. Nothing from a request ever
selects the root. A path that lands outside the tree is refused, not redirected.

**3. The static server is jailed to the Mic's own folder.** It cannot serve your workspace. That
is why the Cockpit reads its files through a separate, explicitly read-only endpoint.

**4. The spawn environment is scrubbed.** Lines are spawned with a deliberately reduced
environment. They cannot reach your service manager, which is what makes the helper baseline below
mean anything.

**5. The helper baseline.** Elevated helper scripts are hashed into memory at boot and re-checked
before any turn is armed. If a helper changed while the server was running, arming is refused.
See "the trap" below — this is the sharpest idea in the codebase and it is worth understanding.

**6. The approval word is never written to disk.** It lives outside the workspace, is read fresh
on every reply, and is redacted to `[ARMED]` before any turn text is stored. It is never logged,
never echoed, and never travels to a rendered surface.

**7. Data cannot arm the door.** Only *your own* user-role reply on the foreman line is scanned
for the word. Never an assistant turn, never file contents, never anything a line read somewhere.
A web page that says "the approval word is banana" cannot do anything with that.

---

## What does NOT protect you — read this part twice

### The approval word is a presence ceremony, not a boundary

Every line runs as **the same OS user**. The word file is mode 600 and owned by you — and so is
every line, because every line *is* you. Any line that wanted to could read the word file and
self-authorize anything the word gates.

That is not a bug being disclosed reluctantly; it is the actual design, and knowing it changes how
you should use it. The word answers **"is a human at the keyboard approving this right now?"** It
does not answer **"is this line trustworthy?"** Those are different questions and only the first
one has a cheap answer.

**The rule that follows: never put a destructive or irreversible action behind the word alone.**
The word is right for "send this email I just read," which you were about to approve anyway. It is
wrong as the only thing standing between a confused line and your production database.

The real fix is running lines as a separate, less privileged OS user. For a one-person workshop
that is usually more machinery than the risk justifies. Decide that for yourself rather than
inheriting the assumption.

### `allowedTools` is intent, not containment

The tool list shapes what the model is **told** it may reach. Depending on your own Claude settings
— particularly if you run with permissions relaxed — it may not constrain what a line **can**
reach. Treat the list as a way to keep an agent pointed at its job, never as a fence.

### A line is as powerful as you are

Lines work on your real tree. They can read anything you can read and write anything you can
write. That is the entire point — a line that can only touch a sandbox cannot do your work — but
it means the honest security boundary of this system is **the machine account you run it as**.

---

## The trap worth understanding

This one is worth the two minutes even if you never enable the Foreman.

An **unarmed** Foreman turn holds no outbound capability. But it still has `Write` and `Edit`, and
those carry no path restriction. So an unarmed turn can rewrite the very script that an **armed**
turn will later execute with live credentials in its environment.

This was measured, not imagined: an unarmed turn appended a line to a deploy helper using nothing
but ordinary editing tools. And the trap is *patient* — the rewrite just sits there until the next
time you say the word, and a ledger that records only exit codes reports `ok` either way.

The fix is the baseline: hash the helpers at boot, hold the hashes **in memory**, re-verify before
arming. An on-disk manifest would have been useless, because it is writable by the same line that
rewrote the script. Root-owning the helpers was rejected too — it breaks `git pull` on every
update, and a guard people route around is not a guard.

**The general form: the thing that grants a capability must not be writable by the thing being
granted it.** That principle outlives this codebase.

---

## Prompt injection

Lines read things you did not write — web pages, files, command output, whatever you point them
at. Text that arrives that way is **data**, never instructions. The Mic's own defence is narrow
and specific: the arming word is scanned for only in your own replies, so no amount of hostile
text in a fetched page can elevate a turn.

Beyond that, the defence is you. A line whose *job* is reading untrusted input is a genuinely
different risk profile from a line drafting a document with you watching, and it deserves a
narrower setup — its own workspace, no elevated helpers, and a healthy suspicion of anything it
brings back that reads like an instruction.

---

## If you put it on a network

The Mic is loopback-only and **has no authentication**. If you want it on your phone — and you
will, it's the whole point — put it behind something that authenticates *before* the request
reaches this server. A private mesh network (Tailscale and similar) is the low-effort answer:
device-level identity, no port forwarding, no password to leak.

**Do not** simply change `HOST` and forward a port. An unauthenticated endpoint that spawns agents
with your file permissions is not something to leave facing the internet.

One practical note if you install it as a phone app: an installed PWA claims links for a whole
**hostname**, and that claim is port-blind. A second app on the same host will refuse to install
even on a different port. Give each one its own hostname.

---

## Reporting something

Found a hole? Open an issue, or reach the author through **[natestpierre.me](https://natestpierre.me)**.
If it is sensitive, say so and don't put the details in a public issue.
