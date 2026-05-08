# Redline

Inline comments on Markdown files, designed for human-in-the-loop AI doc review.

![Redline demo](docs/assets/demo.gif)

## Quickstart

```sh
git clone https://github.com/alevi/redline.git
cd redline
bun install
bun link            # exposes `redline` on PATH
redline path/to/your/file.md
```

This starts a local server and a dedicated agent process. The terminal prints a `localhost` URL — cmd-click it when you're ready to review. Select any text in the document to leave a comment. The agent replies in the thread within a couple of seconds.

When you're done with a comment, click **Resolve**. When every comment in the round is resolved, the **Revise document** button enables — click it and the agent rewrites the doc to reflect the discussion. When the document looks good and there are no more comments to act on, click **Done**.

## What it is

A single-player, local Markdown review tool. The human reviews; the agent responds. The state of a review lives in a sidecar JSON file at `.review/<filename>.json` next to the doc — gitignore the `.review/` directory if you don't want it in the repo.

## What it is not

- Not a Markdown editor.
- Not a collaboration tool — single-player.
- Not a knowledge base or publishing platform.
- Not AI-first — the human reviews, the agent responds.

## How it works

Two long-lived processes work in tandem:

- **The server** ([src/server.ts](src/server.ts)) renders the document, serves a small JS-driven review UI, accepts `comment`/`reply`/`resolve` POSTs, and broadcasts SSE events for every state change.
- **The agent** ([src/agent.ts](src/agent.ts)) is a child process that listens to the SSE stream and calls `claude -p` to compose replies, posting them back to the server. When the human accepts a round, the agent runs the document revision.

The conversation is real-time — there is no submit/notify step. Every comment immediately gets an agent reply; you can push back in the thread, the agent re-replies, and so on. When you resolve a round, every comment carries an "implies a doc edit" verdict that the agent attached to its reply, so the round-level button defaults to **Revise document** if any comment implies an edit and **Accept as-is** if every comment was answered without one.

For a deeper tour — sidecar schema, frontend gotchas, SSE event vocabulary, model picking — see [CLAUDE.md](CLAUDE.md).

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- An authenticated [Claude Code](https://claude.com/claude-code) session

The agent shells out to the `claude -p` CLI and inherits its OAuth token, so no `ANTHROPIC_API_KEY` is needed. If `claude` isn't on your PATH when you run `redline`, the CLI exits with a one-line install pointer rather than failing later.

## One-shot revision

If you have an existing sidecar with resolved comments and just want to apply the revision without the live UI:

```sh
redline resolve path/to/spec.md
redline resolve path/to/spec.md --model claude-sonnet-4-6
```

## Outer-agent handoff (optional)

If you want your AI coding agents (Claude Code etc.) to invoke Redline automatically whenever they produce a Markdown doc that needs your sign-off, install the bundled skill:

```sh
./scripts/install-skill.sh
```

This copies `skills/redline-review/` into `~/.claude/skills/` and substitutes the absolute launcher path so the skill works from any project on your machine. Re-run after pulling skill changes — it's a copy, not a symlink. After installation, your agent will reach for `redline-review` whenever it has a markdown doc you need to review.

## Tests

```sh
bun test
```

## License

[MIT](LICENSE)
