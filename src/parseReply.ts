// Parse the agent's JSON reply. Robust to:
//   - a ```json ... ``` (or bare ```) code fence wrapping the envelope
//   - trailing text after the JSON object (model overrun: it emits the
//     envelope and keeps generating, e.g. hallucinating the next prompt)
//   - leading text before the JSON object (less common but symmetric)
// On any failure to find a usable envelope, fall back to the raw text as the
// message and requires_revision: true (safe default — we'd rather run an
// unnecessary revision pass than silently skip one).
export interface ParsedReply {
  message: string;
  requires_revision: boolean;
  reason: string;
}

// Find the first balanced JSON object in `s` and return [start, endExclusive),
// or null if none. Walks string literals correctly so `}` inside a quoted
// string doesn't end the object early.
function findFirstObject(s: string): [number, number] | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}

export function parseReply(raw: string): ParsedReply {
  const trimmed = raw.trim();
  let body = trimmed;
  // Strip a single ```json ... ``` or ``` ... ``` fence if the model wrapped.
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();

  // Try strict parse first — preserves the existing behavior on clean input.
  const tryEnvelope = (s: string): ParsedReply | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj.message === "string") {
        return {
          message: obj.message.trim(),
          requires_revision: obj.requires_revision !== false, // default true if missing/non-bool
          reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
        };
      }
    } catch { /* fall through */ }
    return null;
  };

  const strict = tryEnvelope(body);
  if (strict) return strict;

  // Strict failed — try to extract the first balanced JSON object and parse
  // just that. Catches the common model-overrun case where the envelope is
  // valid but trailing text (or rarely leading text) confuses JSON.parse.
  const span = findFirstObject(body);
  if (span) {
    const obj = tryEnvelope(body.slice(span[0], span[1]));
    if (obj) return obj;
  }

  return { message: trimmed, requires_revision: true, reason: "" };
}
