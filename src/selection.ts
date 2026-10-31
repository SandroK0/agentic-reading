/**
 * Mouse selection over the PDF text layers. A text layer is a pile of
 * absolutely positioned, transparent spans, so the browser's own drag
 * selection jumps whenever the pointer is over empty space (a margin, the gap
 * between lines or between pages): it extends to whatever span comes next in
 * the DOM, which can be anywhere on the page. Instead, a drag is tracked here.
 * Over text the caret lands where the pointer is; over empty space it snaps to
 * the nearest line, at its start when you're to the left and its end when
 * you're to the right. Double-click and shift-click are left to the browser.
 */

interface Caret {
  node: Text;
  offset: number;
}

interface Piece {
  text: Text;
  rect: DOMRect;
}

/** Distance from the viewer's top or bottom edge where dragging starts to scroll. */
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_MAX_SPEED = 24;

export function enableTextSelection(viewer: HTMLElement) {
  let anchor: Caret | null = null;
  let pointer = { x: 0, y: 0 };
  let scrollFrame = 0;

  const extend = () => {
    const focus = caretAt(viewer, pointer.x, pointer.y);
    if (anchor && focus) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };

  const autoscroll = () => {
    scrollFrame = 0;
    const box = viewer.getBoundingClientRect();
    const over = pointer.y - (box.bottom - AUTOSCROLL_EDGE);
    const under = box.top + AUTOSCROLL_EDGE - pointer.y;
    const speed = over > 0 ? Math.min(over, AUTOSCROLL_MAX_SPEED) : under > 0 ? -Math.min(under, AUTOSCROLL_MAX_SPEED) : 0;
    if (!anchor || speed === 0) return;
    viewer.scrollTop += speed;
    extend();
    scrollFrame = requestAnimationFrame(autoscroll);
  };

  const move = (e: MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    extend();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
  };

  const up = () => {
    anchor = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    document.removeEventListener("mousemove", move);
  };

  viewer.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.detail > 1 || e.shiftKey) return;
    if (!(e.target instanceof Element) || !e.target.closest(".textLayer")) return;
    const start = caretAt(viewer, e.clientX, e.clientY);
    if (!start) return;
    // Stop the browser's own drag selection; this one replaces it.
    e.preventDefault();
    anchor = start;
    pointer = { x: e.clientX, y: e.clientY };
    window.getSelection()?.collapse(start.node, start.offset);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  });
}

/** The text position for a point, snapping to the nearest line of the nearest drawn page. */
function caretAt(viewer: HTMLElement, x: number, y: number): Caret | null {
  const layer = layerNear(viewer, y);
  if (!layer) return null;
  const pieces = textPieces(layer);
  if (!pieces.length) return null;

  // Line boxes overlap a little in tight text, so pick the line whose middle is closest.
  const middle = (p: Piece) => p.rect.top + p.rect.height / 2;
  const ref = pieces.reduce((m, p) => (Math.abs(middle(p) - y) < Math.abs(middle(m) - y) ? p : m));
  const line = pieces
    .filter((p) => Math.abs(middle(p) - middle(ref)) < ref.rect.height / 2)
    .sort((a, b) => a.rect.left - b.rect.left);
  const inLine = y >= ref.rect.top && y <= ref.rect.bottom;
  if (x <= line[0].rect.left) return { node: line[0].text, offset: 0 };

  const piece = line.filter((p) => p.rect.left <= x).pop()!;
  const length = piece.text.length;
  if (x >= piece.rect.right) return { node: piece.text, offset: length };
  if (inLine) {
    const exact = document.caretPositionFromPoint(x, y);
    if (exact?.offsetNode === piece.text) return { node: piece.text, offset: exact.offset };
  }
  return { node: piece.text, offset: Math.round(((x - piece.rect.left) / piece.rect.width) * length) };
}

/** The drawn text layer under `y`, or the closest one above or below it. */
function layerNear(viewer: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const layer of viewer.querySelectorAll<HTMLElement>(".page .textLayer")) {
    const r = layer.getBoundingClientRect();
    const gap = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (gap < bestGap) {
      best = layer;
      bestGap = gap;
    }
  }
  return best;
}

function textPieces(layer: HTMLElement): Piece[] {
  const pieces: Piece[] = [];
  for (const span of layer.querySelectorAll("span")) {
    const text = span.firstChild;
    if (span.childNodes.length !== 1 || !(text instanceof Text) || !text.length) continue;
    const rect = span.getBoundingClientRect();
    if (rect.width && rect.height) pieces.push({ text, rect });
  }
  return pieces;
}
