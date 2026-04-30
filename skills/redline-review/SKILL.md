---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments, you (a separate agent subprocess Redline spawns) reply to them, the human signs off, and the document on disk is left in its final approved state.

## How to invoke it

**Short reviews (≤10 min):** Run `redline <path-to-file.md>` via the Bash tool with `timeout: 600000`. This call blocks until the human clicks Done or abandons. The blocking behavior is the point — you wait here.

**Long reviews (>10 min):** Use the polling pattern so the Bash timeout doesn't cut you off:

```bash
# Start Redline in the background
redline /abs/path/to/file.md &
# Poll the result file until the review is done
RESULT_FILE="/abs/path/to/.review/file.md.result"
until [ -f "$RESULT_FILE" ]; do sleep 30; done
cat "$RESULT_FILE"
```

The result file is written at `.review/<basename>.result` (next to the file) when the session ends for any reason. On startup, Redline prints the result file path in its URL banner.

If `redline` is not on PATH, run `bun link` once from the redline repo root to install it globally, then retry.

Tell the human what you're doing in one short sentence before running it, e.g. "Opening this in Redline for review — I'll continue once you click Done." Redline prints the URL on startup. Surface that URL to the human in your text output too, so they can re-open the tab if they accidentally close it.

## How to interpret the result

**Blocking mode:** When the Bash call returns, look at the exit code and the last `REDLINE_RESULT:` line in stdout.

**Polling mode:** When the result file appears, read it. It's JSON:

```json
{ "status": "approved", "file": "/abs/path/to/file.md", "rounds": 2, "comments": 5 }
```

In both modes, the statuses are:

- **`approved`** — Human signed off. Re-read the file from disk (it may have been revised through multiple rounds). Continue with the work that needed approval.
- **`abandoned`** — Human closed the tab or Ctrl+C'd without clicking Done. The doc is in whatever state it was last revised to, but has not been signed off. Ask the human what they want to do.
- **`error`** — Redline crashed. Check `.review/errors.log` next to the file. Surface the error to the human.

The blocking mode also prints `REDLINE_RESULT: approved file=... rounds=N comments=N` to stdout; you can grep for `^REDLINE_RESULT:` in captured stdout.

## What you do not need to do

- You do not need to reply to comments. Redline spawns its own agent subprocess that handles inline replies during the review.
- You do not need to invoke `redline resolve` separately. Revisions happen inside the session when the human accepts.

## When *not* to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
