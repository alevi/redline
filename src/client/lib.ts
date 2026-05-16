// Pure-ish helpers extracted from main.js for direct test coverage.
// These functions take their DOM dependencies as arguments — they don't read
// from globals — so the same code runs in the browser bundle and in happy-dom
// tests without a separate harness.

export type ClientComment = {
  id: string;
  quote: string;
  context_before?: string;
  context_after?: string;
  resolved: boolean;
  thread: ThreadEntry[];
};

export type ThreadEntry = {
  role?: "human" | "agent";
  name?: string;
  message: string;
  // Server-rendered sanitized HTML for `message`. Present on entries
  // delivered through the API/bootstrap; absent on entries the client
  // builds locally before the next refresh. Falls back to escaped text.
  messageHtml?: string;
  requires_revision?: boolean;
  revision_reason?: string;
  escalate?: boolean;
  author?: boolean;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Latest agent verdict on a comment thread. Mirrors latestVerdict() in sidecar.ts.
export function latestVerdict(comment: ClientComment): "revise" | "accept" | null {
  const t = comment.thread || [];
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i]!;
    if (e.role !== "agent") continue;
    if (typeof e.requires_revision !== "boolean") continue;
    return e.requires_revision ? "revise" : "accept";
  }
  return null;
}

// True when an agent reply flagged this comment for authoring-agent input.
export function isEscalated(comment: ClientComment): boolean {
  const thread = comment.thread || [];
  let escIdx = -1;
  let authorIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    const entry = thread[i]!;
    if (escIdx === -1 && entry.role === "agent" && entry.escalate === true) escIdx = i;
    if (authorIdx === -1 && entry.role === "agent" && entry.author === true) authorIdx = i;
    if (escIdx !== -1 && authorIdx !== -1) break;
  }
  return escIdx !== -1 && authorIdx < escIdx;
}

export function nearestCell(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  return el && (el as Element).closest ? ((el as Element).closest("td, th") as HTMLElement | null) : null;
}

// Clamp a Range so both endpoints land inside the same cell. Returns a new
// Range, or null if no meaningful clamp is possible. Called when the user
// dragged across a cell boundary by accident.
export function clampRangeToCell(
  range: Range,
  startCell: HTMLElement | null,
  endCell: HTMLElement | null,
  doc: Document = document,
): Range | null {
  const cell = startCell || endCell;
  if (!cell) return null;
  const newRange = doc.createRange();
  try {
    if (startCell === cell) {
      newRange.setStart(range.startContainer, range.startOffset);
      newRange.setEnd(cell, cell.childNodes.length);
    } else {
      newRange.setStart(cell, 0);
      newRange.setEnd(range.endContainer, range.endOffset);
    }
    return newRange;
  } catch {
    try {
      newRange.selectNodeContents(cell);
      return newRange;
    } catch {
      return null;
    }
  }
}

export type Captured = {
  quote: string;
  context_before: string;
  context_after: string;
};

type FlatSegment = {
  node: Text | HTMLImageElement;
  start: number;
  len: number;
  isImg: boolean;
};

// An <img> contributes no characters of its own, so on its own it can't be
// anchored against. We give it a presence in the flat text as an
// `[image: alt]` token — the same shape the image-only comment path uses — so
// a selection can run text → image → text and still round-trip.
function imgToken(img: HTMLImageElement): string {
  return "[image: " + (img.alt || "") + "]";
}

// Walk a container into a flat string plus the segments that produced it.
// Text nodes contribute their value; <img> elements contribute an
// `[image: alt]` token. Segments are in document order. captureSelection and
// highlightText both build flat through here so their coordinates agree.
function buildFlat(container: Element): { flat: string; segments: FlatSegment[] } {
  const doc = container.ownerDocument || document;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n: Node) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return (n as Element).tagName === "IMG" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const segments: FlatSegment[] = [];
  let flat = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = (node as Text).nodeValue ?? "";
      segments.push({ node: node as Text, start: flat.length, len: v.length, isImg: false });
      flat += v;
    } else {
      const img = node as HTMLImageElement;
      const tok = imgToken(img);
      segments.push({ node: img, start: flat.length, len: tok.length, isImg: true });
      flat += tok;
    }
  }
  return { flat, segments };
}

