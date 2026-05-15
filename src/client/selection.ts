import {
  nearestCell,
  clampRangeToCell,
  captureSelection as _captureSelection,
} from "./lib";
import { state, showError } from "./state";
import { positionCards, observeCardSizes } from "./cards";
import {
  saveComment,
  applyHighlights,
  applyRoundState,
  focusComment,
  updateNav,
  renderComments,
} from "./render";

let selectionTimer: ReturnType<typeof setTimeout> | null = null;

function captureSelection(sel: Selection, text: string) {
  return _captureSelection(document.getElementById("prose")!, sel, text);
}

function isFormEmpty(): boolean {
  const ta = document.querySelector("#new-comment-form textarea") as HTMLTextAreaElement | null;
  return !ta || ta.value.trim() === "";
}

function nudgeOpenForm(): void {
  const form = document.getElementById("new-comment-form");
  if (!form) return;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  const ta = form.querySelector("textarea") as HTMLTextAreaElement | null;
  if (ta) {
    ta.focus();
    ta.style.borderColor = "var(--accent)";
    ta.style.boxShadow = "0 0 0 3px rgba(217,119,6,0.25)";
    setTimeout(() => {
      ta.style.boxShadow = "";
    }, 600);
  }
}

export function showNewCommentForm(
  selection: typeof state.pendingSelection,
  formTop: number,
): void {
  document.getElementById("new-comment-form")?.remove();
  removePendingHighlight();
  window.getSelection()?.removeAllRanges();

  if (selection?._range) applyPendingHighlight(selection._range);
  else if (selection?._img) applyPendingImgHighlight(selection._img);

  const form = document.createElement("div");
  form.id = "new-comment-form";
  form.className = "new-comment-form";
  form.style.top = Math.max(0, formTop) + "px";

  const body = document.createElement("div");
  body.className = "new-comment-body";

  const textarea = document.createElement("textarea");
  textarea.className = "reply-input";
  textarea.placeholder = "Leave a comment\u2026";
  body.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "new-comment-actions";

  const cancel = document.createElement("button");
  cancel.className = "btn-cancel-inline";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    dismissNewCommentForm();
  });

  const save = document.createElement("button");
  save.className = "reply-submit";
  save.innerHTML = "Save <kbd>\u2318\u21B5</kbd>";
  save.addEventListener("click", () => saveComment(form, textarea, selection!));

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveComment(form, textarea, selection!);
    if (e.key === "Escape") {
      dismissNewCommentForm();
    }
  });

  actions.appendChild(cancel);
  actions.appendChild(save);
  body.appendChild(actions);
  form.appendChild(body);

  const sidebar = document.querySelector(".sidebar-col")!;
  sidebar.appendChild(form);
  textarea.focus();
  positionCards();
  observeCardSizes();

  requestAnimationFrame(() => {
    const sidebarHeight = sidebar.getBoundingClientRect().height;
    const formHeight = form.offsetHeight;
    const desiredTop = parseFloat(form.style.top) || 0;
    const maxTop = Math.max(0, sidebarHeight - formHeight - 8);
    if (desiredTop > maxTop) form.style.top = maxTop + "px";
  });
}

export function dismissNewCommentForm(): void {
  const form = document.getElementById("new-comment-form");
  if (form) form.remove();
  removePendingHighlight();
  state.pendingSelection = null;
  positionCards();
}

function applyPendingHighlight(range: Range): void {
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode! : ancestor;

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) textNodes.push(node as Text);
  }

  for (const tn of textNodes) {
    const start = tn === range.startContainer ? range.startOffset : 0;
    const end = tn === range.endContainer ? range.endOffset : tn.nodeValue!.length;
    if (start >= end) continue;

    const mark = document.createElement("mark");
    mark.className = "rl-highlight rl-pending";
    mark.dataset.commentId = "pending";

    const mid = tn.splitText(start);
    mid.splitText(end - start);
    mid.parentNode!.insertBefore(mark, mid);
    mark.appendChild(mid);
  }
}

function applyPendingImgHighlight(img: HTMLImageElement): void {
  const mark = document.createElement("mark");
  mark.className = "rl-highlight rl-pending rl-img";
  mark.dataset.commentId = "pending";
  img.parentNode!.insertBefore(mark, img);
  mark.appendChild(img);
}

function removePendingHighlight(): void {
  const prose = document.getElementById("prose")!;
  prose.querySelectorAll('[data-comment-id="pending"]').forEach((m) => {
    const parent = m.parentNode!;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  prose.normalize();
}

export function initSelectionHandlers(): void {
  // Text selection -> comment form (debounced)
  document.addEventListener("mouseup", () => {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }

    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      if (document.getElementById("new-comment-form")) {
        if ((window.getSelection()?.toString().trim().length ?? 0) >= 2) nudgeOpenForm();
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const prose = document.getElementById("prose");
      if (!prose?.contains(sel.anchorNode)) return;

      let range = sel.getRangeAt(0);

      const startCell = nearestCell(range.startContainer);
      const endCell = nearestCell(range.endContainer);
      if ((startCell || endCell) && startCell !== endCell) {
        const clamped = clampRangeToCell(range, startCell, endCell);
        if (clamped) {
          range = clamped;
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      const text = sel.toString().trim();
      if (!text || text.length < 2) return;

      const captured = captureSelection(sel, text);
      if (!captured) {
        showError("Couldn't anchor that selection \u2014 try highlighting the passage again.");
        sel.removeAllRanges();
        return;
      }

      const rect = range.getBoundingClientRect();
      state.pendingSelection = {
        ...captured,
        _rectTop: rect.top,
        _range: range.cloneRange(),
      };

      const sidebarRect = document.querySelector(".sidebar-col")!.getBoundingClientRect();
      showNewCommentForm(state.pendingSelection, rect.top - sidebarRect.top);
    }, 250);
  });

  // Image click -> comment form
  document.addEventListener(
    "click",
    (e) => {
      if ((e.target as HTMLElement).tagName !== "IMG") return;
      const prose = document.getElementById("prose");
      if (!prose?.contains(e.target as Node)) return;
      if (document.getElementById("new-comment-form")) {
        e.preventDefault();
        nudgeOpenForm();
        return;
      }
      e.preventDefault();
      const img = e.target as HTMLImageElement;
      const alt = img.alt || "";
      const quote = "[image: " + alt + "]";

      const rect = img.getBoundingClientRect();
      const sidebarRect = document.querySelector(".sidebar-col")!.getBoundingClientRect();
      state.pendingSelection = { quote, context_before: "", context_after: "", _rectTop: rect.top, _img: img };
      showNewCommentForm(state.pendingSelection, rect.top - sidebarRect.top);
    },
    true,
  );

  // Close empty draft on outside click
  document.addEventListener("mousedown", (e) => {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    const form = document.getElementById("new-comment-form");
    if (form && !form.contains(e.target as Node) && isFormEmpty()) {
      dismissNewCommentForm();
    }
  });
}
