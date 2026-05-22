import {
  escapeHtml,
  isEscalated,
  latestVerdict,
  type ClientComment,
  type ThreadEntry,
} from "./lib";
import { state } from "./state";

export type CardCallbacks = {
  focusComment: (id: string) => void;
  updateNav: () => void;
  positionCards: () => void;
  resolveComment: (id: string) => void;
  reopenComment: (id: string) => void;
  toggleReplyForm: (id: string) => void;
  submitReply: (id: string, message: string) => void;
};

let _callbacks: CardCallbacks | null = null;

export function setCardCallbacks(cb: CardCallbacks): void {
  _callbacks = cb;
}

function cb(): CardCallbacks {
  return _callbacks!;
}

export function buildCommentCard(comment: ClientComment): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "comment-card" + (comment.resolved ? " resolved" : "");
  card.id = "card-" + comment.id;

  const quote = document.createElement("div");
  quote.className = "comment-quote";
  if (comment.resolved) {
    const badge = document.createElement("span");
    badge.className = "resolved-badge";
    badge.textContent = "\u2713 Resolved";
    quote.appendChild(badge);
    const verdict = latestVerdict(comment);
    if (verdict) {
      const vbadge = document.createElement("span");
      vbadge.className = "verdict-badge " + verdict;
      vbadge.textContent =
        verdict === "revise" ? "\u270E Edit queued" : "\u2713 Answered";
      quote.appendChild(vbadge);
    }
  }
  if (isEscalated(comment)) {
    const ebadge = document.createElement("span");
    ebadge.className = "escalate-badge";
    ebadge.textContent = "↑ Author reply needed";
    quote.appendChild(ebadge);
  }
  quote.appendChild(document.createTextNode('"' + comment.quote + '"'));
  card.appendChild(quote);

  if (comment.resolved) {
    const lastAgentMsg = [...comment.thread]
      .reverse()
      .find((e) => e.role === "agent");
    if (lastAgentMsg) {
      const full = lastAgentMsg.message;
      const sentenceEnd = full.search(/[.!?](\s|$)/);
      let summary = sentenceEnd !== -1 ? full.slice(0, sentenceEnd + 1) : full;
      if (summary.length > 140)
        summary = summary.slice(0, 137).trimEnd() + "\u2026";
      const commitment = document.createElement("div");
      commitment.className = "card-commitment";
      commitment.textContent = summary;
      card.appendChild(commitment);
    }
  }

  const thread = document.createElement("div");
  thread.className = "comment-thread";
  thread.id = "thread-" + comment.id;

  let latestVerdictIdx = -1;
  for (let i = comment.thread.length - 1; i >= 0; i--) {
    const e = comment.thread[i]!;
    if (e.role === "agent" && typeof e.requires_revision === "boolean") {
      latestVerdictIdx = i;
      break;
    }
  }
  comment.thread.forEach((entry, i) => {
    thread.appendChild(buildThreadEntry(entry, i === latestVerdictIdx));
  });
  if (state.thinkingCommentIds.has(comment.id)) {
    const indicator = document.createElement("div");
    indicator.className = "thread-entry thinking-indicator";
    indicator.innerHTML =
      '<div class="thread-role agent">Agent</div><div class="thread-message thinking-dots"><span></span><span></span><span></span></div>';
    thread.appendChild(indicator);
  }

  const body = document.createElement("div");
  body.className = "comment-body";
  body.appendChild(thread);

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  if (!comment.resolved && !state.roundResolved) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "btn-reply";
    replyBtn.textContent = "Reply";
    replyBtn.addEventListener("click", () => cb().toggleReplyForm(comment.id));
    actions.appendChild(replyBtn);

    const resolveBtn = document.createElement("button");
    const verdict = latestVerdict(comment);
    resolveBtn.className =
      "btn-resolve-comment" + (verdict === "revise" ? " revise" : "");
    resolveBtn.textContent =
      verdict === "revise" ? "Resolve \u2192 queue edit" : "Resolve";
    resolveBtn.addEventListener("click", () => cb().resolveComment(comment.id));
    actions.appendChild(resolveBtn);
  }

  if (comment.resolved && !state.roundResolved) {
    const reopenBtn = document.createElement("button");
    reopenBtn.className = "btn-reopen";
    reopenBtn.textContent = "Reopen";
    reopenBtn.addEventListener("click", () => cb().reopenComment(comment.id));
    actions.appendChild(reopenBtn);
  }

  body.appendChild(actions);

  const replyForm = document.createElement("div");
  replyForm.className = "reply-form";
  replyForm.id = "reply-" + comment.id;
  replyForm.innerHTML = `
    <textarea class="reply-input" placeholder="Reply\u2026"></textarea>
    <button class="reply-submit">Send <kbd>\u2318\u21B5</kbd></button>
  `;
  const sendReply = () => {
    const ta = replyForm.querySelector(".reply-input") as HTMLTextAreaElement;
    const message = ta.value.trim();
    if (!message) return;
    ta.value = "";
    cb().submitReply(comment.id, message);
  };
  replyForm
    .querySelector(".reply-submit")!
    .addEventListener("click", sendReply);
  (
    replyForm.querySelector(".reply-input") as HTMLTextAreaElement
  ).addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply();
  });
  body.appendChild(replyForm);

  card.appendChild(body);

  if (comment.resolved) {
    quote.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.toggle("expanded");
      cb().positionCards();
    });
  }

  card.addEventListener("click", (e) => {
    if (
      (e.target as HTMLElement).tagName === "BUTTON" ||
      (e.target as HTMLElement).tagName === "TEXTAREA"
    )
      return;
    if (comment.resolved) return;
    cb().focusComment(comment.id);
    cb().updateNav();
  });

  return card;
}

