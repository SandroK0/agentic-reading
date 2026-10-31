/**
 * Drag handles that resize the sidebars. Each handle sits on a sidebar's inner
 * edge; dragging it changes that sidebar's width, double-clicking resets it,
 * and arrow keys nudge it when the handle has focus. Widths are remembered
 * per viewer, and always leave the page at least MIN_VIEWER wide.
 */

const MIN_VIEWER = 320;
const KEY_STEP = 16;

interface Options {
  /** Which side of the window the sidebar is on. */
  side: "left" | "right";
  min: number;
  initial: number;
  storageKey: string;
  /** The other sidebar, whose width also has to fit. */
  other: () => HTMLElement | null;
}

export function resizableSidebar(sidebar: HTMLElement, handle: HTMLElement, opts: Options) {
  const layout = sidebar.parentElement!;
  let width = load(opts.storageKey) ?? opts.initial;

  const max = () => {
    const other = opts.other();
    const otherWidth = other && !other.hidden ? other.offsetWidth : 0;
    return Math.max(opts.min, layout.clientWidth - otherWidth - MIN_VIEWER);
  };
  const apply = (w: number) => {
    width = Math.round(Math.min(Math.max(w, opts.min), max()));
    sidebar.style.width = `${width}px`;
    handle.setAttribute("aria-valuenow", String(width));
  };
  const commit = () => save(opts.storageKey, width);

  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", String(opts.min));
  handle.tabIndex = 0;
  apply(width);

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    // Explainer iframes would swallow the pointer while it passes over them.
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      apply(startWidth + (opts.side === "left" ? dx : -dx));
    };
    const up = () => {
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      commit();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });

  handle.addEventListener("dblclick", () => {
    apply(opts.initial);
    commit();
  });

  handle.addEventListener("keydown", (e) => {
    const grow = opts.side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = opts.side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    e.stopPropagation();
    apply(width + (e.key === grow ? KEY_STEP : -KEY_STEP));
    commit();
  });

  // Keep the page usable when the window gets smaller.
  window.addEventListener("resize", () => apply(width));
}

function load(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

function save(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // the width just won't persist
  }
}
