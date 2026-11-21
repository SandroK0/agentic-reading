/**
 * The text under `root` with every run of whitespace as one space, and ways
 * to go between a stretch of it and the document: a Range for a stretch, and
 * the position of a point (a selection's start or end). Finding passages,
 * searching the book and highlights all match against this.
 */
export interface TextIndex {
  flat: string;
  /** The Range covering flat[start..end). */
  range(start: number, end: number): Range;
  /** Where a point in the document falls in `flat`; points before or after `root` clamp to its ends. */
  offsetOf(node: Node, offset: number): number;
}

export function textIndex(root: Element): TextIndex {
  let flat = "";
  const owners: { node: Text; offset: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      const c = /\s/.test(text[i]) ? " " : text[i];
      if (c === " " && flat.endsWith(" ")) continue;
      flat += c;
      owners.push({ node, offset: i });
    }
  }

  return {
    flat,
    range(start, end) {
      const range = document.createRange();
      range.setStart(owners[start].node, owners[start].offset);
      range.setEnd(owners[end - 1].node, owners[end - 1].offset + 1);
      return range;
    },
    offsetOf(node, offset) {
      if (!root.contains(node)) {
        const before = root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING;
        return before ? 0 : flat.length;
      }
      // A point between elements: it sits before the child at `offset`, or at the very end of `node`.
      const point = document.createRange();
      point.setStart(node, offset);
      // The first character at or after the point.
      const at = owners.findIndex((o) => point.comparePoint(o.node, o.offset) >= 0);
      return at < 0 ? flat.length : at;
    },
  };
}
