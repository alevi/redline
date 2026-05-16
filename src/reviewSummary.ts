// Closeout summary of a finished review.
//
// The inline review agent (src/agent.ts) and the agent that *authored/launched* redline
// share no live channel — the sidecar is the only persisted artifact, and the
// authoring agent only regains control when the session exits. So at closeout
// the CLI prints every comment thread verbatim. Anything the reviewer said —
// including feedback meant for the authoring agent — lands in front of it.
//
// Comments the inline agent explicitly flagged (`escalate: true`) get a
// dedicated section so they aren't lost in the full transcript.

import type { Sidecar, Comment } from "./sidecar";

export interface EscalationItem {
  round: number;
  quote: string;
  request: string; // the reviewer message the inline agent couldn't act on
  note: string;    // the agent's author-handoff note
}

function flatten(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + "…" : flat;
}

function isEscalated(c: Comment): boolean {
  return c.thread.some((e) => e.role === "agent" && e.escalate === true);
}

// Pull out every comment the inline agent routed to the authoring agent.
export function collectEscalations(sidecar: Sidecar): EscalationItem[] {
  const items: EscalationItem[] = [];
  for (const round of sidecar.rounds) {
    for (const c of round.comments) {
      const escIdx = c.thread.findIndex((e) => e.role === "agent" && e.escalate === true);
      if (escIdx === -1) continue;
      const agentEntry = c.thread[escIdx]!;
      // The reviewer message immediately before the author handoff is the
      // request the inline agent couldn't fulfill.
      let request = "";
      for (let i = escIdx - 1; i >= 0; i--) {
        if (c.thread[i]!.role === "human") { request = c.thread[i]!.message; break; }
      }
      items.push({
        round: round.round,
        quote: flatten(c.quote, 80),
        request: flatten(request, 300),
        note: flatten(agentEntry.revision_reason || agentEntry.message, 300),
      });
    }
  }
  return items;
}

// A readable transcript of every comment thread, plus an author-handoff callout.
// Printed to stdout on session close so the authoring agent can read it.
export function formatReviewSummary(sidecar: Sidecar): string {
  const lines: string[] = [`Review threads — ${sidecar.file}`];

  for (const round of sidecar.rounds) {
    if (round.comments.length === 0) continue;
    lines.push("", `Round ${round.round}`);
    round.comments.forEach((c, i) => {
      const tags = [c.resolved ? "resolved" : "open"];
      if (isEscalated(c)) tags.push("author reply needed");
      lines.push(`  ${i + 1}. "${flatten(c.quote, 80)}" — ${tags.join(" · ")}`);
      for (const e of c.thread) {
        const who = e.role === "human" ? "Reviewer" : (e.name || "Agent");
        lines.push(`     ${who}: ${flatten(e.message, 280)}`);
      }
    });
  }

  const esc = collectEscalations(sidecar);
  if (esc.length > 0) {
    lines.push(
      "",
      `⚠ ${esc.length} comment${esc.length !== 1 ? "s need" : " needs"} an author reply from you:`,
    );
    for (const e of esc) {
      lines.push(`  • "${e.quote}" (round ${e.round})`);
      if (e.request) lines.push(`    Reviewer asked: ${e.request}`);
      if (e.note) lines.push(`    Agent note: ${e.note}`);
    }
    lines.push(
      "",
      "The inline review agent marked these for author-level input. Address them in the",
      "document or with the user before considering the review closed out.",
    );
  }

  return lines.join("\n");
}
