import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * The Contents sidebar, built from the PDF's outline (its bookmarks). Entries
 * jump to their page, and the section you're reading stays highlighted.
 */

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

interface Entry {
  page: number | null;
  link: HTMLButtonElement;
  /** Collapsible <li>s from the root down to this entry (inclusive when it has children). */
  branches: HTMLLIElement[];
}

/** Top levels with more entries than this start collapsed. */
const EXPAND_TOP_LEVEL_UP_TO = 10;

export class Contents {
  private entries: Entry[] = [];
  private active: Entry | null = null;
  private loadToken = 0;
  private currentPage = 1;

  constructor(
    private body: HTMLElement,
    private go: (page: number) => void,
  ) {}

  async load(doc: PDFDocumentProxy) {
    const token = ++this.loadToken;
    this.entries = [];
    this.active = null;
    this.body.replaceChildren(this.message("Loading contents…"));

    const outline = ((await doc.getOutline().catch(() => null)) ?? []) as OutlineNode[];
    const pages = await Promise.all(flatten(outline).map((node) => pageOf(doc, node.dest)));
    if (token !== this.loadToken) return;

    if (!outline.length) {
      this.body.replaceChildren(this.message("This PDF has no table of contents."));
      return;
    }
    const pageByNode = new Map(flatten(outline).map((node, i) => [node, pages[i]]));
    const expandTop = outline.length <= EXPAND_TOP_LEVEL_UP_TO;
    this.body.replaceChildren(this.list(outline, pageByNode, [], expandTop));
    this.setPage(this.currentPage);
  }

  clear() {
    this.loadToken++;
    this.entries = [];
    this.active = null;
    this.body.replaceChildren();
  }

  /** Highlights the last section that starts at or before `page`. */
  setPage(page: number) {
    this.currentPage = page;
    let best: Entry | null = null;
    for (const entry of this.entries) {
      if (entry.page !== null && entry.page <= page && (!best || entry.page >= best.page!)) best = entry;
    }
    if (best === this.active) return;
    this.active?.link.classList.remove("active");
    this.active = best;
    if (!best) return;
    best.link.classList.add("active");
    for (const li of best.branches) setOpen(li, true);
    best.link.scrollIntoView({ block: "nearest" });
  }

  private list(
    nodes: OutlineNode[],
    pageByNode: Map<OutlineNode, number | null>,
    parents: HTMLLIElement[],
    open: boolean,
  ): HTMLUListElement {
    const ul = document.createElement("ul");
    for (const node of nodes) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "toc-row";

      const twisty = document.createElement("button");
      twisty.className = "toc-twisty";
      const page = pageByNode.get(node) ?? null;
      const link = document.createElement("button");
      link.className = "toc-link";
      const title = document.createElement("span");
      title.textContent = node.title.trim() || "Untitled";
      const pageLabel = document.createElement("span");
      pageLabel.className = "toc-page";
      pageLabel.textContent = page ? String(page) : "";
      link.append(title, pageLabel);
      link.title = node.title.trim();
      if (page) link.onclick = () => this.go(page);
      else link.disabled = true;
      row.append(twisty, link);
      li.append(row);

      const branches = node.items.length ? [...parents, li] : parents;
      this.entries.push({ page, link, branches });

      if (node.items.length) {
        li.append(this.list(node.items, pageByNode, branches, false));
        twisty.setAttribute("aria-label", `Expand ${title.textContent}`);
        twisty.onclick = () => setOpen(li, !li.classList.contains("open"));
        setOpen(li, open);
      } else {
        twisty.classList.add("leaf");
        twisty.tabIndex = -1;
      }
      ul.append(li);
    }
    return ul;
  }

  private message(text: string) {
    const p = document.createElement("p");
    p.className = "toc-empty";
    p.textContent = text;
    return p;
  }
}

function setOpen(li: HTMLLIElement, open: boolean) {
  const child = li.querySelector(":scope > ul") as HTMLElement | null;
  const twisty = li.querySelector(":scope > .toc-row > .toc-twisty") as HTMLElement | null;
  if (!child || !twisty) return;
  li.classList.toggle("open", open);
  child.hidden = !open;
  twisty.textContent = open ? "▾" : "▸";
  twisty.setAttribute("aria-expanded", String(open));
}

function flatten(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.items ?? [])]);
}

/** Resolves an outline destination (named or explicit) to a 1-based page. */
async function pageOf(doc: PDFDocumentProxy, dest: OutlineNode["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : null;
    if (typeof ref === "number") return ref + 1;
    if (ref && typeof ref === "object") return (await doc.getPageIndex(ref as never)) + 1;
  } catch {
    // broken destination: leave the entry without a page
  }
  return null;
}