function buildThreadEntry(
  entry: ThreadEntry,
  isLatestVerdict: boolean,
): HTMLDivElement {
  const role = entry.role ?? "agent";
  const label =
    entry.name ??
    (entry.author ? "Author" : role === "agent" ? "Agent" : "Human");
  const div = document.createElement("div");
  div.className = "thread-entry" + (entry.author ? " author-entry" : "");
  let verdictHtml = "";
  if (role === "agent" && entry.requires_revision === true && isLatestVerdict) {
    const reason = entry.revision_reason
      ? escapeHtml(entry.revision_reason)
      : "edit queued";
    verdictHtml = `<div class="verdict revise"><span class="verdict-icon">\u270E</span><span>${reason}</span></div>`;
  }
  if (role === "agent" && entry.escalate === true) {
    verdictHtml += `<div class="verdict escalate"><span class="verdict-icon">\u2191</span><span>Author reply needed</span></div>`;
  }
  const messageHtml = entry.messageHtml ?? escapeHtml(entry.message);
  div.innerHTML = `
    <div class="thread-role ${role}">${escapeHtml(label)}</div>
    <div class="thread-message">${messageHtml}</div>
    ${verdictHtml}
  `;
  return div;
}

export interface TypingState {
  focused: {
    kind: "new" | "reply";
    commentId?: string;
    value: string;
    selectionStart: number;
    selectionEnd: number;
  } | null;
  drafts: {
    commentId: string;
    value: string;
    selectionStart: number;
    selectionEnd: number;
  }[];
}

export function captureTypingState(): TypingState {
  const typingState: TypingState = { focused: null, drafts: [] };

  const active = document.activeElement as HTMLTextAreaElement | null;
  if (active && active.tagName === "TEXTAREA") {
    const newForm = active.closest("#new-comment-form");
    const replyForm = active.closest(".reply-form");
    const card = active.closest(".comment-card");
    if (newForm) {
      typingState.focused = {
        kind: "new",
        value: active.value,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
      };
    } else if (replyForm && card && card.id) {
      typingState.focused = {
        kind: "reply",
        commentId: card.id.replace("card-", ""),
        value: active.value,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
      };
    }
  }

  document.querySelectorAll(".reply-form.open").forEach((form) => {
    const ta = form.querySelector(".reply-input") as HTMLTextAreaElement | null;
    const card = form.closest(".comment-card");
    if (!ta || !card || !card.id) return;
    if (!ta.value) return;
    typingState.drafts.push({
      commentId: card.id.replace("card-", ""),
      value: ta.value,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
    });
  });

  return typingState;
}

