// Parse the agent's reply.
//
// Preferred format is a delimiter envelope — chosen over JSON because the
// `message` field is free-form prose and reliably contains double quotes,
// which the model would have to escape inside a JSON string. It often
// doesn't, and JSON.parse then fails on the whole envelope, dumping the raw
// text into the UI. The delimiter form needs no escaping:
//
//   REQUIRES_REVISION: <true|false>
//   ESCALATE: <true|false>   (optional — absent means false)
//   REASON: <one short sentence, or empty>
//   ---MESSAGE---
//   <free-form prose, may contain anything>
//   ---END---
//
// JSON form is still accepted as a fallback for older traces and for the case
// where the model regresses to it. JSON parsing tolerates:
//   - a ```json ... ``` (or bare ```) code fence wrapping the envelope
//   - trailing text after the JSON object (model overrun)
//   - leading text before the JSON object
//
// On any failure to find a usable envelope, fall back to the raw text as the
// message and requires_revision: true (safe default — we'd rather run an
// unnecessary revision pass than silently skip one).
export interface ParsedReply {
  message: string;
  requires_revision: boolean;
  reason: string;
  // True when the agent flagged the comment for the launching ("outer") agent
  // — something it couldn't act on from inside the review. Optional in the
  // envelope; absent means false.
  escalate: boolean;
}

function tryDelimiterEnvelope(s: string): ParsedReply | null {
  const msgStart = s.indexOf("---MESSAGE---");
  const msgEnd = s.indexOf("---END---", msgStart === -1 ? 0 : msgStart);
  if (msgStart === -1 || msgEnd === -1) return null;

  const header = s.slice(0, msgStart);
  const message = s.slice(msgStart + "---MESSAGE---".length, msgEnd).trim();

  const reqMatch = header.match(/REQUIRES_REVISION\s*:\s*(true|false)\b/i);
  const reasonMatch = header.match(/REASON\s*:\s*(.*?)\s*(?:\n|$)/i);
  const escMatch = header.match(/ESCALATE\s*:\s*(true|false)\b/i);

  return {
    message,
    requires_revision: reqMatch ? reqMatch[1].toLowerCase() === "true" : true,
    reason: reasonMatch ? reasonMatch[1].trim() : "",
    escalate: escMatch ? escMatch[1].toLowerCase() === "true" : false,
  };
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
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
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

  // Preferred path: delimiter envelope.
  const delim = tryDelimiterEnvelope(trimmed);
  if (delim) return delim;

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
          escalate: obj.escalate === true,
        };
      }
    } catch {
      /* fall through */
    }
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

  return {
    message: trimmed,
    requires_revision: true,
    reason: "",
    escalate: false,
  };
}
