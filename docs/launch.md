# Redline launch & discoverability plan

This is the working doc behind the public-launch polish pass. It captures the prioritized action plan, the GitHub repo metadata, the launch-post drafts, the landing-page outline, and a list of follow-on issues / PR-sized tasks worth filing.

> Internal launch artefact. Keep it in the repo so the rationale is reviewable, but the audience is the maintainer, not first-time visitors.

---

## 1. Prioritized action plan

Order is by **shippability × discoverability impact**. Top items can ship today; later items unblock when the earlier ones land.

### P0 — ship before any external posting

1. **Reposition the README** around the core pain (reviewing AI-generated Markdown). Demo GIF above the fold, one-command `bunx`/`npx` install, use cases section. *(this PR)*
2. **Publish to npm as `@alevi/redline`** with a scoped package and a Node launcher so both `npx` and `bunx` work. Once published, the README's quickstart becomes literal-true. *(this PR — packaging changes; publish is a separate manual step.)*
3. **Cut a v0.1.0 GitHub Release** off `main` after merging this PR. Use the `[0.1.0]` block from `CHANGELOG.md` as the release notes. Tag: `v0.1.0`.
4. **Set the GitHub repo description and topics** (see "GitHub repo metadata" below). One-time setting, biggest discoverability lever per minute spent.
5. **Refresh the demo GIF** to show the magic moment end-to-end — open file → highlight → comment → Claude reply → resolve → applied edit. Replace `docs/assets/demo.gif`. ~15s, ≤ 6MB. *(out of this PR — needs a screen recording.)*

### P1 — within a week of P0

6. **Stand up a one-page landing site** at `redline.levi.studio` (preferred) or `levi.studio/redline`. Outline below. Static HTML, embed the GIF, link to GitHub.
7. **Write a launch blog post or thread** (drafts below). Target: HN front-page-quality narrative (not a feature dump).
8. **Submit to one or two awesome-lists** (`awesome-claude`, `awesome-ai-agents`, `awesome-markdown`).
9. **Add issue templates** (bug, feature request, use-case story) so the first wave of inbound issues looks structured.
10. **Wire up a `publish` GitHub Action** that runs `bun publish` on tag push. Optional, but it removes one excuse not to cut releases.

### P2 — once there's traffic

11. **Add a "Used by" / testimonials section** to the README once you have one or two unsolicited mentions. Don't fake it; wait for real ones.
12. **VS Code / Cursor extension** that opens the review for the active Markdown file in a side panel. Big lift but a strong distribution surface.
13. **Comment templates** (`expand`, `challenge`, `cut`) — see ROADMAP.md.

---

## 2. GitHub repo metadata

### Description (single line, ≤ 350 chars — GitHub limit is 350)

> A local review UI for AI-generated Markdown docs. Highlight text, leave inline comments, discuss with Claude, apply accepted revisions back to the file. Local-first, single-player, runs on your laptop.

### Topics

Pick from these — GitHub allows up to 20. Recommended top set, ordered by discoverability:

```
claude-code
ai-agents
markdown-review
document-review
inline-comments
human-in-the-loop
ai-docs
spec-review
docs-as-code
local-first
developer-tools
technical-writing
markdown
documentation
ai
bun
claude
```

The same list is mirrored in `package.json#keywords` so npm search picks them up too.

### Repo settings worth flipping

- **About → website**: set to the landing page URL once it exists.
- **Discussions**: enable. Cheaper than issues for "is this a fit for X?" questions.
- **Sponsors**: optional; no rush.

---

## 3. Install / packaging changes (in this PR)

### What changed

- Renamed package to `@alevi/redline` with `publishConfig.access: public`.
- Added `bin/redline.cjs` — a Node launcher that locates Bun and re-execs `bun run src/cli.ts`. Without this, `npx @alevi/redline` would fail at the `#!/usr/bin/env bun` shebang on machines that have Node but not Bun.
- Added `repository`, `bugs`, `homepage`, `author`, `description`, `keywords`, `engines.bun`, and a `files` whitelist so `npm pack` ships a tight tarball.

### One-time publish steps (manual, after merge)

```sh
# 1. Make sure you're logged in.
npm whoami || npm login

# 2. Sanity-check what would ship.
npm pack --dry-run

# 3. Cut the version commit + tag.
git tag v0.1.0 -m "v0.1.0 — initial public release"
git push --tags

# 4. Publish under the @alevi scope, public.
npm publish --access public
```

### After publishing

```sh
bunx @alevi/redline ./sample.md   # should boot the reader
npx @alevi/redline ./sample.md    # should also boot the reader (via the Node launcher)
```

### Why scoped

- The unscoped `redline` name on npm is taken.
- `@alevi/redline` matches the GitHub org and is visually consistent with the eventual `levi.studio` surface.
- `@levistudio/redline` is the obvious alternative if you'd rather hide the personal handle. Either works; pick one and don't double-publish.

