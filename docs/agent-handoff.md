# Agent Handoff — Design Spec

This document describes how Redline hands off a reviewed document to an AI agent. The handoff is a two-phase process: first the agent and reviewer discuss each comment in the sidecar until the reviewer is satisfied, then the agent produces a revised document.

## The problem

After you leave comments in Redline, nothing happens automatically. You have a sidecar file full of feedback and a Markdown file that hasn't changed yet. Bridging that gap is the agent handoff.

## Two-phase flow

**Phase 1 — Discussion.** The reviewer leaves comments in Redline and submits them. The agent reads the sidecar, replies to each comment, and posts those replies back. The reviewer reads the replies, pushes back or asks follow-up questions, and the conversation continues until everything is settled. Neither the reviewer nor the agent touches the document yet.

**Phase 2 — Revision.** When the reviewer clicks "Accept & revise," the round is closed. The agent then runs `redline resolve` to produce a revised document incorporating everything that was agreed on. The revised file overwrites the original (with the previous version saved to history), and a new round opens for the next pass.

## CLI shape

```
redline <file>           # opens the review reader at localhost:3000
redline resolve <file>   # agent handoff: reads accepted sidecar, rewrites document
```

`redline resolve` is called by the agent after the human has accepted the round. It reads the original file and its sidecar, constructs a prompt from the settled comments, calls the model, and writes the revised Markdown back to disk. Output is streamed to the terminal as the model responds — useful for debugging and for showing progress during long revisions.

Before overwriting, the current file is copied to `.review/history/<filename>.<iso-timestamp>.md`. The working file is always current; history is always there if you need to look back. No UI surfaces it for now.

## What the agent receives

The prompt contains three things:

1. **The original document** — verbatim, no modifications
2. **The settled comments** — each comment thread where `resolved: true`, structured as a numbered list with the quoted text and the full discussion
3. **Instructions** — a brief system prompt telling the agent to address every comment in place, preserve sections with no comments, and return only the revised Markdown

Example prompt fragment:

```
You are revising a Markdown document based on settled reviewer comments.
For each comment below, edit the relevant passage to reflect what was agreed.
Do not add commentary. Return only the revised document.

---

## Document

[full document text]

---

## Settled comments

1. Quote: "The agent will always produce a valid Markdown file"
   Discussion: Reviewer flagged this as an assumption. Agreed to reframe as a goal, not a guarantee.

2. Quote: "A single round of review is enough"
   Discussion: Reviewer asked to remove — contradicts the multi-round architecture. Agreed.
```

## What the agent returns

Plain Markdown. No wrapper, no preamble, no explanation. The command strips any accidental code fence around the output and writes the result to disk. After writing, a change summary is printed to the terminal:

```
✓ Revised: agent-handoff.md
  ~ Modified: "Proposed CLI shape" section
  + Added: "Two-phase flow" section
  − Removed: "Open questions" section
  Saved previous version to .review/history/agent-handoff.md.2026-04-29T20:00:00Z.md
```

New sections added by the agent beyond what was explicitly requested are flagged with `+` so the reviewer is aware and can push back in the next round.

## Round management

`redline resolve` reads the sidecar for the most recent round where `resolved_at` is set. It closes that round and opens a new empty one. The reviewer can open Redline again, read the revised document, and leave a fresh pass of comments.

Rounds accumulate in the sidecar — a full audit trail of what was said, when, and what was agreed at each stage.

## Failure modes

**Agent returns garbage.** The command checks that the output is non-empty and starts with a Markdown heading. If not, it aborts and leaves the original file untouched.

**Comment can't be located.** Some comments may refer to text the agent changed in an earlier pass. These are silently skipped — the agent handles them gracefully given the full document context.

**Network or API error.** The command exits with a non-zero code and prints the error. Nothing is written to disk.

## Options

`--model <id>` — optional. Specifies which model to call. Defaults to the best available Claude model. Since `redline resolve` is typically called by an agent rather than a human typing interactively, verbosity is not a concern.
