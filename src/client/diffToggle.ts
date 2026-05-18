// Pure helpers for the inline-diff toggle. Kept in their own module so they
// can be unit-tested without pulling in render.ts (which expects a populated
// window.__REDLINE__ at module-load time).

export function diffStateKey(contextTitle: string): string {
  return "rl-diff-on-" + contextTitle;
}

export function updateToggleButton(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "Hide changes" : "Show changes";
}

// Swap prose contents into diff view. Returns the previous innerHTML so the
// caller can restore it later, or null if the prose is already in diff mode
// (we don't want to clobber the saved-original by overwriting it with the
// diff HTML we just installed).
export function applyDiffSwap(
  prose: HTMLElement,
  diffHtml: string,
): string | null {
  if (prose.dataset.diffMode === "on") return null;
  const previous = prose.innerHTML;
  prose.innerHTML = diffHtml;
  prose.dataset.diffMode = "on";
  return previous;
}

export function revertDiffSwap(
  prose: HTMLElement,
  originalHtml: string,
): boolean {
  if (prose.dataset.diffMode !== "on") return false;
  prose.innerHTML = originalHtml;
  prose.dataset.diffMode = "off";
  return true;
}