---

## 4. Demo GIF — what to capture

The current `docs/assets/demo.gif` is a placeholder. The replacement should land the magic moment in the first 5 seconds.

**Storyboard (≤ 15 seconds total):**

1. Terminal: `bunx @alevi/redline ./prd-draft.md` → URL prints. *(2s)*
2. Browser opens. Document is visible. Cursor highlights a sentence. *(2s)*
3. Comment box opens; type "this paragraph buries the lede — lead with the user pain". *(3s)*
4. Three dots appear (agent thinking). Claude replies with a proposed rewrite + verdict badge. *(3s)*
5. Click **Resolve → queue edit**. Click **Revise document**. *(2s)*
6. Page reloads to the revised paragraph, with the edit visibly applied. *(3s)*

**Recording tips:**

- 900–1200 px wide, 24 fps, ≤ 6 MB so it inlines on GitHub without lazy-load.
- Use a real PRD-shaped document, not Lorem Ipsum. The viewer should be able to read what's happening.
- No music, no narration; this loops in a README.

**Where it goes:** at the very top of the README, immediately under the tagline. Keep the current location and replace the file in place so the existing reference doesn't break.

---

## 5. Landing page — `redline.levi.studio`

Single static HTML page. No build step needed; one file, one CSS block, one inline embed.

### Sections (top to bottom)

1. **Hero** — name, tagline, primary CTA (`bunx @alevi/redline <file>`), secondary CTA (GitHub).
2. **30-second demo** — embed the same GIF as the README, with a one-sentence caption: "Highlight text → comment → Claude replies → resolve → edit applied."
3. **What it is** — three bullets, each one sentence:
    - Inline comments on Markdown files, anchored to text.
    - A Claude agent participates in the thread.
    - Accepted edits land back on disk.
4. **Install / try it** — single fenced code block with `bunx`. Note the Bun + Claude Code requirement on a separate line.
5. **Claude Code workflow** — short paragraph + screenshot of the bundled `redline-review` skill in action. Link to the skill source.
6. **Local-first / privacy** — the existing security one-liner: "Server binds to 127.0.0.1. No telemetry. No cloud. Your file, your machine."
7. **GitHub** — repo link, badge row (npm version, license, CI status), "star if useful" CTA.
8. **Footer** — author, MIT license, link to `levi.studio`.

### Copy

Hero tagline (matches README):

> A local review UI for AI-generated Markdown docs.

Hero subtitle:

> Open a Markdown file, highlight text, leave inline comments, discuss changes with Claude, and apply accepted revisions back to the document.

Primary CTA button: `bunx @alevi/redline ./spec.md` (rendered as a copy-to-clipboard code block).

### URL choice

- **`redline.levi.studio`** (preferred) — short, brand-consistent, easy to remember when someone hears it on a podcast.
- `levi.studio/redline` — fine fallback; one less DNS record. Consider it if you'd rather treat the studio site as the primary surface and Redline as a project page.

---

## 6. Launch posts — drafts

### Show HN

> **Show HN: Redline – inline review for AI-generated Markdown docs, with Claude in the thread**
>
> AI agents are getting good at writing docs — PRDs, RFCs, READMEs, architecture specs. Reviewing those docs still feels awkward: chat threads scroll out from under the text, "fix paragraph 3" loses its anchor after the first edit, and Google-Docs-style tools don't speak the file on disk.
>
> Redline is a local review UI for Markdown. You point it at a `.md`, it opens a browser-based reader, you highlight text and leave inline comments, and a Claude agent replies in the thread within ~2 seconds. Resolve the comments, click **Revise document**, and the agent applies the agreed edits back to the file on disk.
>
> A few design notes:
>
> - Single-player. The server binds to 127.0.0.1; no auth, no cloud. Designed for one human and one agent on the developer's laptop.
> - The agent shells out to the `claude -p` CLI rather than the SDK, so you only need an authenticated Claude Code session — no extra API key.
> - Review state lives in a sidecar JSON next to the doc (`.review/<file>.json`). Per-round history snapshots are kept, so you can re-open a review and see what changed.
> - Every agent reply carries a `requires_revision` verdict, so the round-level button auto-picks "Revise document" vs "Accept as-is" based on what was discussed.
>
> Try it: `bunx @alevi/redline ./spec.md`
>
> Repo: https://github.com/alevi/redline
>
> Curious whether the inline-comment-on-Markdown UX feels right; happy to take design feedback.

### r/ClaudeAI

