# Redline

Inline comments for Markdown files, designed for human-in-the-loop AI doc review.

You point Redline at a `.md` file. It opens a local browser reader. You select text and leave inline comments. An always-on agent process responds to each comment in real time. When you're done discussing a comment, you resolve it; when all comments in a round are resolved, you click "Revise document" and the agent rewrites the doc to reflect what was agreed. Repeat for as many rounds as you need.

It's single-player, local, and ephemeral. The state of a review lives in a sidecar JSON file at `.review/<filename>.json` next to the doc — gitignore the whole `.review/` directory if you don't want it tracked.

## Install

Requires [Bun](https://bun.sh) and an authenticated Claude Code session (the agent shells out to `claude -p` and inherits its OAuth token — no `ANTHROPIC_API_KEY` needed).

```sh
bun install
```

### Install the Claude skill (optional)

To make the `redline-review` skill available to Claude Code in any project (not just this repo), run:

```sh
./scripts/install-skill.sh
```

This copies `skills/redline-review/` into `~/.claude/skills/`. Re-run after pulling skill changes — it's a copy, not a symlink, so updates aren't automatic.

## Use

```sh
bun start path/to/spec.md
```

This starts a local server and a dedicated agent process that listens for comment events. The terminal prints a `localhost` URL — cmd-click it when you're ready to review. (Pass `--open` if you want the browser to launch automatically.) Select any text in the document to leave a comment. The agent will reply in the thread within a couple seconds.

When you're done with a comment, click **Resolve**. When every comment in the round is resolved, the **Revise document** button enables. Click it and the agent will rewrite the doc to reflect the discussion.

When the document looks good and you have no more comments, click **Done**. The browser shows a "review complete" page, the server prints a summary, and the process exits.

### One-shot revision

If you have an existing sidecar with resolved comments and just want to apply the revision without the live UI:

```sh
bun src/cli.ts resolve path/to/spec.md
bun src/cli.ts resolve path/to/spec.md --model claude-sonnet-4-6
```

## How it works

- **Server** (`src/server.ts`) — Hono web server. Renders the doc, serves the JS-driven review UI, accepts comment/reply/resolve POSTs, broadcasts SSE events.
- **Agent** (`src/agent.ts`) — long-lived subprocess. Listens to the SSE stream, calls `claude -p` to compose replies, posts them back to the server. Runs the document revision when the human accepts a round.
- **Sidecar** (`src/sidecar.ts`) — JSON file with `rounds[]`, each containing `comments[]` with a `thread[]` of human/agent messages.

The model is picked per message: short or simple → Haiku; long, question, or involves rewriting → Sonnet.

See [CLAUDE.md](CLAUDE.md) for architecture details, frontend gotchas, and SSE event vocabulary.

## Test

```sh
bun test
```

## Status

This is a personal tool. It works well enough for the workflow it was built for. Expect rough edges if you stretch it.
