---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments. You remain the authoring agent, reply with your existing task context, and revise a Redline-managed staging file when the human accepts a round. The human signs off, and the document on disk is left in its final approved state.

## How to invoke it

The redline launcher lives at `__REDLINE_BIN__` (substituted at install time — if you see the literal placeholder string, the skill was installed incorrectly; tell the human to re-run `redline install-skill`). Always invoke it by this absolute path. Do not call bare `redline` and do not try to "fix" PATH issues by running `bun link` or guessing where the repo lives.

**Always detach the launcher with Node and poll.** Never run `__REDLINE_BIN__` as a foreground/blocking shell call: agent shell tools often buffer stdout until the process exits, so you would never see the URL the human needs to click and your "I'll wait while you review" message would be a lie. Also do not use `nohup` or a plain trailing `&`: in Codex-style short shell calls, the runner can clean up the shell's process group and take the Redline server with it. Use this pattern:

```bash
FILE=/abs/path/to/file.md
DIR=$(dirname "$FILE"); BASE=$(basename "$FILE")
STARTUP="$DIR/.review/$BASE.startup.json"
RESULT="$DIR/.review/$BASE.result"
LOG=/tmp/redline-$BASE.log

# Kick off the review in a detached process group and open it in the user's real browser.
node - "__REDLINE_BIN__" "$FILE" "$LOG" <<'JS'
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [launcher, file, logPath] = process.argv.slice(2);
const out = fs.openSync(logPath, "a");
const child = spawn(launcher, [file, "--responder", "caller", "--open"], {
  detached: true,
  stdio: ["ignore", out, out],
  env: process.env,
});
child.unref();
console.log(child.pid);
JS

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
# — see the next section), then wait until the reviewer sends you a turn or the
# review exits. Reply to caller turns with author-reply, then run author-wait again.
__REDLINE_BIN__ author-wait "$FILE"
```

The startup file at `.review/<basename>.startup.json` is written synchronously when the server begins listening; it contains `url`, `port`, `file`, `result_file`, `started_at`, `pid`. The result file at `.review/<basename>.result` is written when the session ends (approved, abandoned, or error).

In practice, run the script above as **two separate shell calls** so you can tell the human the URL between steps:

1. First call: everything through `echo "REDLINE_PID: $PID"`. Returns in ~1s with the URL and PID on stdout.
2. Tell the human Redline opened in their browser, and include the URL only as a fallback (see "Surfacing the URL" below).
3. Second call: `__REDLINE_BIN__ author-wait "$FILE"`. It returns `{ "kind": "caller-turn", ... }`, `{ "kind": "revision-request", ... }`, `{ "kind": "result", ... }`, or `{ "kind": "session-ended", ... }`. Long timeout (`timeout: 1800000` = 30 min, or longer). Handle caller turns and revision requests as described below, then run `author-wait` again. If it returns session-ended, inspect `$LOG` and relaunch only after explaining the failed session to the human.

`author-wait` is also the caller's liveness signal. Keep the wait loop active for the whole review. If you cannot continue serving the review, tell the human instead of silently switching it to another responder. Recovery is an explicit user choice through `redline responder "$FILE" --mode local` or `--mode manual`.

### Reply to reviewer turns

`caller-turn` contains `caller_turns`, with the comment id, selected quote, surrounding context, latest reviewer request, and full thread. `author-wait` posts the thinking indicator before returning the turn. Answer from the context of the task in which you authored the document, using repository tools when the review question requires them.

Post each reply with a verdict:

```bash
__REDLINE_BIN__ author-reply "$FILE" <comment-id> \
  --message "<concise reply>" \
  --requires-revision <true|false> \
  --revision-reason "<short edit description when true>"
```

Set `--requires-revision true` when fully addressing the comment implies a document edit. Set it to `false` when the thread itself answers the comment. Omit `--revision-reason` when no edit is needed. After replying to every returned turn, run `author-wait` again. Do not leave the review loop to start unrelated work.

### Apply an accepted revision

`revision-request` contains the accepted round, its settled comment threads, and `revision_file`, an absolute path to a Redline-managed staging copy. Read the current document and the settled threads, then edit only `revision_file` to apply what was agreed. Preserve the complete Markdown document and untouched sections. Do not edit the live document path directly.

When the staging file is ready, hand it back to Redline:

```bash
__REDLINE_BIN__ author-revise "$FILE" --round <round-number>
```

Redline verifies that the live source hasn't changed, validates the staged document, snapshots the live file, commits the revision, opens the next round, and reloads the browser. If the command fails, surface the error and return to `author-wait`; do not copy the staging file over the live document or bypass validation.

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
{
  "status": "approved",
  "file": "/abs/path/to/file.md",
  "rounds": 2,
  "comments": 5
}
```

Statuses:

- **`approved`** — Human signed off. Re-read the file from disk and continue. Note: the file may be byte-identical to what you handed off — if every comment was Q&A the agent answered with `accept-as-is`, no revision pass ran. That's still a valid approval, not a no-op.
- **`abandoned`** — Human closed the tab or Ctrl+C'd without clicking Done. The doc is in whatever state it was last revised to, but has not been signed off. Ask the human what they want to do.
- **`error`** — A revision pass failed. The result file includes a `reason` field with the failure message; `.review/errors.log` next to the file has more detail. Surface both to the human.

## Outer-agent handoff pattern

The full loop, when you are the outer agent producing the doc:

1. Write the markdown file to disk at an absolute path.
2. Tell the human in one sentence what's about to happen.
3. First shell call: launch `__REDLINE_BIN__ <abs-path> --responder caller --context "<one-liner>" --open` in the background and poll for `.startup.json`. Returns in ~1s with the URL.
4. Tell the human Redline opened in their browser and include the URL only as a fallback.
5. Second shell call: run `__REDLINE_BIN__ author-wait "$FILE"`. Answer every `caller-turn` with `author-reply`, including the revision verdict. Apply every `revision-request` through its staging file and `author-revise`. Then run `author-wait` again. If it returns `kind: "session-ended"`, inspect the log path from step 1 and tell the human the session died instead of silently relaunching. Do not start unrelated work while the session runs.
6. On `approved`: re-read the file from disk (it may have been revised) and continue with whatever required sign-off.
7. On `abandoned` or `error`: stop and ask the human how to proceed; do not retry automatically.

You reply to comments and apply accepted revisions because you are the agent that authored and launched the review. Use `author-revise` for the staged handback; do not invoke `redline resolve` separately.

## When _not_ to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
