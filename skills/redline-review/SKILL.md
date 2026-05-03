---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments, an agent subprocess Redline spawns replies to them, the human signs off, and the document on disk is left in its final approved state.

## How to invoke it

**Short reviews (≤10 min):** Run `redline <path-to-file.md>` via the Bash tool with `timeout: 600000`. This call blocks until the human clicks Done or abandons. The blocking behavior is the point — you wait here.

**Long reviews (>10 min):** Use the polling pattern so the Bash timeout doesn't cut you off:

```bash
redline /abs/path/to/file.md > /tmp/redline.log 2>&1 &
RESULT_FILE="/abs/path/to/.review/file.md.result"
until [ -f "$RESULT_FILE" ]; do sleep 30; done
cat "$RESULT_FILE"
```

The result file is written at `.review/<basename>.result` (next to the file) when the session ends for any reason. On startup, Redline prints the result file path in its URL banner.

If `redline` is not on PATH, run `bun link` once from the redline repo root to install it globally, then retry.

### Pass context with `--context`

```
redline /abs/path/file.md --context "Draft of the auth-rewrite RFC — focus on the migration plan in §4."
```

The context string is shown in the reader's header so the human knows what they're being asked to review and what you'd like them to focus on. Use it whenever the file alone doesn't make the ask obvious. One sentence is plenty.

### Surfacing the URL

Redline does **not** auto-open a browser — it prints a cmd-clickable URL on startup. You must surface that URL in your text output to the human, otherwise they have no signal that anything is waiting for them. One short sentence:

> "Opening this in Redline for review at http://localhost:NNNN — cmd-click to open. I'll continue once you click Done."

(There is an `--open` flag that auto-launches the browser, but prefer leaving it off — the human may not be at the keyboard the moment the session starts, and a stolen-focus browser tab is worse than a URL they click when ready.)

## How to interpret the result

**Blocking mode:** When the Bash call returns, look at the exit code and the last `REDLINE_RESULT:` line in stdout.

| Exit code | Meaning |
|---|---|
| `0` | Approved — human clicked Done |
| `2` | Abandoned — human closed the tab or Ctrl+C'd without signing off |
| `3` | Revision error — a revision pass failed and was not recovered before the session ended |

**Polling mode:** When the result file appears, read it. It's JSON:

```json
{ "status": "approved", "file": "/abs/path/to/file.md", "rounds": 2, "comments": 5 }
```

Statuses:

- **`approved`** — Human signed off. Re-read the file from disk and continue. Note: the file may be byte-identical to what you handed off — if every comment was Q&A the agent answered with `accept-as-is`, no revision pass ran. That's still a valid approval, not a no-op.
- **`abandoned`** — Human closed the tab or Ctrl+C'd without clicking Done. The doc is in whatever state it was last revised to, but has not been signed off. Ask the human what they want to do.
- **`error`** — A revision pass failed. The result file includes a `reason` field with the failure message; `.review/errors.log` next to the file has more detail. Surface both to the human.

The blocking mode also prints `REDLINE_RESULT: approved file=... rounds=N comments=N` (or `REDLINE_RESULT: error reason="..."`) to stdout; you can grep for `^REDLINE_RESULT:` in captured stdout.

## Outer-agent handoff pattern

The full loop, when you are the outer agent producing the doc:

1. Write the markdown file to disk at an absolute path.
2. Tell the human in one sentence what's about to happen and surface the URL Redline will print.
3. Invoke `redline <abs-path> --context "<one-liner about what they're reviewing>"`. Use blocking for short reviews, the polling pattern for longer ones.
4. While the session runs, you are idle — do not start unrelated work and do not poll the file system yourself; the result file or the Bash return is your signal.
5. On `approved`: re-read the file from disk (it may have been revised) and continue with whatever required sign-off.
6. On `abandoned` or `error`: stop and ask the human how to proceed; do not retry automatically.

You do not need to reply to comments — Redline spawns its own agent subprocess for that. You do not need to invoke `redline resolve` separately — revisions happen inside the session when the human accepts.

## When *not* to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
