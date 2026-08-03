# The Cockpit tab — what it renders, and the formats it expects

*Optional. The Microphone works completely without it. Skip this until you want one page that
carries both your lines and your notes.*

---

## What it is

A second tab beside the conversation that renders **plain files you already keep** in your
workspace. It writes nothing, ever — there is no write path in the endpoint that feeds it and
there must never be one.

The point is the phone. If your working notes live in a repo, they are unreachable from a phone
without a second server and a second thing to keep alive. This serves them through the Mic itself,
same origin, no extra moving parts.

## Turning it on

Name the files in `mic.config.json`. Every key is optional; leave one out and that panel is simply
absent rather than empty-looking. Paths are relative to `workspaceRoot`, and absolute paths are
refused.

```json
"cockpit": {
  "files": {
    "board":   "BOARD.md",
    "backlog": "BACKLOG.md",
    "now":     "NOW.json",
    "pulse":   "",
    "desk":    "",
    "sides":   []
  }
}
```

## The formats

These parsers read **ordinary markdown you would keep by hand anyway**. Nothing here is a format
invented for the Cockpit's benefit — if you already keep a decision list and a backlog, they
probably almost fit already.

### `now` — a small JSON file

The one thing you'd want to read first. Keep it current as you work; a stale one is worse than
none, so the page prints its own timestamp and lets it visibly age.

```json
{
  "updatedAt": "2026-08-02T20:35:00-05:00",
  "workingOn": "One sentence about what is actually happening right now.",
  "upNext": ["The next thing", "The thing after that"]
}
```

Anything unparseable renders as absent rather than as an invention.

### `board` — a markdown file with a decisions table

The parser looks for a `##` heading containing **DECISION REGISTER**, then reads every pipe-table
row under it as `| id | text | status |`:

```markdown
## DECISION REGISTER

| # | Decision | Status |
|---|---|---|
| **12** | Do we ship the thing on Friday or wait? (a) ship (b) wait | OPEN |
| **11** | Which model do the standing seats run on? | ruled — Sonnet |
```

Header and divider rows are skipped. The id can be `12`, `4.1`, or anything else short. The rest
of the file is rendered as markdown, so the table is an *addition* to a normal document, not a
replacement for one.

### `backlog` — a markdown file with a `## Now` section

Every top-level `-` bullet under `## Now` becomes a row. Only the **first line** of each bullet is
shown, so write your headline first and the detail underneath:

```markdown
## Now
- **The thing I might pick up next.** Then as much detail as you like on the
  following lines — none of it appears in the Cockpit.

## Next
- Things down here are counted, not listed.
```

Sections other than `## Now` are counted and shown as a footer — so the pickable queue stays short
without ever pretending to be the whole backlog.

### `sides` — a list of extra markdown files

Rendered as additional panels. A file that exists but contains no list item is treated as a
retired stub and skipped, rather than shown as a ghost panel.

### `pulse` — a JSON file of machine facts

Whatever you write there, rendered as a strip. Meant for something a script writes on a timer —
disk, uptime, queue depth. A leading byte-order mark is tolerated, because some tools emit one and
`JSON.parse` throws on it.

### `desk` — one HTML page of your own

An optional link to any page you keep — a dashboard, a cheat sheet. Served through the file
viewer, so it reaches the phone. Omit it and the link doesn't appear.

---

## If you keep none of these

Then leave the whole `cockpit` block out. The tab renders honestly empty, and the Microphone —
which is the actual product — is untouched.
