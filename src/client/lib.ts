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
  requires_revision?: boolean;
  revision_reason?: string;
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

// Walk the prose container's text nodes, locate the selection's start, and
// return the quote with surrounding context. Returns null when the selection
// can't be relocated against flat text (e.g. crossed an <img>).
export function captureSelection(prose: Element, sel: Selection, text: string): Captured | null {
  const range = sel.getRangeAt(0);

  const walker = (prose.ownerDocument || document).createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  const segments: { node: Text; start: number }[] = [];
  let flat = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tn = node as Text;
    segments.push({ node: tn, start: flat.length });
    flat += tn.nodeValue ?? "";
  }

  let quoteStart = -1;
  for (const seg of segments) {
    if (seg.node === range.startContainer) {
      quoteStart = seg.start + range.startOffset;
      break;
    }
  }

  if (quoteStart === -1) {
    return { quote: text, context_before: "", context_after: "" };
  }

  const slice = flat.slice(quoteStart, quoteStart + text.length);
  if (slice !== text) return null;

  return {
    quote: text,
    context_before: flat.slice(Math.max(0, quoteStart - 32), quoteStart),
    context_after: flat.slice(quoteStart + text.length, quoteStart + text.length + 32),
  };
}

// Wrap occurrences of `text` inside `container` with <mark> elements. Uses
// `contextBefore` to disambiguate when a quote appears multiple times.
// Image quotes (`[image: alt]`) wrap the matching <img> instead.
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

  const imgMatch = text.match(/^\[image:\s*(.*)\]$/);
  if (imgMatch) {
    const alt = imgMatch[1];
    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
      if ((img.alt || "") === alt) {
        const mark = doc.createElement("mark");
        mark.className = "rl-highlight rl-img" + (resolved ? " resolved" : "");
        mark.dataset.commentId = id;
        img.parentNode!.insertBefore(mark, img);
        mark.appendChild(img);
        marks.push(mark);
        return marks;
      }
    }
    return marks;
  }

  (container as HTMLElement).normalize();

  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const segments: { node: Text; start: number }[] = [];
  let flat = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tn = node as Text;
    segments.push({ node: tn, start: flat.length });
    flat += tn.nodeValue ?? "";
  }

  let quoteStart = -1;
  if (contextBefore) {
    const ctxIdx = flat.indexOf(contextBefore + text);
    if (ctxIdx !== -1) quoteStart = ctxIdx + contextBefore.length;
  }
  if (quoteStart === -1) quoteStart = flat.indexOf(text);
  if (quoteStart === -1) return marks;

  const quoteEnd = quoteStart + text.length;

  const toWrap: { node: Text; localStart: number; localEnd: number }[] = [];
  for (const seg of segments) {
    const segEnd = seg.start + (seg.node.nodeValue?.length ?? 0);
    if (segEnd <= quoteStart || seg.start >= quoteEnd) continue;
    toWrap.push({
      node: seg.node,
      localStart: Math.max(0, quoteStart - seg.start),
      localEnd: Math.min(seg.node.nodeValue?.length ?? 0, quoteEnd - seg.start),
    });
  }

  for (const { node: tn, localStart, localEnd } of toWrap) {
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

// Mirror the top-of-doc round-action button (and its optional secondary
// "or …" link) onto a copy at the foot of the document so a long read
// doesn't force a scroll back to the header to act.
//
// The top button (#btn-accept) is canonical — this helper only reads it
// and writes onto #btn-accept-bottom / #round-secondary-bottom. The
// bottom mirror is hidden once the top collapses to "✓ Accepted" /
// "✓ Done" so it doesn't surface as a stale control.
export function syncBottomRoundActions(doc: Document = document): void {
  const top = doc.getElementById("btn-accept") as HTMLButtonElement | null;
  const bottom = doc.getElementById("btn-accept-bottom") as HTMLButtonElement | null;
  const bottomWrap = doc.getElementById("round-actions-bottom") as HTMLElement | null;
  if (!top || !bottom || !bottomWrap) return;

  const isTerminal = top.disabled && /^✓/.test(top.textContent || "");
  bottomWrap.style.display = isTerminal ? "none" : "";
  bottom.textContent = top.textContent;
  bottom.disabled = top.disabled;
  bottom.dataset.mode = top.dataset.mode || "";
  bottom.classList.toggle("revise-tinted", top.classList.contains("revise-tinted"));

  const secTop = doc.getElementById("round-secondary");
  const secBot = doc.getElementById("round-secondary-bottom");
  if (!secBot) return;
  if (secTop) {
    secBot.innerHTML = secTop.innerHTML.replace(
      'id="round-secondary-btn"',
      'id="round-secondary-btn-bottom"',
    );
    secBot.style.display = "";
    secBot.querySelector("#round-secondary-btn-bottom")?.addEventListener("click", () => {
      (doc.getElementById("round-secondary-btn") as HTMLButtonElement | null)?.click();
    });
  } else {
    secBot.innerHTML = "";
    secBot.style.display = "none";
  }
}
