/** How long after the pointer leaves the top before the toolbar rests, and how near the top brings it back. */
const REST_AFTER_MS = 2500;
const WAKE_ZONE_PX = 72;

/**
 * Reading an EPUB, the toolbar rests (fades into the page colour; see
 * body.reading-focus in style.css) a couple of seconds after the pointer
 * leaves the top of the window, and wakes when it comes back or something in
 * it gets keyboard focus. It stays awake while `isBusy` (a menu or the
 * selection menu is open), and never rests unless `canRest` (an EPUB is open).
 */
export function restingToolbar(toolbar: HTMLElement, opts: { canRest: () => boolean; isBusy: () => boolean }) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rest = () => {
    if (!opts.canRest()) return;
    const busy = toolbar.matches(":hover") || toolbar.contains(document.activeElement) || opts.isBusy();
    if (busy) timer = setTimeout(rest, REST_AFTER_MS);
    else document.body.classList.add("reading-focus");
  };
  const wake = () => {
    document.body.classList.remove("reading-focus");
    clearTimeout(timer);
    timer = setTimeout(rest, REST_AFTER_MS);
  };

  document.addEventListener("mousemove", (e) => {
    if (e.clientY < WAKE_ZONE_PX) wake();
  });
  document.addEventListener("focusin", (e) => {
    if (toolbar.contains(e.target as Node)) wake();
  });

  return {
    /** Shows the toolbar now (a book opened or closed) and starts the wait before it rests again. */
    wake,
  };
}