// Map both range endpoints onto the flat text and return the quote with
// surrounding context. Returns null only when the selection can't be resolved
// against the flat text at all.
//
// The quote is sliced straight out of `flat` rather than reconstructed from
// `sel.toString()`. sel.toString() joins blocks with "\n"/"\n\n" separators
// that don't exist in the walker's output, and marked emits stray whitespace
// text nodes between block tags — so the two never line up across a block
// boundary. Working in flat coordinates sidesteps the mismatch: `flat` is the
// single source of truth, and highlightText re-finds the quote against the
// same flat string later. `text` is kept only as a last-resort fallback for
// the rare case where an endpoint can't be resolved.
export function captureSelection(prose: Element, sel: Selection, text: string): Captured | null {
  const range = sel.getRangeAt(0);
  const { flat, segments } = buildFlat(prose);
  if (segments.length === 0) return null;

  // Map a range boundary point onto an index into `flat`. Text-node boundaries
  // are the common case; Chrome sometimes anchors a drag to an element node
  // plus a child index, which we resolve to the nearest segment edge.
  const pointToFlat = (container: Node, offset: number, side: "start" | "end"): number => {
    for (const seg of segments) {
      if (seg.node === container) {
        if (seg.isImg) return offset > 0 ? seg.start + seg.len : seg.start;
        return seg.start + offset;
      }
    }
    if (container.nodeType === Node.TEXT_NODE) return -1;
    const kids = container.childNodes;
    const segEnd = (seg: FlatSegment) => seg.start + seg.len;
    if (side === "start") {
      const ref = offset < kids.length ? kids[offset]! : null;
      if (ref) {
        for (const seg of segments) {
          if (ref === seg.node || ref.contains(seg.node)) return seg.start;
          if (ref.compareDocumentPosition(seg.node) & Node.DOCUMENT_POSITION_FOLLOWING)
            return seg.start;
        }
        return flat.length;
      }
      let end = -1;
      for (const seg of segments) if (container.contains(seg.node)) end = segEnd(seg);
      return end === -1 ? flat.length : end;
    }
    const ref = offset > 0 ? kids[offset - 1]! : null;
    if (ref) {
      let end = -1;
      for (const seg of segments) {
        if (
          ref === seg.node ||
          ref.contains(seg.node) ||
          ref.compareDocumentPosition(seg.node) & Node.DOCUMENT_POSITION_PRECEDING
        ) {
          end = segEnd(seg);
        }
      }
      return end === -1 ? 0 : end;
    }
    for (const seg of segments) if (container.contains(seg.node)) return seg.start;
    return 0;
  };

  let flatStart = pointToFlat(range.startContainer, range.startOffset, "start");
  let flatEnd = pointToFlat(range.endContainer, range.endOffset, "end");
  if (flatStart === -1 || flatEnd === -1 || flatEnd <= flatStart) {
    return text ? { quote: text, context_before: "", context_after: "" } : null;
  }

  // Trim whitespace overshoot: a drag that ends a hair past a block — or
  // starts in the gap before one — shouldn't fail or carry stray newlines.
  // This is the "clamp": a small overshoot anchors to what the user meant.
  while (flatStart < flatEnd && /\s/.test(flat[flatStart]!)) flatStart++;
  while (flatEnd > flatStart && /\s/.test(flat[flatEnd - 1]!)) flatEnd--;
  if (flatEnd <= flatStart) return null;

  return {
    quote: flat.slice(flatStart, flatEnd),
    context_before: flat.slice(Math.max(0, flatStart - 32), flatStart),
    context_after: flat.slice(flatEnd, flatEnd + 32),
  };
}

