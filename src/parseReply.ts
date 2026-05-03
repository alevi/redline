// Parse the agent's JSON reply. Robust to a code-fenced wrapper since some
// model paths still emit ```json ... ```. On any parse failure, fall back to
// the raw text as the message and requires_revision: true (safe default —
// we'd rather run an unnecessary revision pass than silently skip one).
export interface ParsedReply {
  message: string;
  requires_revision: boolean;
  reason: string;
}

export function parseReply(raw: string): ParsedReply {
  const trimmed = raw.trim();
  let body = trimmed;
  // Strip a single ```json ... ``` or ``` ... ``` fence if the model wrapped.
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj.message === "string") {
      return {
        message: obj.message.trim(),
        requires_revision: obj.requires_revision !== false, // default true if missing/non-bool
        reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
      };
    }
  } catch {
    // fall through
  }
  return { message: trimmed, requires_revision: true, reason: "" };
}
