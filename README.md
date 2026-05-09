# Redline

**A local review UI for AI-generated Markdown docs.**

Open a Markdown file, highlight text, leave inline comments, discuss changes with Claude, and apply accepted revisions back to the document.

![Redline demo — highlight text, leave a comment, Claude replies, resolve to apply the edit.](docs/assets/demo.gif)

## Try it in 30 seconds

```sh
bunx @alevi/redline ./spec.md
```

(or `npx @alevi/redline ./spec.md` — Bun is required either way.)

The terminal prints a `localhost` URL. Cmd-click it. Select any text in the document, type a comment, hit reply. Claude responds in the thread within ~2s. Resolve each comment, then click **Revise document** to have Claude apply the agreed edits back to the file on disk.

Requires [Bun](https://bun.sh) ≥ 1.0 and an authenticated [Claude Code](https://claude.com/claude-code) session. The agent inherits your existing Claude Code OAuth — no `ANTHROPIC_API_KEY` needed.

## Why Redline exists

AI agents are getting good at writing Markdown — PRDs, RFCs, READMEs, architecture specs, launch plans. Reviewing those docs still feels awkward: chat threads scroll out from under the text, "fix paragraph 3" loses its anchor after the first edit, and Google Docs-style tools don't speak the file on disk.

Redline puts a Google-Docs-style inline-comment layer on top of a local Markdown file, with a Claude agent participating in the review thread. Comments are anchored to the text they're about, the conversation is real-time, and accepted changes are applied back to the file you started with — no copy-paste.

## Who it's for

People shipping docs with the help of AI agents:

- Engineers reviewing **AI-generated PRDs and architecture specs** before they go to a team.
- PMs and tech leads reviewing **Claude Code / Codex / Cursor output** before merging.
- Tech writers running a **human-in-the-loop AI doc review** on README drafts.
- Anyone who wants **inline comments on Markdown** without uploading the file to a SaaS.

## How it works

Two long-lived processes:

- **Server** ([src/server.ts](src/server.ts)) — renders Markdown, serves the review UI, accepts comment / reply / resolve POSTs, broadcasts SSE events.
- **Agent** ([src/agent.ts](src/agent.ts)) — child process listening to the SSE stream. Calls `claude -p` to compose replies and post them back. When you accept a round, the agent runs the document revision pass and writes the result to disk.

Review state lives in a sidecar JSON file at `.review/<filename>.json` next to the doc. History snapshots of every revision land in `.review/history/`. Both should be gitignored unless you want them in the repo.

[CLAUDE.md](CLAUDE.md) has the full architecture tour: sidecar schema, SSE event vocabulary, model picking, frontend gotchas.

## Use cases

- **Reviewing AI-generated PRDs.** Hand Claude Code a one-line brief, let it draft the PRD, then redline it line by line before passing it on.
- **Reviewing architecture specs.** Mark assumptions you want challenged, ask the agent to expand sections, ship the revised spec.
- **Reviewing README drafts.** Claude wrote your README — read through, leave inline comments where the framing is off, accept the revision in one click.
- **Approving Claude Code output before merge.** Use the bundled [redline-review skill](skills/redline-review/SKILL.md) so your outer agent automatically hands you the doc to sign off on.
- **Human approval loops for agent-written docs.** Anywhere an agent needs your sign-off on prose before continuing, run it through Redline.

## One-shot revision

If you already have a sidecar with resolved comments and just want to apply the revision without the live UI:

```sh
bunx @alevi/redline resolve ./spec.md
bunx @alevi/redline resolve ./spec.md --model claude-sonnet-4-6
```

## Outer-agent handoff (optional)

Want your AI coding agent (Claude Code etc.) to invoke Redline automatically whenever it produces a Markdown doc you need to sign off on? Install the bundled skill:

```sh
git clone https://github.com/alevi/redline.git && cd redline
./scripts/install-skill.sh
```

This copies `skills/redline-review/` into `~/.claude/skills/` with absolute paths baked in. After installation, your outer agent will reach for `redline-review` whenever it has Markdown that needs human review before it can continue.

## Local-first / security

- Single-player. Server binds to `127.0.0.1`. No auth, no audit log, no cloud.
- Rendered Markdown is sanitized at the render boundary; raw HTML, inline event handlers, and `javascript:` URLs are stripped before the document reaches the browser.
- The agent inherits your existing Claude Code OAuth session; no `ANTHROPIC_API_KEY` required.
- **Prompt injection in document content is not defended against.** Run Redline on docs you trust.

Full threat model: [SECURITY.md](SECURITY.md).

## Known limitations

- Markdown only. PDFs, Word docs, raw HTML — out of scope.
- Single-player. No multi-reviewer mode, no auth, no comment-permalink sharing.
- Single file per session. No folder mode or repo-wide review.
- Concurrent `redline` processes on the same `.md` can corrupt the sidecar.
- Bun required at runtime — there's no plain-Node mode.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Headlines:

- Multi-doc / folder review.
- Sharper diff view with per-paragraph applied-edit indicators.
- Optional comment templates (`expand`, `challenge`, `cut`) layered on top of free-text.
- Optional read-only share link so a teammate can spectate a review.

## Develop locally

```sh
git clone https://github.com/alevi/redline.git
cd redline
bun install
bun link            # exposes `redline` on PATH
redline ./sample.md
bun test
```

## License

[MIT](LICENSE).
