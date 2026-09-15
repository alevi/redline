# Milestone: Caller-backed review agent

**Status:** Complete. Caller-backed discussion, staged revision, caller-loss detection, explicit responder takeover, and sidecar migration recovery are implemented.

## Summary

Make the agent that authored and launched a Redline review the default participant in that review. Preserve Redline's event-driven review loop and keep the existing local agent available for standalone sessions, but stop creating a second, context-poor agent when a capable authoring agent is already waiting for the result.

This milestone changes the identity on the other side of Redline's event boundary, not the browser review model itself.

## Why this milestone now

Redline began as a standalone local application. From its first implementation, `redline <file>` started a server and a dedicated agent process. That agent subscribed directly to comment events and called a locally authenticated model CLI for replies and revisions. The architecture delivered the intended experience: comments received prompt responses without a submit step or agent-harness scheduling delay.

The `redline-review` skill now defines a workflow that starts inside an existing agent task:

1. An agent authors a spec, RFC, brief, or plan with the full conversation and repository context.
2. The agent launches Redline and waits for human sign-off.
3. Redline starts a different inline agent to discuss comments and revise the document.
4. The authoring agent resumes only when Redline requests an author reply or the session ends.

In that workflow, the agent with the authoring conversation and project context is already present but isn't the primary review participant.

## The problem

The inline agent receives the document, the comment thread, and an optional one-line review context. It doesn't automatically receive the authoring conversation, project decisions, repository findings, tool results, or the intent behind tradeoffs already made.

That context boundary creates several costs:

- The inline agent may reconstruct the document's intent differently from its author.
- Questions grounded in repository or project context require a handoff even when the authoring agent already knows the answer.
- Discussion and revision can be owned by different agents, increasing the chance that an agreement is implemented inconsistently.
- Redline maintains escalation classification, author-waiting, author replies, closeout transcripts, provider selection, model selection, subprocess recovery, and additional prompt contracts to coordinate the two agents.
- Every ordinary review reply starts a new provider invocation even though the calling task is already active and waiting.

The escalation verdict, `author-wait`, `author-reply`, and closeout transcript are useful safeguards. Together, they show a structural mismatch: feedback is handled first by an agent with less context and routed to the author only when that limitation becomes visible.

## What remains valid in the current architecture

This milestone doesn't treat the existing design as a mistake. Several decisions remain load-bearing:

- Redline should react to comments as events, without a separate submit-for-review step.
- The review server shouldn't contain model-specific orchestration.
- Thinking state, replies, revision progress, reloads, and errors should continue to appear in the browser in real time.
- Sidecar locking, history snapshots, revision validation, watchdogs, and recovery should remain Redline-owned guarantees.
- A directly launched Redline session must still work when there's no calling agent.
- Users must still be able to choose manual annotation with no agent at all.

The process boundary is useful. The default agent identity across that boundary is what needs to change.

## Product principle

When a capable agent launches a review of its own work, that agent should remain accountable for explaining and revising the work.

Redline should provide the review surface, durable state, lifecycle, and safety checks. It shouldn't silently substitute a new author unless the session was launched without one.

## Proposed direction

Introduce an explicit responder mode for each review session:

- **Caller-backed.** The launching agent receives human messages, replies in the existing threads, and handles revision requests. This becomes the default when Redline is launched through an agent integration such as the `redline-review` skill.
- **Local agent.** Redline starts its existing Claude or Codex responder and uses local CLI authentication. This remains the default for a standalone terminal launch where no caller is registered.
- **Manual.** Redline records annotations without starting or waiting for an agent. This preserves the current `--no-agent` behavior.

The first implementation should build on the existing author-handoff protocol rather than require a new host-specific integration.

### Discussion loop

Generalize `author-wait` so caller-backed sessions return every pending human turn, not only comments classified as author-needed. The launching agent answers through the existing authenticated local API, using an expanded `author-reply` command or a more general responder command.

```text
human posts comment or follow-up
  -> Redline persists it and signals pending caller work
  -> launching agent resumes with its original task context
  -> launching agent posts thinking state and reply
  -> Redline persists the reply and refreshes the browser
  -> launching agent waits again
```

Redline remains the source of truth. Pending work must be durable and deduplicated so a caller restart or repeated wait can't produce duplicate replies.

### Revision loop

Extend the same protocol to accepted rounds. A caller-backed revision request should include the settled comment threads and the current document state. The authoring agent performs the revision while Redline continues to own the transaction around it:

1. Snapshot the pre-revision document.
2. Mark a revision as in progress and start the watchdog.
3. Signal the caller with the settled review state.
4. Accept the revised Markdown or a confirmed on-disk edit from the caller.
5. Run the existing revision integrity checks.
6. Commit the result, open the next round, and reload the browser.
7. On failure or timeout, restore a meaningful retry state and surface the error.

The exact write contract is a design detail for implementation. It must not let an agent bypass Redline's history, validation, or lifecycle guarantees merely because that agent has filesystem tools.

### Standalone fallback

If no caller registers, Redline should use the current local provider path. Reviewer actions and feedback should work the same in every responder mode, apart from a quiet status label when that distinction helps explain availability or failure.

