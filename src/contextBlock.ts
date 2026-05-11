import type { Envelope } from "./promptEnvelope";

// Builds the "Reviewer's stated focus" section for both the reply and the
// revision prompts when the user passed `--context "..."` (persisted to
// sidecar.context). The context is reviewer-supplied text, so it goes
// through the same UUID-anchored envelope that wraps the document and
// comment text — adversarial context content can't escape its envelope to
// pose as system instructions.
//
// Returns the empty string for missing/blank context so callers can prepend
// unconditionally without an extra branch.
export function contextBlock(context: string | null | undefined, env: Envelope): string {
  const trimmed = context?.trim();
  if (!trimmed) return "";
  return `## Reviewer's stated focus\n\n${env.wrap("context", trimmed)}\n\n---\n\n`;
}
