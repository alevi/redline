// Heuristic for picking which Claude model to use based on the human's message.
// Short / simple → Haiku. Long, question, or "involved" keyword → Sonnet.
//
// Used in two places:
//   - agent.ts picks per-reply, looking at the last human message in the thread
//   - resolve.ts picks per-revision, scanning every human message across settled comments

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const SMART_MODEL = "claude-sonnet-4-6";

export const REPLY_INVOLVED_PATTERNS =
  /\b(what|why|how|which|who|suggest|suggestion|alternative|option|idea|propose|explain|think|consider|recommend|help|could|would|should)\b/i;

export const REVISION_INVOLVED_PATTERNS =
  /\b(rewrite|restructure|expand|elaborate|rework|suggest|alternative|creative|tone|voice|style|flow|argue|why|explain|unclear|confusing|reconsider)\b/i;

export function pickReplyModel(message: string): string {
  if (message.length > 120) return SMART_MODEL;
  if (message.includes("?")) return SMART_MODEL;
  if (REPLY_INVOLVED_PATTERNS.test(message)) return SMART_MODEL;
  return FAST_MODEL;
}

export interface SettledCommentLike {
  thread: { role: string; message: string }[];
}

export function pickRevisionModel(comments: SettledCommentLike[]): string {
  for (const c of comments) {
    for (const entry of c.thread) {
      if (entry.role !== "human") continue;
      const m = entry.message;
      if (m.length > 150) return SMART_MODEL;
      if (REVISION_INVOLVED_PATTERNS.test(m)) return SMART_MODEL;
    }
  }
  return FAST_MODEL;
}
