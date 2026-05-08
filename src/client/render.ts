import {
  computeNavState,
  highlightText as _highlightText,
  preserveScroll as _preserveScroll,
  latestVerdict,
} from "./lib";
import { state, apiFetch, showError } from "./state";
import {
  buildCommentCard,
  captureTypingState,
  restoreTypingState,
  positionCards,
  observeCardSizes,
  toggleReplyForm,
} from "./cards";

function preserveScroll(fn: () => void): void {
  _preserveScroll(fn, {
    skip: Date.now() < state.deliberateScrollUntil,
    protectFocusSelector: "#new-comment-form",
  });
}

export function applyHighlights(): void {
  preserveScroll(() => {
    const prose = document.getElementById("prose")!;
    prose.querySelectorAll("mark.rl-highlight").forEach((m) => {
      const parent = m.parentNode!;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    prose.normalize();
    state.comments.forEach((comment) => {
      highlightText(prose, comment.quote, comment.id, comment.resolved, comment.context_before || "");
    });
  });
}

function highlightText(
  container: Element,
  text: string,
  id: string,
  resolved: boolean,
  contextBefore: string,
): void {
  const marks = _highlightText(container, text, id, resolved, contextBefore);
  marks.forEach((m) => {
    if (m.classList.contains("rl-img")) {
      m.addEventListener("click", (e) => {
        e.stopPropagation();
        focusComment(id);
      });
    } else {
      m.addEventListener("click", (e) => {
        e.stopPropagation();
        focusComment(id);
        updateNav();
      });
    }
  });
}

export function focusComment(id: string): void {
  document.querySelectorAll(".comment-card").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll("mark.rl-highlight").forEach((el) => el.classList.remove("active"));
  const card = document.getElementById("card-" + id);
  if (card) card.classList.add("active");
  document.querySelectorAll('[data-comment-id="' + id + '"]').forEach((el) => el.classList.add("active"));
  positionCards();
}

export function clearFocus(): void {
  document.querySelectorAll(".comment-card").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll("mark.rl-highlight").forEach((el) => el.classList.remove("active"));
  positionCards();
}

export function navigateTo(id: string): void {
  focusComment(id);
  positionCards();
  const mark = document.querySelector('[data-comment-id="' + id + '"]');
  if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function updateNav(): void {
  const nav = document.getElementById("comment-nav")!;
  const countEl = document.getElementById("nav-count")!;
  const prevBtn = document.getElementById("nav-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("nav-next") as HTMLButtonElement;
  const activeCard = document.querySelector(".comment-card.active");
  const activeId = activeCard ? activeCard.id.replace(/^card-/, "") : null;
  const navState = computeNavState(state.comments, activeId, state.navIdx);
  state.navIdx = navState.navIdx;
  if (!navState.visible) {
    nav.style.display = "none";
    return;
  }
  nav.style.display = "flex";
  countEl.textContent = navState.countText;
  prevBtn.style.display = navState.showPrev ? "" : "none";
  prevBtn.textContent = "\u2191 Prev";
  prevBtn.disabled = navState.prevDisabled;
  nextBtn.style.display = "";
  nextBtn.textContent = navState.nextLabel;
  nextBtn.disabled = navState.nextDisabled;
}

export function renderComments(): void {
  const typing = captureTypingState();
  preserveScroll(() => {
    const sidebar = document.querySelector(".sidebar-col")!;

    const activeCard = sidebar.querySelector(".comment-card.active");
    const activeId = activeCard ? activeCard.id.replace(/^card-/, "") : null;

    sidebar.querySelectorAll(".comment-card").forEach((el) => el.remove());

    state.comments.forEach((comment) => {
      sidebar.appendChild(buildCommentCard(comment));
    });

    if (activeId) {
      const restored = document.getElementById("card-" + activeId);
      if (restored) restored.classList.add("active");
      document
        .querySelectorAll('mark.rl-highlight[data-comment-id="' + activeId + '"]')
        .forEach((el) => el.classList.add("active"));
    }
  });
  observeCardSizes();
  restoreTypingState(typing);
}

export async function saveComment(
  form: HTMLElement,
  textarea: HTMLTextAreaElement,
  selection: Record<string, unknown>,
): Promise<void> {
  const message = textarea.value.trim();
  if (!message) {
    textarea.focus();
    textarea.style.borderColor = "var(--accent)";
    textarea.placeholder = "Type a comment first\u2026";
    return;
  }

  try {
    const res = await apiFetch("/api/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, message }),
    });
    const data = await res.json();
    if (data.ok) {
      form.remove();
      removePendingHighlight();
      if (!state.comments.some((c) => c.id === data.comment.id)) {
        state.comments.push(data.comment);
      }
      state.thinkingCommentIds.add(data.comment.id);
      state.pendingSelection = null;
      window.getSelection()?.removeAllRanges();
      renderComments();
      applyHighlights();
      applyRoundState();
      focusComment(data.comment.id);
      updateNav();
      const newCard = document.getElementById("card-" + data.comment.id);
      if (newCard) newCard.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      showError(data.error || "Failed to save comment");
    }
  } catch (err: unknown) {
    showError("Failed to save comment: " + (err as Error).message);
  }
}

export async function submitReply(id: string, message: string): Promise<void> {
  if (!message) return;
  try {
    const res = await apiFetch("/api/comment/" + id + "/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "human", message }),
    });
    const data = await res.json();
    if (data.ok) {
      const idx = state.comments.findIndex((c) => c.id === id);
      if (idx !== -1) state.comments[idx] = data.comment;
      state.thinkingCommentIds.add(id);
      renderComments();
      positionCards();
      updateNav();
    } else {
      showError(data.error || "Failed to save reply");
    }
  } catch (err: unknown) {
    showError("Failed to save reply: " + (err as Error).message);
  }
}

export async function resolveComment(id: string): Promise<void> {
  try {
    const res = await apiFetch("/api/comment/" + id + "/resolve", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      const c = state.comments.find((c) => c.id === id);
      if (c) c.resolved = true;
      state.navIdx = 0;
      renderComments();
      applyHighlights();
      positionCards();
      updateNav();
      applyRoundState();
      if (data.allResolved) {
        state.deliberateScrollUntil = Date.now() + 1200;
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } else {
      showError(data.error || "Failed to resolve comment");
    }
  } catch (err: unknown) {
    showError("Failed to resolve: " + (err as Error).message);
  }
}

export async function reopenComment(id: string): Promise<void> {
  try {
    const res = await apiFetch("/api/comment/" + id + "/reopen", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      const idx = state.comments.findIndex((c) => c.id === id);
      if (idx !== -1) state.comments[idx] = data.comment;
      renderComments();
      applyHighlights();
      positionCards();
      updateNav();
      applyRoundState();
    } else {
      showError(data.error || "Failed to reopen comment");
    }
  } catch (err: unknown) {
    showError("Failed to reopen: " + (err as Error).message);
  }
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

export function applyRoundState(): void {
  const btnAccept = document.getElementById("btn-accept") as HTMLButtonElement | null;
  const banner = document.getElementById("sidebar-status-banner");
  if (!btnAccept) return;

  const errorShowing = !!banner?.classList.contains("error");

  if (state.roundResolved) {
    document.getElementById("empty-rail-hint")?.remove();
    document.getElementById("round-secondary")?.remove();
    btnAccept.disabled = true;
    btnAccept.textContent = "\u2713 Accepted";
    if (banner && !errorShowing) {
      banner.innerHTML =
        '<div class="revising-header"><span class="revising-spinner"></span><span>Revising the document<span class="revising-dots"><span>.</span><span>.</span><span>.</span></span></span></div><div id="revision-stream"></div>';
      banner.classList.add("revising");
      banner.style.display = "flex";
    }
    renderComments();
    positionCards();
    updateNav();
  } else if (state.comments.length === 0) {
    document.getElementById("round-secondary")?.remove();
    btnAccept.disabled = false;
    btnAccept.textContent = "Accept doc";
    btnAccept.dataset.mode = "finish";
    if (banner && !errorShowing) {
      banner.classList.remove("revising");
      banner.style.display = "none";
    }
    const hint = document.getElementById("empty-rail-hint");
    const isColdOpen = state.totalRounds <= 1;
    if (isColdOpen) {
      if (!hint) {
        const rail = document.querySelector(".sidebar-col");
        if (rail) {
          const el = document.createElement("div");
          el.id = "empty-rail-hint";
          el.className = "empty-rail-hint";
          el.textContent = "Select text to leave a comment.";
          rail.appendChild(el);
        }
      }
    } else if (hint) {
      hint.remove();
    }
  } else {
    document.getElementById("empty-rail-hint")?.remove();
    const hasOpen = state.comments.some((c) => !c.resolved);
    btnAccept.disabled = hasOpen;
    document.getElementById("round-secondary")?.remove();
    if (hasOpen) {
      btnAccept.dataset.mode = "accept";
      btnAccept.classList.remove("revise-tinted");
      btnAccept.textContent = "Revise document";
      if (banner && !errorShowing) {
        banner.classList.remove("revising");
        banner.style.display = "none";
      }
    } else {
      const verdicts = state.comments.map(latestVerdict);
      const reviseCount = verdicts.filter((v) => v === "revise").length;
      const total = verdicts.length;
      const anyRevise = reviseCount > 0;

      btnAccept.dataset.mode = anyRevise ? "accept" : "finish";
      btnAccept.textContent = anyRevise ? "Revise document" : "Accept as-is";

      if (banner && !errorShowing) {
        banner.classList.remove("revising");
        let bannerText: string;
        if (reviseCount === 0) {
          bannerText =
            total === 1
              ? "Comment answered in thread \u2014 no revision needed."
              : `All ${total} comments answered in thread \u2014 no revision needed.`;
        } else if (reviseCount === total) {
          bannerText =
            total === 1
              ? "Comment implies an edit \u2014 ready to revise."
              : `All ${total} comments imply edits \u2014 ready to revise.`;
        } else {
          bannerText = `${reviseCount} of ${total} comments imply edits.`;
        }
        banner.textContent = bannerText;
        banner.style.display = "block";
      }

      const sidebar = document.querySelector(".sidebar-col");
      if (sidebar) {
        const sec = document.createElement("div");
        sec.id = "round-secondary";
        sec.className = "round-secondary";
        const altLabel = anyRevise ? "accept as-is without revising" : "revise the document anyway";
        sec.innerHTML = `or <button id="round-secondary-btn">${altLabel}</button>`;
        banner?.insertAdjacentElement("afterend", sec) ?? sidebar.appendChild(sec);
        sec.querySelector("#round-secondary-btn")!.addEventListener("click", () => {
          if (anyRevise) {
            const msg =
              reviseCount === 1
                ? "1 comment suggested an edit. Accept anyway?"
                : `${reviseCount} comments suggested edits. Accept anyway?`;
            if (!confirm(msg)) return;
            triggerRoundAction("finish");
          } else {
            triggerRoundAction("accept");
          }
        });
      }
    }
  }
}

export async function triggerRoundAction(mode: string): Promise<void> {
  const btnAccept = document.getElementById("btn-accept") as HTMLButtonElement | null;
  const banner = document.getElementById("sidebar-status-banner");
  if (banner) {
    banner.classList.remove("error");
    banner.style.display = "none";
    banner.textContent = "";
  }
  const endpoint = mode === "finish" ? "/api/finish" : "/api/accept";
  const res = await apiFetch(endpoint, { method: "POST" });
  const data = await res.json();
  if (data.ok) {
    state.roundResolved = true;
    document.getElementById("round-secondary")?.remove();
    if (mode === "finish") {
      if (btnAccept) {
        btnAccept.disabled = true;
        btnAccept.textContent = "\u2713 Done";
      }
      if (banner) {
        banner.classList.remove("revising");
        banner.classList.remove("error");
        banner.textContent = "Review complete. Document is ready.";
        banner.style.display = "block";
      }
    } else {
      applyRoundState();
    }
  } else {
    alert(data.error || "Could not complete.");
  }
}

export { toggleReplyForm, positionCards };