// Wrap occurrences of `text` inside `container` with <mark> elements. Uses
// `contextBefore` to disambiguate when a quote appears multiple times. The
// quote is matched against the same flat text captureSelection produced, so
// `[image: alt]` tokens in the quote wrap the corresponding <img> — whether
// the quote is image-only or text mixed with an image.
// Returns the marks created (caller can attach event listeners).
export function highlightText(
  container: Element,
  text: string,
  id: string,
  resolved: boolean,
  contextBefore: string,
): HTMLElement[] {
  const doc = container.ownerDocument || document;
  const marks: HTMLElement[] = [];

  (container as HTMLElement).normalize();

  const { flat, segments } = buildFlat(container);

  let quoteStart = -1;
  if (contextBefore) {
    const ctxIdx = flat.indexOf(contextBefore + text);
    if (ctxIdx !== -1) quoteStart = ctxIdx + contextBefore.length;
  }
  if (quoteStart === -1) quoteStart = flat.indexOf(text);
  if (quoteStart === -1) return marks;

  const quoteEnd = quoteStart + text.length;

  for (const seg of segments) {
    const segStart = seg.start;
    const segEnd = seg.start + seg.len;
    if (segEnd <= quoteStart || segStart >= quoteEnd) continue;

    if (seg.isImg) {
      // Image tokens are atomic — wrap the <img> only when the quote covers
      // the whole token, never on a partial overlap.
      if (segStart < quoteStart || segEnd > quoteEnd) continue;
      const img = seg.node as HTMLImageElement;
      const mark = doc.createElement("mark");
      mark.className = "rl-highlight rl-img" + (resolved ? " resolved" : "");
      mark.dataset.commentId = id;
      img.parentNode!.insertBefore(mark, img);
      mark.appendChild(img);
      marks.push(mark);
      continue;
    }

    const tn = seg.node as Text;
    const localStart = Math.max(0, quoteStart - segStart);
    const localEnd = Math.min(seg.len, quoteEnd - segStart);
    const mark = doc.createElement("mark");
    mark.className = "rl-highlight" + (resolved ? " resolved" : "");
    mark.dataset.commentId = id;
    const mid = tn.splitText(localStart);
    mid.splitText(localEnd - localStart);
    mid.parentNode!.insertBefore(mark, mid);
    mark.appendChild(mid);
    marks.push(mark);
  }
  return marks;
}

export type NavState = {
  visible: boolean;
  countText: string;
  navIdx: number;
  showPrev: boolean;
  prevDisabled: boolean;
  nextLabel: string;
  nextDisabled: boolean;
};

// Pure state computation for the prev/next nav above the prose. Given the
// comments, the active card's id (if any), and the previous navIdx, return
// what the buttons should display. Mirrors the body of updateNav() in main.js.
export function computeNavState(
  comments: ClientComment[],
  activeId: string | null,
  prevNavIdx: number,
): NavState {
  const open = comments.filter((c) => !c.resolved);
  if (open.length === 0) {
    return {
      visible: false,
      countText: "",
      navIdx: prevNavIdx,
      showPrev: false,
      prevDisabled: true,
      nextLabel: "",
      nextDisabled: true,
    };
  }
  const matchIdx = activeId ? open.findIndex((c) => c.id === activeId) : -1;
  const navIdx = matchIdx >= 0 ? matchIdx : Math.min(prevNavIdx, open.length - 1);
  if (open.length === 1) {
    return {
      visible: true,
      countText: "1 / 1",
      navIdx,
      showPrev: false,
      prevDisabled: true,
      nextLabel: "Jump to comment ↓",
      nextDisabled: false,
    };
  }
  return {
    visible: true,
    countText: navIdx + 1 + " / " + open.length,
    navIdx,
    showPrev: true,
    prevDisabled: navIdx === 0,
    nextLabel: "Next ↓",
    nextDisabled: navIdx === open.length - 1,
  };
}

// Pin `window.scrollY` across a DOM mutation that may shift focus. Blurs the
// active element first (focus-loss scrolls fire a frame later), runs `fn`,
// then restores scroll synchronously and again across two rAF callbacks. The
// triple restore is not paranoia — focus-related scroll-into-view lands one
// frame after the call returns. `protectFocusSelector` opt-out is for the
// new-comment-form case where blurring would eat keystrokes.
export function preserveScroll(
  fn: () => void,
  opts: {
    win?: Window;
    doc?: Document;
    protectFocusSelector?: string;
    skip?: boolean;
  } = {},
): void {
  const win = opts.win ?? window;
  const doc = opts.doc ?? win.document;
  if (opts.skip) {
    fn();
    return;
  }
  const top = win.scrollY;
  const active = doc.activeElement as HTMLElement | null;
  const protect =
    opts.protectFocusSelector && active && active.closest && active.closest(opts.protectFocusSelector);
  if (!protect && active && active !== doc.body && typeof active.blur === "function") active.blur();
  fn();
  doc.documentElement.scrollTop = top;
  win.requestAnimationFrame(() => {
    doc.documentElement.scrollTop = top;
    win.requestAnimationFrame(() => {
      doc.documentElement.scrollTop = top;
    });
  });
}
