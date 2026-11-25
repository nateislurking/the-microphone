# The Microphone

<!-- publish-gate: prose-scan-exempt — documents literal program output, which uses
     placeholder home paths (/home/you/...). Not real paths. L1 and L3 still apply. -->

> **No longer updated (November 2026).** This is a snapshot of the tool as my shop built it. The code
> stays here, free under its license, but it won't be updated.

**Run a shop of AI agents from your phone.**

You talk into it, and a room full of agents goes to work. Each one is a *line* — its own
conversation, its own folder, its own job — and they all multiplex into one window you can open
from your pocket. Say "open a line for the inbox cleanup," walk away, and check on it from the
kitchen.

It's one Node file with no dependencies, and it runs on top of Claude Code on your own machine.
Everything it knows lives in plain files you can read in a text editor.

*Free to take and use, MIT. Built and used daily by the one-man shop at
[natestpierre.me](https://natestpierre.me).*

---

## What it actually is

Claude Code is superb in a terminal and useless from a phone. The Microphone is a thin web surface
over it: it spawns short-lived agent turns, keeps every conversation on disk, and shows you prose
instead of machinery.

What that buys you in practice:

- **Many jobs at once.** Ten lines running, each holding its own context. A strip on the left shows
  which are working and which are waiting on you.
- **It survives everything.** Close the browser, reboot the machine, come back in a week — the
  conversations are files, and they resume. Nothing to babysit.
- **It works on a phone.** Really works: voice dictation into the reply box, a paperclip for the
  photo you just took, a status dot you can read from across the room.
- **Agents that behave like colleagues.** Every line is born with a *charter* — full prose, real
  file paths, numbered decisions, and a hard rule against pretending something is done. The
  charters are the soul of this; they're four markdown files and you should rewrite them to sound
  like you.
- **Nothing hidden.** No database, no build step, no npm tree. If you want to know what it did,
  read the files.

**Honest about what it is not:** a single-user tool for your own machine, with no authentication
and no sandbox. Your agents have your file permissions. Read
[`docs/SECURITY.md`](docs/SECURITY.md) — it's written to be honest rather than reassuring, and
it's short.

---

## What you need

| | |
|---|---|
| **Node.js** | 18 or newer. No packages to install — it uses the standard library only. |
| **Claude Code** | Installed and already signed in. If `claude` runs in your terminal, you're set. |
| **A folder to work in** | Any project. This is the *workspace* — the tree your lines read and write. |
| **A browser** | That's the whole interface. |

Linux and macOS work out of the box. Windows works — there's a `start-mic.cmd` — but the service
setup below is Linux-flavoured.

---

## Stand it up

**1. Clone it next to the project you want to run.**

```bash
cd ~/projects/my-project
git clone https://github.com/nateislurking/the-microphone.git
cd the-microphone
```

The default config assumes exactly this: the workspace is the folder *containing* the Microphone.
If you'd rather put it somewhere else, set `workspaceRoot` in step 2.

**2. Make a config.**

```bash
cp mic.config.example.json mic.config.json
```

Open it. Every key is optional and the comments explain each one — an empty `{}` boots a working
Microphone. The two worth setting on day one:

- `workspaceRoot` — the tree your lines work in, and the only tree the file viewer will serve from.
- `models` — which models exist and what your spoken words map to. Set `default` to the model you
  want a new line *born* on.

Leave the `foreman` block alone for now. It's off by default and it should stay off until you've
read `docs/SECURITY.md`.

**3. Start it.**

```bash
node server.js
```

You should see:

```
  the desk            : born (cwd /home/you/projects/my-project)
THE MICROPHONE is up  ->  http://127.0.0.1:8080
  workspace root      : /home/you/projects/my-project
  config              : /home/you/projects/my-project/the-microphone/mic.config.json
  claude binary       : /home/you/.local/bin/claude
  threads             : /home/you/projects/my-project/the-microphone/threads
  foreman helpers     : 0 baselined  (none found)
```

(The Desk line comes first because it's born before the server starts listening. `0 baselined` is
correct on a fresh install — the Foreman door is off, so there are no helpers yet.)

If `claude binary` says **NOT FOUND**, set `claudeBin` in your config to the full path — that's the
one failure that will otherwise look like everything working until the first turn dies.

**4. Open `http://127.0.0.1:8080` and say something to the Desk.**

Try: *"Open a line for the README cleanup, on Sonnet."* You'll see it appear in the strip.

That's the whole setup. Everything below is optional.

---

## Get it on your phone

This is the point of the thing, and it's the one step you shouldn't improvise.

The Mic binds to **loopback only and has no authentication** — on your own machine, the OS user
*is* the authentication. To reach it from a phone you need something that authenticates *before*
the request arrives.

The low-effort answer is a private mesh network. [Tailscale](https://tailscale.com) is free for
personal use and does this in about five minutes: install it on both devices, then serve the Mic
over your tailnet. Device-level identity, no port forwarding, no password to leak.

Then open it on your phone and **Add to Home Screen** — it ships a web app manifest, so it installs
like an app, opens without browser chrome, and lands one tap from your home screen.

**Do not just change `HOST` and forward a port.** An unauthenticated endpoint that spawns agents
with your file permissions is not something to leave facing the internet.

*(One gotcha if you install more than one of these: a phone's installed web app claims links for an
entire hostname, and that claim is port-blind. A second app on the same host will refuse to
install even on a different port. Give each its own hostname.)*

---

## Keep it running

On Linux, run it as a systemd user service so it survives logouts and comes back after a crash:

```bash
mkdir -p ~/.config/systemd/user
cp units/mic.service.example ~/.config/systemd/user/mic.service
# edit WorkingDirectory and CLAUDE_BIN in that file
systemctl --user daemon-reload
systemctl --user enable --now mic
```

Then `systemctl --user restart mic` after any change to `server.js`, and
`journalctl --user -u mic -f` to watch it.

⚠ Once the unit exists, **don't hand-launch `node server.js`**. A hand-launched server looks alive
— the page renders, the API answers — but it doesn't carry the unit's environment, so every line
turn dies on a missing binary. This is the single most confusing failure mode in the whole system,
which is why it's called out twice.

To keep it running while you're logged out: `sudo loginctl enable-linger $USER`.

---

## Make it yours

**The charters are the part to change.** `charters/` holds four markdown files that are written
into every line at birth and re-stamped before every turn. They decide whether your agents write
like colleagues or like a chat box. Edit the *template*, never a line's own copy — the copy is
overwritten on the next turn, by design, so a charter change reaches every line immediately.

Start with `LINE-CHARTER.md`. It's the one every line gets.

**Run `node check.js` before you commit.** It checks the pairs of things that must agree and
have nothing enforcing it: every charter section the code points agents at actually exists, every
doc cross-reference resolves, every config key is both read and documented, and nothing private
crept in. It exists because of a real failure — `server.js` tells the Foreman to "follow THE FOLD
in your charter," that section got deleted during a packaging pass, and *nothing broke.* The server
went on confidently pointing an agent at instructions that were not there. Exits non-zero, so it
sits fine in a pre-commit hook.

**The Cockpit tab** renders plain markdown files you already keep — a decision list, a backlog, a
one-line "what I'm working on." Optional, read-only, and documented in
[`docs/COCKPIT.md`](docs/COCKPIT.md). Leave it unconfigured and it stays out of the way.

**The Foreman** is one line that can be handed real capability — a deploy, a send — for exactly
one turn, when your reply carries an approval word. It ships **off**. The pattern is in
[`examples/README.md`](examples/README.md), the honest limits are in
[`docs/SECURITY.md`](docs/SECURITY.md), and the short version is: the word proves a human is
present, it does not make a line trustworthy. Never put something irreversible behind it alone.

---

## Where everything is

| | |
|---|---|
| [`docs/OPERATING.md`](docs/OPERATING.md) | **Read this second.** How you actually run it day to day. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | **Read this first if you enable anything.** What protects you and what doesn't. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works inside, and why it's shaped this way. |
| [`docs/COCKPIT.md`](docs/COCKPIT.md) | The optional second tab and the file formats it reads. |
| [`examples/`](examples/) | The elevated-helper pattern, and one harmless working helper. |
| `charters/` | What your agents are told about how to work. Change these. |
| `server.js` | The whole thing. Long, but linear, and the comments explain *why*. |
| `check.js` | The consistency checker. Run it before you commit. |

---

## A note on the comments

Most of the comments in `server.js` were written the day something broke, and they say what broke
rather than what the code does. That's deliberate. If you're trying to understand a guard, the
comment above it will usually tell you the failure it exists to prevent — which is more useful than
a restatement of the line below it, and it's the part that doesn't survive a rewrite.

---

## License

MIT — see [`LICENSE`](LICENSE). Take it, change it, ship it, sell what you build with it. A link
back to [natestpierre.me](https://natestpierre.me) is appreciated, never required.
