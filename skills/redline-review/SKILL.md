---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments, an agent subprocess Redline spawns replies to them, the human signs off, and the document on disk is left in its final approved state.

## How to invoke it

The redline binary lives at `__REDLINE_BIN__` (substituted at install time — if you see the literal placeholder string, the skill was installed incorrectly; tell the human to re-run `scripts/install-skill.sh` from the redline repo). Always invoke it by this absolute path. Do not call bare `redline` and do not try to "fix" PATH issues by running `bun link` or guessing where the repo lives.

**Always background the launcher and poll.** Never run `__REDLINE_BIN__` as a foreground/blocking Bash call: the Bash tool buffers stdout until the process exits, so you would never see the URL the human needs to click and your "I'll wait while you review" message would be a lie. Use this pattern:

```bash
FILE=/abs/path/to/file.md
DIR=$(dirname "$FILE"); BASE=$(basename "$FILE")
STARTUP="$DIR/.review/$BASE.startup.json"
RESULT="$DIR/.review/$BASE.result"
LOG=/tmp/redline-$BASE.log

# Kick off the review in the background.
__REDLINE_BIN__ "$FILE" > "$LOG" 2>&1 &

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

# Step 2: surface the URL to the human (you do this after the Bash call returns
# — see the next section), then wait for the redline process to exit. Watching
# the PID (essentially free) instead of polling for the result file means you
# wake up within ~0.5s of the human clicking Done, not up to 30s later.
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
cat "$RESULT"
```

The startup file at `.review/<basename>.startup.json` is written synchronously when the server begins listening; it contains `url`, `port`, `file`, `result_file`, `started_at`, `pid`. The result file at `.review/<basename>.result` is written when the session ends (approved, abandoned, or error).

In practice, run the script above as **two separate Bash calls** so you can tell the human the URL between steps:
1. First call: everything through `echo "REDLINE_PID: $PID"`. Returns in ~1s with the URL and PID on stdout.
2. Surface the URL to the human in your reply text (see "Surfacing the URL" below).
3. Second call: just the `while kill -0` loop waiting for the PID, then `cat "$RESULT"`. Long timeout (`timeout: 1800000` = 30 min, or longer).

If invocation fails (binary missing, startup file never appears, etc.), surface the error verbatim and stop — do not try to recover. The human will re-run the install script.

### Pass context with `--context`

```
__REDLINE_BIN__ /abs/path/file.md --context "Draft of the auth-rewrite RFC — focus on the migration plan in §4."
```

The context string is shown in the reader's header so the human knows what they're being asked to review and what you'd like them to focus on. Use it whenever the file alone doesn't make the ask obvious. One sentence is plenty.

### Surfacing the URL

After the first Bash call returns with `REDLINE_URL: http://localhost:NNNN`, surface that URL in your reply text. The human has no other signal that something is waiting for them. One short sentence:

> "Opening this in Redline for review at http://localhost:NNNN — cmd-click to open. I'll continue once you click Done."

(There is an `--open` flag that auto-launches the browser, but prefer leaving it off — the human may not be at the keyboard the moment the session starts, and a stolen-focus browser tab is worse than a URL they click when ready.)

## How to interpret the result

When the polling loop's Bash call returns, the `cat "$RESULT"` at the end of it has printed the result JSON to stdout.

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
3. First Bash call: launch `__REDLINE_BIN__ <abs-path> --context "<one-liner>"` in the background and poll for `.startup.json`. Returns in ~1s with the URL.
4. Surface the URL to the human in your reply text so they can cmd-click to open.
5. Second Bash call: wait on the redline PID (`while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done`) then `cat "$RESULT"`, with a long timeout (30+ min). While the session runs, you are idle — do not start unrelated work, do not run other tools.
6. On `approved`: re-read the file from disk (it may have been revised) and continue with whatever required sign-off.
7. On `abandoned` or `error`: stop and ask the human how to proceed; do not retry automatically.

You do not need to reply to comments — Redline spawns its own agent subprocess for that. You do not need to invoke `redline resolve` separately — revisions happen inside the session when the human accepts.

## When *not* to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