Caller loss must have an explicit recovery path. Depending on what can be detected reliably, Redline may offer to switch the session to the local agent or manual mode. It must not silently change agents in the middle of an unresolved discussion.

## Architectural shape

Treat the responder as a session-level transport behind a shared contract rather than as an assumption embedded in the CLI lifecycle.

The contract needs to cover:

- responder registration and capability detection
- comment and follow-up delivery
- thinking, reply, and verdict submission
- revision request, progress, completion, and failure
- deduplication and recovery after either process restarts
- session completion and closeout reporting.

The current local agent becomes one implementation of that contract. The calling-agent bridge becomes another. Manual mode is the absence of a responder.

Provider-specific model invocation should remain confined to the local-agent implementation. Caller-backed mode shouldn't make Redline choose a model on behalf of the calling task.

## Delivery approach

### Slice 1: Caller-backed discussion

- Add an explicit responder mode to startup and persisted session state.
- Let a caller register before or during launch.
- Return all pending human turns from the wait command in caller-backed mode.
- Let the caller post thinking state, replies, and verdict metadata.
- Update the review skill to alternate between waiting for and replying to ordinary comments.
- Keep local-agent and manual behavior unchanged.

This slice is independently useful: repository- and history-aware answers come from the authoring agent even if revisions still use the existing resolver temporarily.

### Slice 2: Caller-backed revision

- Signal accepted rounds to the caller.
- Define a safe revised-document handback contract.
- Reuse history snapshots, validation, retry state, watchdog behavior, and browser progress events.
- Ensure a caller failure can't leave the round permanently resolved or the browser permanently revising.

### Slice 3: Recovery and migration

- `author-wait` maintains a live caller lease. When the lease expires, the browser shows **Caller offline** without silently changing identity.
- `redline responder <file> --mode local|manual` performs an explicit takeover. Local takeover starts the selected provider and recovers unanswered durable turns; manual takeover reloads the review into annotation mode.
- Leaving caller mode unresolves an interrupted accepted round, clears its pending revision transaction, and removes only the exact Redline-managed staging file.
- A local responder scans the sidecar after connecting, so process restarts and caller-to-local takeover recover unanswered comments or an interrupted accepted round.
- Caller-backed waiting no longer consults escalation classification. Author-needed semantics remain available in local responder mode, and the full transcript remains in closeout output.
- Sidecars without `responder_mode` still load as local sessions. Relaunching a stale caller sidecar in another explicit mode performs the recovery transition before serving review state.

## Done when

This milestone is reached when:

- A review launched through the Redline skill uses the launching agent for ordinary comment replies and document revisions.
- The launching agent retains its original task context and can use its normal project tools while responding.
- The browser remains real-time: the reviewer sees thinking state, replies, progress, errors, and reloads without manually submitting a batch.
- Reply and revision work are durable and deduplicated across wait calls and recoverable process failures.
- Redline still owns sidecar integrity, history, revision validation, timeout recovery, and final approval state.
- A standalone CLI launch still supports the existing local Claude or Codex agent.
- Manual mode still works without a provider CLI.
- Losing the caller produces an explicit, understandable state rather than silence or an automatic identity change.
- Existing review sessions and sidecars remain readable or have a deliberate migration path.

## Non-goals

- Removing local provider support.
- Embedding model SDKs or API-key authentication in the server.
- Making Redline dependent on Codex, Claude Code, or one proprietary agent host.
- Redesigning the browser review UI beyond the status and recovery affordances required by responder modes.
- Supporting multiple simultaneous human reviewers or multiple active authoring agents.
- Letting the calling agent mutate review state outside Redline's transaction and validation boundaries.

## Risks and questions to resolve during implementation

- **Wake-up semantics.** Different agent hosts may not expose a stable way to resume the exact launching task. The wait-command implementation should prove the behavior before Redline adopts a deeper integration.
- **Latency.** Resuming the outer task may be slower than a direct provider CLI call. Measure comment-to-thinking and comment-to-reply latency against the current local agent rather than assuming equivalence.
- **Task context lifetime.** A long review may outlive the caller's usable context or host session. Recovery must be designed, not inferred.
- **Concurrent work.** The caller shouldn't continue unrelated implementation while also serving a review. The integration contract needs to keep waiting behavior explicit.
- **Revision handback.** Accepting arbitrary filesystem edits would weaken Redline's integrity guarantees. Prefer a bounded handback that Redline can validate and commit.
- **Verdict ownership.** Caller-backed replies still need `requires_revision` semantics so the browser can distinguish answered comments from queued edits.
- **Compatibility.** Responder mode belongs to a live session, but enough state may need persistence for restart recovery. Avoid baking ephemeral host identifiers into the long-lived sidecar without a clear need.

## Expected outcome

For agent-authored documents, review becomes a continuous conversation with the same agent that produced the work. The human no longer has to discover whether a question belongs to the inline agent or the authoring agent, and Redline no longer needs escalation as the normal route back to missing context.

For standalone use, Redline keeps its direct SSE-to-local-agent path. The product gains a clearer separation between its durable review machinery and the interchangeable responder that participates in a session.
