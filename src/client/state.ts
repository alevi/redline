import type { ClientComment } from "./lib";

declare global {
  interface Window {
    __REDLINE__: {
      comments: ClientComment[];
      roundResolved: boolean;
      totalRounds: number;
      contextTitle: string;
      csrfToken: string;
    };
    hljs?: { highlightElement(el: HTMLElement): void };
    dismissContextBanner?: () => void;
  }
}

export const state = {
  comments: window.__REDLINE__.comments as ClientComment[],
  roundResolved: window.__REDLINE__.roundResolved,
  totalRounds: window.__REDLINE__.totalRounds,
  csrfToken: window.__REDLINE__.csrfToken || "",
  thinkingCommentIds: new Set<string>(),
  pendingSelection: null as PendingSelection | null,
  navIdx: 0,
  deliberateScrollUntil: 0,
};

export type PendingSelection = {
  quote: string;
  context_before: string;
  context_after: string;
  _rectTop?: number;
  _range?: Range;
  _img?: HTMLImageElement;
};

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  init = init || {};
  const m = (init.method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    init.headers = Object.assign({}, init.headers || {}, {
      "X-Redline-Token": state.csrfToken,
    });
  }
  return fetch(url, init);
}

export function showError(msg: string): void {
  const el = document.getElementById("error-banner");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}
