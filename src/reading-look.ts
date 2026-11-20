import { DEFAULT_MEASURE, MAX_MEASURE, MIN_MEASURE, type EpubLayout, type EpubView } from "./epub";
import { PAGE_COLORS, type PageColorId } from "../shared/themes";
import { closeWhenDismissed } from "./popover";

/**
 * The Aa menu: how an EPUB looks. Text size, a page colour laid over the app
 * theme, scrolling or one or two pages, the text width (Scroll and Single),
 * and the font. Saved once, for every book.
 */

export interface ReadingLook {
  /** The EPUB view's zoom; 1 is the base type size. */
  size: number;
  color: PageColorId;
  layout: EpubLayout;
  /** Line length in Scroll and Single, in ems. */
  width: number;
  font: string;
}

const STORAGE_KEY = "visual-reader:reading-look";
const DEFAULTS: ReadingLook = { size: 1, color: "theme", layout: "double", width: DEFAULT_MEASURE, font: "new-york" };
const SIZE_STEP = 0.1;

/**
 * Fonts that ship with macOS, the ones Books offers. The app theme never
 * picks the book's font, so changing theme leaves the text as it was.
 */
const FONTS: { id: string; label: string; stack: string }[] = [
  { id: "new-york", label: "New York", stack: 'ui-serif, "New York", Georgia, serif' },
  { id: "charter", label: "Charter", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
  { id: "iowan", label: "Iowan Old Style", stack: '"Iowan Old Style", Georgia, serif' },
  { id: "palatino", label: "Palatino", stack: 'Palatino, "Palatino Linotype", serif' },
  { id: "athelas", label: "Athelas", stack: "Athelas, Georgia, serif" },
  { id: "georgia", label: "Georgia", stack: "Georgia, serif" },
  { id: "sf", label: "San Francisco", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: "avenir", label: "Avenir Next", stack: '"Avenir Next", Avenir, sans-serif' },
  { id: "seravek", label: "Seravek", stack: 'Seravek, "Avenir Next", sans-serif' },
];

const LAYOUTS: { id: EpubLayout; label: string; icon: string }[] = [
  { id: "scroll", label: "Scroll", icon: '<rect x="6" y="2.5" width="12" height="19" rx="1.5"/><path d="M9 7h6M9 10h6M9 13h6M9 16h4"/>' },
  { id: "single", label: "Single", icon: '<rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M9 8h6M9 11h6M9 14h4"/>' },
  { id: "double", label: "Two pages", icon: '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M12 5v14M5 9h4.5M5 12h4.5M14.5 9H19M14.5 12H19"/>' },
];

/** The custom properties a page colour sets on the reading area. */
const PAGE_VARS = { bg: "--epub-bg", text: "--epub-text", text2: "--epub-text-2", link: "--epub-link" } as const;

function load(): ReadingLook {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<ReadingLook>;
    return {
      size: typeof saved.size === "number" && saved.size > 0 ? saved.size : DEFAULTS.size,
      color: PAGE_COLORS.some((c) => c.id === saved.color) ? saved.color! : DEFAULTS.color,
      layout: LAYOUTS.some((l) => l.id === saved.layout) ? saved.layout! : DEFAULTS.layout,
      width: typeof saved.width === "number" && saved.width > 0 ? saved.width : DEFAULTS.width,
      font: FONTS.some((f) => f.id === saved.font) ? saved.font! : DEFAULTS.font,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Builds the Aa menu and applies the saved look to `epub` straight away, so
 * the first book opens the way the last one was read. Text size goes through
 * `onSize`, because main also shows it in the page bar.
 */
export function setupReadingLook(opts: {
  /** Gets the page colour and font; the EPUB's styles read them from here. */
  area: HTMLElement;
  anchor: HTMLElement;
  button: HTMLButtonElement;
  popover: HTMLElement;
  epub: EpubView;
  sizeLimits: { min: number; max: number };
  /** Asks for a new text size; main clamps and applies it, then reports back through sizeChanged. */
  onSize: (size: number) => void;
  /** After the layout changes, for anything that depends on it (the page-edge arrows). */
  onLayoutChanged: () => void;
}) {
  const look = load();
  const part = <T extends HTMLElement = HTMLElement>(id: string) => opts.popover.querySelector<T>(`#${id}`)!;
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(look));
    } catch {
      // Not saving is fine; the menu still works for this session.
    }
  };

  const radio = (cls: string, checked: boolean, label: string, onPick: () => void) => {
    const b = document.createElement("button");
    b.className = cls;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(checked));
    b.title = label;
    b.onclick = onPick;
    return b;
  };
  const check = (group: HTMLElement, picked: HTMLElement) => {
    for (const b of group.children) b.setAttribute("aria-checked", String(b === picked));
  };

  const applyColor = () => {
    const vars = PAGE_COLORS.find((c) => c.id === look.color)?.vars;
    for (const [key, prop] of Object.entries(PAGE_VARS)) {
      if (vars) opts.area.style.setProperty(prop, vars[key as keyof typeof PAGE_VARS]);
      else opts.area.style.removeProperty(prop);
    }
  };
  const applyFont = () => opts.area.style.setProperty("--epub-font", FONTS.find((f) => f.id === look.font)!.stack);

  const colors = part("look-colors");
  colors.replaceChildren(
    ...PAGE_COLORS.map((c) => {
      const b = radio("look-color", c.id === look.color, `${c.label} page`, () => {
        look.color = c.id;
        check(colors, b);
        applyColor();
        save();
      });
      const swatch = document.createElement("i");
      swatch.textContent = "Aa";
      swatch.style.background = c.vars?.bg ?? "var(--bg)";
      swatch.style.color = c.vars?.text ?? "var(--text)";
      b.append(swatch, c.label);
      return b;
    }),
  );

  // Width only means something with one column of text; two pages size themselves to the window.
  const widthRow = part("look-width-row");
  const width = part<HTMLInputElement>("look-width");
  const showWidth = () => (widthRow.hidden = look.layout === "double");
  width.min = String(MIN_MEASURE);
  width.max = String(MAX_MEASURE);
  width.value = String(look.width);
  width.oninput = () => {
    look.width = Number(width.value);
    opts.epub.setMeasure(look.width);
  };
  width.onchange = save;

  const layouts = part("look-layouts");
  layouts.replaceChildren(
    ...LAYOUTS.map((l) => {
      const b = radio("look-layout", l.id === look.layout, l.label, () => {
        look.layout = l.id;
        check(layouts, b);
        showWidth();
        save();
        opts.epub.setLayout(l.id);
        opts.onLayoutChanged();
      });
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${l.icon}</svg>`;
      b.append(l.label);
      return b;
    }),
  );

  const fonts = part("look-fonts");
  fonts.replaceChildren(
    ...FONTS.map((f) => {
      const b = radio("model-option", f.id === look.font, f.label, () => {
        look.font = f.id;
        check(fonts, b);
        applyFont();
        save();
      });
      const name = document.createElement("span");
      name.textContent = f.label;
      name.style.fontFamily = f.stack;
      b.append(name);
      b.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>');
      return b;
    }),
  );

  const smaller = part<HTMLButtonElement>("look-smaller");
  const larger = part<HTMLButtonElement>("look-larger");
  const nudgeSize = (by: number) => opts.onSize(Math.round((look.size + by) * 100) / 100);
  smaller.onclick = () => nudgeSize(-SIZE_STEP);
  larger.onclick = () => nudgeSize(SIZE_STEP);

  const setOpen = (open: boolean) => {
    opts.popover.hidden = !open;
    opts.button.setAttribute("aria-expanded", String(open));
    opts.button.setAttribute("aria-pressed", String(open));
  };
  opts.button.onclick = () => setOpen(opts.popover.hidden);
  closeWhenDismissed(opts.popover, opts.button, () => !opts.popover.hidden, () => setOpen(false));

  showWidth();
  applyColor();
  applyFont();
  opts.epub.setZoom(look.size);
  opts.epub.setLayout(look.layout);
  opts.epub.setMeasure(look.width);

  return {
    /** Shows the menu for an EPUB, or hides it (and closes it) for anything else. */
    setAvailable(available: boolean) {
      opts.anchor.hidden = !available;
      if (!available) setOpen(false);
    },
    /** The text size actually in use, after main clamped it; also called when the page bar's zoom changes it. */
    sizeChanged(size: number) {
      look.size = size;
      part("look-size-label").textContent = `${Math.round(size * 100)}%`;
      smaller.disabled = size <= opts.sizeLimits.min + 1e-6;
      larger.disabled = size >= opts.sizeLimits.max - 1e-6;
      save();
    },
  };
}
