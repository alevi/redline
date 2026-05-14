import { setCardCallbacks } from "./cards";
import {
  renderComments,
  applyHighlights,
  applyRoundState,
  focusComment,
  clearFocus,
  updateNav,
  navigateTo,
  positionCards,
  resolveComment,
  reopenComment,
  submitReply,
  toggleReplyForm,
} from "./render";
import { state } from "./state";
import { initSelectionHandlers } from "./selection";
import { initSSE } from "./sse";
import { enableDiffMode, initDiffHandlers } from "./diff";
import { diffStateKey } from "./diffToggle";
import { observeCardSizes } from "./cards";

// Wire card callbacks (breaks circular dependency between cards and render)
setCardCallbacks({
  focusComment,
  updateNav,
  positionCards,
  resolveComment,
  reopenComment,
  toggleReplyForm,
  submitReply,
});

// Click-to-clear-focus
document.addEventListener("click", (e) => {
  const inCard = (e.target as HTMLElement).closest(".comment-card, .new-comment-form");
  const inMark = (e.target as HTMLElement).closest("mark.rl-highlight");
  const inNav = (e.target as HTMLElement).closest("#comment-nav");
  if (!inCard && !inMark && !inNav) clearFocus();
});

// Nav buttons
document.getElementById("nav-prev")!.addEventListener("click", () => {
  const open = state.comments.filter((c) => !c.resolved);
  if (state.navIdx > 0) {
    state.navIdx--;
    navigateTo(open[state.navIdx]!.id);
    updateNav();
  }
});
document.getElementById("nav-next")!.addEventListener("click", () => {
  const open = state.comments.filter((c) => !c.resolved);
  if (open.length === 1) {
    navigateTo(open[0]!.id);
  } else if (state.navIdx < open.length - 1) {
    state.navIdx++;
    navigateTo(open[state.navIdx]!.id);
    updateNav();
  }
});

// Broken images
function swapBrokenImg(img: HTMLImageElement): void {
  const placeholder = document.createElement("div");
  placeholder.className = "broken-img";
  placeholder.textContent = "Image failed to load" + (img.alt ? ": " + img.alt : "");
  img.replaceWith(placeholder);
}
document.querySelectorAll("#prose img").forEach((img) => {
  const htmlImg = img as HTMLImageElement;
  htmlImg.addEventListener("error", () => swapBrokenImg(htmlImg));
  if (htmlImg.complete && htmlImg.naturalWidth === 0) swapBrokenImg(htmlImg);
});

// Syntax highlighting
if (window.hljs) {
  document.querySelectorAll('#prose pre code[class*="language-"]').forEach((el) => {
    try {
      window.hljs!.highlightElement(el as HTMLElement);
    } catch {
      /* unknown language */
    }
  });
}

// Initial render
renderComments();
applyHighlights();
positionCards();
updateNav();
applyRoundState();

const justRevised = sessionStorage.getItem("just-revised");
if (justRevised) sessionStorage.removeItem("just-revised");
const diffPersisted = (() => {
  try { return sessionStorage.getItem(diffStateKey(window.__REDLINE__.contextTitle)) === "1"; }
  catch { return false; }
})();
if (justRevised || diffPersisted) {
  void enableDiffMode();
}
if (sessionStorage.getItem("rl-no-changes")) {
  sessionStorage.removeItem("rl-no-changes");
  const banner = document.getElementById("sidebar-status-banner");
  if (banner) {
    banner.classList.remove("revising");
    banner.classList.remove("error");
    banner.textContent = "No changes \u2014 the document is unchanged.";
    banner.style.display = "block";
    setTimeout(() => {
      banner.style.display = "none";
    }, 5000);
  }
}

window.addEventListener("scroll", positionCards, { passive: true });
window.addEventListener("resize", positionCards, { passive: true });

import { initFirstRunBanner } from "./firstRunBanner";
initFirstRunBanner(document, window);

// Init subsystems
initSelectionHandlers();
initDiffHandlers();
initSSE();
