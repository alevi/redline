---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments, an agent subprocess Redline spawns replies to them, the human signs off, and the document on disk is left in its final approved state.

## How to invoke it

The redline launcher lives at `__REDLINE_BIN__` (substituted at install time — if you see the literal placeholder string, the skill was installed incorrectly; tell the human to re-run `redline install-skill`). Always invoke it by this absolute path. Do not call bare `redline` and do not try to "fix" PATH issues by running `bun link` or guessing where the repo lives.

**Always background the launcher and poll.** Never run `__REDLINE_BIN__` as a foreground/blocking shell call: agent shell tools often buffer stdout until the process exits, so you would never see the URL the human needs to click and your "I'll wait while you review" message would be a lie. Use this pattern:

```bash
FILE=/abs/path/to/file.md
DIR=$(dirname "$FILE"); BASE=$(basename "$FILE")
STARTUP="$DIR/.review/$BASE.startup.json"
RESULT="$DIR/.review/$BASE.result"
LOG=/tmp/redline-$BASE.log

# Kick off the review in the background and open it in the user's real browser.
__REDLINE_BIN__ "$FILE" --open > "$LOG" 2>&1 &

# Step 1: wait for startup, read the URL.
for i in $(seq 1 60); do [ -f "$STARTUP" ] && break; sleep 0.5; done
if [ ! -f "$STARTUP" ]; then
  echo "redline did not start; check $LOG" >&2
  exit 1
fi
URL=$(grep -o '"url": *"[^"]*"' "$STARTUP" | sed 's/.*"\(http[^"]*\)".*/\1/')
PID=$(grep -o '"pid": *[0-9]*' "$STARTUP" | grep -o '[0-9]*')
echo "REDLINE_URL: $URL"
echo "REDLINE_PID: $PID"

# Step 2: tell the human the browser opened (you do this after the first shell call returns
# — see the next section), then monitor until either author input is needed or the
# redline process exits. If author input is needed, answer it with author-reply and
# run this monitor loop again.
while kill -0 "$PID" 2>/dev/null; do
  PENDING=$(__REDLINE_BIN__ author-needed "$FILE" --json)
  if printf '%s\n' "$PENDING" | grep -q '"commentId"'; then
    printf '%s\n' "$PENDING"
    exit 0
  fi
  sleep 0.5
done
cat "$RESULT"
```

The startup file at `.review/<basename>.startup.json` is written synchronously when the server begins listening; it contains `url`, `port`, `file`, `result_file`, `started_at`, `pid`. The result file at `.review/<basename>.result` is written when the session ends (approved, abandoned, or error).

In practice, run the script above as **two separate shell calls** so you can tell the human the URL between steps:
1. First call: everything through `echo "REDLINE_PID: $PID"`. Returns in ~1s with the URL and PID on stdout.
2. Tell the human Redline opened in their browser, and include the URL only as a fallback (see "Surfacing the URL" below).
3. Second call: the monitor loop above. It returns either pending `author_needed` JSON or the final result JSON. Long timeout (`timeout: 1800000` = 30 min, or longer). If it returns author-needed JSON, answer with `author-reply`, then run the monitor loop again.

If invocation fails (binary missing, startup file never appears, etc.), surface the error verbatim and stop — do not try to recover. The human will re-run `redline install-skill`.

### Pass context with `--context`

```
__REDLINE_BIN__ /abs/path/file.md --context "Draft of the auth-rewrite RFC — focus on the migration plan in §4."
```

The context string is shown in the reader's header so the human knows what they're being asked to review and what you'd like them to focus on. Use it whenever the file alone doesn't make the ask obvious. One sentence is plenty.

### Surfacing the URL

The `--open` flag launches the review in the user's real browser via the OS opener (`open` on macOS, `xdg-open` on Linux, `start` on Windows). After the first shell call returns with `REDLINE_URL: http://localhost:NNNN`, tell the human the browser opened and include the URL only as a fallback. Do **not** make the URL the primary action; in some agent UIs, clicking localhost opens an embedded preview panel instead of the user's browser.

> "I opened this in Redline in your browser. Fallback URL: http://localhost:NNNN. I'll continue once you click Done."

## How to interpret the result

When the polling loop's shell call returns, the `cat "$RESULT"` at the end of it has printed the result JSON to stdout.

```json
{ "status": "approved", "file": "/abs/path/to/file.md", "rounds": 2, "comments": 5 }
```

Statuses:

- **`approved`** — Human signed off. Re-read the file from disk and continue. Note: the file may be byte-identical to what you handed off — if every comment was Q&A the agent answered with `accept-as-is`, no revision pass ran. That's still a valid approval, not a no-op.
- **`abandoned`** — Human closed the tab or Ctrl+C'd without clicking Done. The doc is in whatever state it was last revised to, but has not been signed off. Ask the human what they want to do.
- **`error`** — A revision pass failed. The result file includes a `reason` field with the failure message; `.review/errors.log` next to the file has more detail. Surface both to the human.

## Outer-agent handoff pattern

The full loop, when you are the outer agent producing the doc:

1. Write the markdown file to disk at an absolute path.
2. Tell the human in one sentence what's about to happen.
3. First shell call: launch `__REDLINE_BIN__ <abs-path> --context "<one-liner>" --open` in the background and poll for `.startup.json`. Returns in ~1s with the URL.
4. Tell the human Redline opened in their browser and include the URL only as a fallback.
5. Second shell call: monitor the review until either the process exits or Redline reports an author-needed comment. Use `__REDLINE_BIN__ author-needed "$FILE" --json` in the loop; if it reports any `author_needed` items, return that JSON so you can answer them with `__REDLINE_BIN__ author-reply "$FILE" <comment-id> --message "..."`, then resume waiting. Do not start unrelated work while the session runs.
6. On `approved`: re-read the file from disk (it may have been revised) and continue with whatever required sign-off.
7. On `abandoned` or `error`: stop and ask the human how to proceed; do not retry automatically.

You usually do not need to reply to comments — Redline spawns its own inline agent subprocess for that. The exception is an author-needed handoff: if `author-needed --json` returns items, you are the authoring agent and should answer only when you have the project context, tools, or authority the inline agent lacked. You do not need to invoke `redline resolve` separately — revisions happen inside the session when the human accepts.

## When *not* to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
