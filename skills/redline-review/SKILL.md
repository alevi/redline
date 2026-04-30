---
name: redline-review
description: Hand a markdown file you produced (spec, RFC, brief, plan) to the human for inline review, wait for them to finish, then continue with the approved document. Use whenever the human's sign-off on a document is the next step in the work.
---

# Handing off a markdown doc for human review

When you've produced a markdown document that the human needs to read, comment on, and approve before you continue, use Redline. It opens a browser-based reader where the human leaves inline comments, you (a separate agent subprocess Redline spawns) reply to them, the human signs off, and the document on disk is left in its final approved state.

## How to invoke it

Run `redline <path-to-file.md>` via the Bash tool with a long timeout (10 minutes is the Bash tool max — that's the cap on how long the human has). **This call blocks** — it does not return until the human clicks Done in the browser (or abandons the session). That blocking behavior is the point: it's how you wait for the review.

If `redline` is not on PATH, the fallback is `bun /Users/alonlevi/Projects/redline/src/cli.ts <path-to-file.md>` (or wherever the redline repo is checked out).

Tell the human what you're doing in one short sentence before running it, e.g. "Opening this in Redline for review — I'll continue once you click Done." Redline prints the URL on startup. Surface that URL to the human in your text output too, so they can re-open the tab if they accidentally close it.

## How to interpret the result

When the Bash call returns, look at the exit code and the last `REDLINE_RESULT:` line in stdout:

- **Exit 0 + `REDLINE_RESULT: approved file=... rounds=N comments=N`** — Approved. Re-read the file from disk; it may have been revised through the review rounds. Continue with the work that needed the approval.
- **Exit 2 + `REDLINE_RESULT: abandoned`** — Human gave up (Ctrl+C or killed the process). The doc is in whatever state it was last revised to, but it has not been signed off. Do not proceed as if it were approved. Ask the human what they want to do.
- **Exit 1 or other** — Redline crashed. Check `.review/errors.log` next to the file. Surface the error to the human.

The result line is stable contract — you can grep for `^REDLINE_RESULT:` in the captured stdout.

## What you do not need to do

- You do not need to wait, poll, or check the sidecar yourself. The Bash call blocks for you.
- You do not need to reply to comments. Redline spawns its own agent subprocess that handles inline replies during the review.
- You do not need to invoke `redline resolve` separately. Revisions happen inside the session when the human accepts.

## When *not* to use this

- The doc doesn't need human sign-off — just commit it.
- The human is not at the keyboard (e.g. an autonomous run). Redline requires a live browser session.
- The doc is something other than markdown.
