# Tests

These are **browser tests**, not unit tests. They drive a real Chrome over the DevTools Protocol
and check the things that only break in a browser: scroll position surviving a tab flip, the lines
menu on a narrow viewport, the desk column at desk width, the status dots.

There is no test runner and no framework. Each file is a plain `.mjs` script that connects to a
Chrome you started yourself, drives the page, and prints what it found.

## Running one

Start Chrome with remote debugging on, pointed at your Mic:

```bash
chromium --remote-debugging-port=9222 --headless=new http://127.0.0.1:8080/ &
node test/scroll-restore.test.mjs
```

Each script takes an optional URL argument and defaults to `http://127.0.0.1:8080/`:

```bash
node test/desk-width.test.mjs http://127.0.0.1:8081/
```

## Why they look like this

The three page bugs these cover were each fixed twice before they stuck, because each was correct
on a desktop and wrong on a phone — or correct until a tab flip discarded the element's scroll
state. None of them could be caught without a real layout engine, so a real layout engine is what
the tests use. It's a small number of tests aimed at the exact places this page has actually broken.

The server has no test suite. It's one file with no dependencies, and it is exercised constantly by
being the thing you talk to all day.