export function restoreTypingState(typingState: TypingState): void {
  typingState.drafts.forEach((d) => {
    const card = document.getElementById("card-" + d.commentId);
    if (!card) return;
    const form = card.querySelector(".reply-form");
    if (!form) return;
    const ta = form.querySelector(".reply-input") as HTMLTextAreaElement | null;
    if (!ta) return;
    form.classList.add("open");
    ta.value = d.value;
  });

  const f = typingState.focused;
  if (!f) return;
  let target: HTMLTextAreaElement | null = null;
  if (f.kind === "new") {
    target = document.querySelector("#new-comment-form textarea");
  } else if (f.kind === "reply") {
    const card = document.getElementById("card-" + f.commentId);
    if (card) {
      const form = card.querySelector(".reply-form");
      if (form) {
        form.classList.add("open");
        target = form.querySelector(".reply-input");
      }
    }
  }
  if (!target) return;
  target.value = f.value;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  try {
    target.setSelectionRange(f.selectionStart, f.selectionEnd);
  } catch {}
}

export function toggleReplyForm(id: string): void {
  const form = document.getElementById("reply-" + id);
  const card = document.getElementById("card-" + id);
  if (!form) return;
  form.classList.toggle("open");
  if (form.classList.contains("open")) {
    (form.querySelector(".reply-input") as HTMLTextAreaElement)?.focus();
    if (card) card.style.zIndex = "1";
  } else {
    if (card) card.style.zIndex = "";
  }
  cb().positionCards();
}

let _positionRafId = 0;
export function schedulePositionCards(): void {
  if (_positionRafId) return;
  _positionRafId = requestAnimationFrame(() => {
    _positionRafId = 0;
    cb().positionCards();
  });
}

const _cardResizeObserver =
  typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => schedulePositionCards())
    : null;

export function observeCardSizes(): void {
  if (!_cardResizeObserver) return;
  _cardResizeObserver.disconnect();
  document
    .querySelectorAll(".comment-card, #new-comment-form")
    .forEach((el) => {
      _cardResizeObserver.observe(el);
    });
}

export function positionCards(): void {
  const sidebarCol = document.querySelector(".sidebar-col");
  if (!sidebarCol) return;
  const sidebarRect = sidebarCol.getBoundingClientRect();

  const items: { el: HTMLElement; ideal: number; active: boolean }[] = [];
  let fallbackTop = 0;
  state.comments.forEach((comment) => {
    const card = document.getElementById("card-" + comment.id);
    if (!card) return;
    const mark = document.querySelector(
      '[data-comment-id="' + comment.id + '"]',
    );
    let ideal: number;
    if (mark) {
      const markRect = mark.getBoundingClientRect();
      ideal = Math.max(0, markRect.top - sidebarRect.top);
      fallbackTop = Math.max(fallbackTop, ideal + card.offsetHeight + 14);
    } else {
      ideal = fallbackTop;
      fallbackTop += card.offsetHeight + 14;
    }
    items.push({
      el: card,
      ideal,
      active: card.classList.contains("active"),
    });
  });

  const form = document.getElementById("new-comment-form");
  if (form) {
    const pendingMark = document.querySelector('[data-comment-id="pending"]');
    let ideal: number;
    if (pendingMark) {
      ideal = Math.max(
        0,
        pendingMark.getBoundingClientRect().top - sidebarRect.top,
      );
    } else if (state.pendingSelection?._rectTop != null) {
      ideal = Math.max(0, state.pendingSelection._rectTop - sidebarRect.top);
    } else {
      ideal = parseFloat(form.style.top) || 0;
    }
    items.forEach((item) => {
      item.active = false;
    });
    items.push({ el: form, ideal, active: true });
  }

  if (items.length === 0) return;
  items.sort((a, b) => a.ideal - b.ideal);

  const activeIdx = items.findIndex((item) => item.active);

  if (activeIdx === -1) {
    let minTop = 0;
    items.forEach(({ el, ideal }) => {
      const top = Math.max(ideal, minTop);
      el.style.top = top + "px";
      minTop = top + el.offsetHeight + 14;
    });
    return;
  }

  const active = items[activeIdx]!;
  active.el.style.top = active.ideal + "px";

  let ceiling = active.ideal - 14;
  for (let i = activeIdx - 1; i >= 0; i--) {
    const { el, ideal } = items[i]!;
    const top = Math.max(0, Math.min(ideal, ceiling - el.offsetHeight));
    el.style.top = top + "px";
    ceiling = top - 14;
  }

  let floor = active.ideal + active.el.offsetHeight + 14;
  for (let i = activeIdx + 1; i < items.length; i++) {
    const { el, ideal } = items[i]!;
    const top = Math.max(ideal, floor);
    el.style.top = top + "px";
    floor = top + el.offsetHeight + 14;
  }
}