> **I built a local Google-Docs-style review tool for the Markdown docs Claude writes**
>
> Claude Code is great at drafting PRDs / RFCs / architecture specs. Reviewing them in chat is the awkward part — you can't anchor "fix paragraph 3" to the actual paragraph 3, and once Claude rewrites it, the anchor is gone anyway.
>
> Redline runs locally, opens a browser tab on the Markdown file, lets you highlight any text and leave a comment, and a Claude subprocess replies in the comment thread. When you resolve everything, it rewrites the doc with the changes applied.
>
> Single command:
>
> ```
> bunx @alevi/redline ./your-doc.md
> ```
>
> No API key — it inherits your Claude Code OAuth. Local-first; the server only binds to 127.0.0.1.
>
> Repo + demo gif: https://github.com/alevi/redline
>
> Would love feedback from anyone running multi-step Claude Code workflows that include "have a human read this draft" as a step.

### X / Twitter (single post)

> AI agents are getting good at writing docs.
> Reviewing those docs is still awkward.
>
> Redline is a local review UI for AI-generated Markdown — highlight text, leave inline comments, discuss with Claude in the thread, apply accepted edits back to the file.
>
> `bunx @alevi/redline ./spec.md`
>
> github.com/alevi/redline

### LinkedIn

> Shipping Redline today — a small open-source tool I've been using daily for a couple of months.
>
> Context: most of my recent specs and PRDs start as a Claude draft. Reviewing those drafts in a chat window is awkward; comments scroll out from under the text and lose their anchor as soon as the doc changes.
>
> Redline gives Markdown files Google-Docs-style inline comments. You highlight a paragraph, leave a comment, Claude replies in the thread. When you're done, accepted changes are applied back to the file on disk.
>
> Local-first — server binds to 127.0.0.1, your file never leaves your machine. Single-player, single agent, opinionated about being one of those.
>
> If you've been writing docs with an AI agent and felt the same friction, I'd love your feedback: https://github.com/alevi/redline

### r/programming or r/devtools (post-polish only)

Don't post here until after HN and a small wave of GitHub stars. Reddit's `/r/programming` and `/r/devtools` are unforgiving about anything that smells like a half-finished tool — wait until v0.2.0 with at least one external testimonial, the landing page is up, and there are a couple of community PRs in `main`.

---

## 7. Suggested issues / PR-sized tasks

Open these as GitHub issues so contributors have something to grab. Each is sized to fit one PR.

### Discoverability

- **Add `.github/ISSUE_TEMPLATE/` directory** with `bug.md`, `feature-request.md`, and `use-case.md`. Pre-fill the use-case template with the questions from the README's "who it's for" section.
- **Add a CONTRIBUTING.md** covering: dev setup (already in README), test requirements, coding-style hints from CLAUDE.md, the "shell out to `claude -p` not the SDK" rule.
- **Add badges to the top of the README**: npm version, license, CI status, "made with Bun".

### Packaging

- **GitHub Action: publish on tag.** On `v*` tag push: run tests, run `npm publish --access public`. Use OIDC for auth so there's no `NPM_TOKEN` secret to leak.
- **Smoke-test the published tarball in CI.** After `npm pack`, install from the tarball into a clean tmpdir, run `bunx ./tarball.tgz ./fixture.md` and assert the server boots. Catches missing-file regressions in `package.json#files`.

### Onboarding

- **Add a `--help` flag to the CLI.** Today there's only the implicit usage line in error paths. A real `--help` builds trust.
- **Embed sample.md as a fallback first-run experience.** If the user runs `bunx @alevi/redline` with no arguments, offer to copy `sample.md` into the cwd and open it. One-command first-experience.
- **Browser-tab title currently shows the file basename — also append the round number** so a user with two tabs open knows which is which.

### Demo / docs

- **Replace `docs/assets/demo.gif`** following the storyboard in this doc.
- **Add `docs/screenshots/`** with 3–4 high-res stills (reader, comment thread mid-conversation, resolve banner with verdict, post-revision diff overlay) for the landing page and any external write-ups.
- **Use-cases doc**: split the README's "Use cases" bullets into a longer `docs/use-cases.md` with one paragraph + one screenshot each. This is the page that ranks for "AI-generated Markdown review" search queries.

### Reach

- **Submit to `awesome-claude` and `awesome-ai-agents`.** Single PR each, single line, link to the README.
- **Submit a short write-up to lobste.rs** (after HN). Different audience, different framing — lead with the architecture (Bun + Hono + SSE + subprocess agent) rather than the user pain.

---

## 8. Searchable phrasing — keep these terms in copy

For SEO and "I vaguely remember this tool" recall. Make sure the README, landing page, and at least one launch post each use these exact phrases somewhere:

- "AI-generated Markdown review"
- "inline comments for Markdown"
- "Claude Code document review"
- "human-in-the-loop AI doc review"
- "review AI-generated PRDs"
- "review architecture specs"
- "review README drafts"
- "local-first review tool"
- "Markdown review UI"

The current README uses six of these nine. The launch posts above cover the rest.
