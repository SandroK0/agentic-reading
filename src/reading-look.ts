import { DEFAULT_MEASURE, MAX_MEASURE, MIN_MEASURE, type EpubLayout, type EpubMargins, type EpubView } from "./epub";
import { PAGE_COLORS, type PageColorId } from "../shared/themes";
import { closeWhenDismissed } from "./popover";
import { partsOf } from "./dom";

/**
 * The Aa menu: how an EPUB looks. Text size, a page colour laid over the app
 * theme (optionally Night whenever the Mac is dark), scrolling or one or two
 * pages, the text width (Scroll and Single), the font, and the Customize
 * sheet: spacing, margins, justification, hyphenation and bold text.
 *
 * Saved once for every book, unless a book is set to keep its own.
 */

export interface ReadingLook {
  /** The EPUB view's zoom; 1 is the base type size. */
  size: number;
  color: PageColorId;
  /** Use the Night page while the system is in dark mode, whatever `color` is. */
  autoNight: boolean;
  layout: EpubLayout;
  /** Line length in Scroll and Single, in ems. */
  width: number;
  font: string;
  lineHeight: number;
  /** Extra space between letters and between words, in hundredths of an em. */
  letterSpacing: number;
  wordSpacing: number;
  margins: EpubMargins;
  justify: boolean;
  hyphenate: boolean;
  bold: boolean;
}

const GLOBAL_KEY = "visual-reader:reading-look";
/** Looks kept by individual books, keyed by the book's path. */
const BOOKS_KEY = "visual-reader:reading-look-books";
const SIZE_STEP = 0.1;

const CUSTOMIZE_DEFAULTS = { lineHeight: 1.6, letterSpacing: 0, wordSpacing: 0, margins: "normal", justify: false, hyphenate: false, bold: false } as const;
const DEFAULTS: ReadingLook = {
  size: 1, color: "theme", autoNight: false, layout: "double", width: DEFAULT_MEASURE, font: "new-york", ...CUSTOMIZE_DEFAULTS,
};

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

const MARGIN_CHOICES: { id: EpubMargins; label: string }[] = [
  { id: "narrow", label: "Narrow" },
  { id: "normal", label: "Normal" },
  { id: "wide", label: "Wide" },
];

/** The custom properties a page colour sets on the reading area. */
const PAGE_VARS = { bg: "--epub-bg", text: "--epub-text", text2: "--epub-text-2", link: "--epub-link" } as const;

/** A saved look with anything missing or unknown put back to its default. */
function clean(saved: Partial<ReadingLook> | undefined): ReadingLook {
  const s = saved ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    size: num(s.size, DEFAULTS.size) > 0 ? num(s.size, DEFAULTS.size) : DEFAULTS.size,
    color: PAGE_COLORS.some((c) => c.id === s.color) ? s.color! : DEFAULTS.color,
    autoNight: bool(s.autoNight, DEFAULTS.autoNight),
    layout: LAYOUTS.some((l) => l.id === s.layout) ? s.layout! : DEFAULTS.layout,
    width: num(s.width, DEFAULTS.width),
    font: FONTS.some((f) => f.id === s.font) ? s.font! : DEFAULTS.font,
    lineHeight: num(s.lineHeight, DEFAULTS.lineHeight),
    letterSpacing: num(s.letterSpacing, DEFAULTS.letterSpacing),
    wordSpacing: num(s.wordSpacing, DEFAULTS.wordSpacing),
    margins: MARGIN_CHOICES.some((m) => m.id === s.margins) ? s.margins! : DEFAULTS.margins,
    justify: bool(s.justify, DEFAULTS.justify),
    hyphenate: bool(s.hyphenate, DEFAULTS.hyphenate),
    bold: bool(s.bold, DEFAULTS.bold),
  };
}

function read<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saving is fine; the menu still works for this session.
  }
}

/**
 * Builds the Aa menu and applies the saved look to `epub` straight away, so
 * the first book opens the way the last one was read. Text size goes through
 * `onSize`, because main also shows it in the page bar.
 */
export function setupReadingLook(opts: {
  /** Gets the page colour, font and Customize settings; the EPUB's styles read them from here. */
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
  let global = clean(read<Partial<ReadingLook>>(GLOBAL_KEY, {}));
  const books = read<Record<string, Partial<ReadingLook>>>(BOOKS_KEY, {});
  let bookPath: string | null = null;
  let look: ReadingLook = { ...global };
  const ownLook = () => !!bookPath && !!books[bookPath];
  const save = () => {
    if (ownLook()) {
      books[bookPath!] = { ...look };
      write(BOOKS_KEY, books);
    } else {
      global = { ...look };
      write(GLOBAL_KEY, global);
    }
  };

  const part = partsOf(opts.popover);
  const darkSystem = matchMedia("(prefers-color-scheme: dark)");

  // ---------- Applying the look to the page ----------

  const applyColor = () => {
    const id = look.autoNight && darkSystem.matches ? "night" : look.color;
    const vars = PAGE_COLORS.find((c) => c.id === id)?.vars;
    for (const [key, prop] of Object.entries(PAGE_VARS)) {
      if (vars) opts.area.style.setProperty(prop, vars[key as keyof typeof PAGE_VARS]);
      else opts.area.style.removeProperty(prop);
    }
  };
  darkSystem.addEventListener("change", () => look.autoNight && applyColor());

  const applyFont = () => opts.area.style.setProperty("--epub-font", FONTS.find((f) => f.id === look.font)!.stack);

  /** The Customize settings that change how text sets, which can change how many pages a section has. */
  let reflowTimer: ReturnType<typeof setTimeout> | undefined;
  const applyText = (reflow = true) => {
    const style = opts.area.style;
    style.setProperty("--epub-line-height", String(look.lineHeight));
    style.setProperty("--epub-letter-spacing", look.letterSpacing ? `${look.letterSpacing / 100}em` : "normal");
    style.setProperty("--epub-word-spacing", look.wordSpacing ? `${look.wordSpacing / 100}em` : "normal");
    style.setProperty("--epub-align", look.justify ? "justify" : "start");
    style.setProperty("--epub-hyphens", look.hyphenate ? "auto" : "manual");
    style.setProperty("--epub-weight", look.bold ? "600" : "400");
    if (!reflow) return;
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => opts.epub.relayout(), 60);
  };

  /**
   * Everything at once. `live` is for a book that's already showing (going
   * back to the usual look from its own): it reflows and tells main about
   * the size and layout. Otherwise (startup, or a book about to load) the
   * settings are just set, and the book lays out with them as it loads.
   */
  const applyAll = (live: boolean) => {
    applyColor();
    applyFont();
    applyText(live);
    opts.epub.setMeasure(look.width);
    opts.epub.setMargins(look.margins);
    opts.epub.setLayout(look.layout);
    if (live) {
      opts.onSize(look.size);
      opts.onLayoutChanged();
    } else {
      opts.epub.setZoom(look.size);
    }
    sync();
  };

  // ---------- Controls ----------

  const radio = (cls: string, label: string, onPick: () => void) => {
    const b = document.createElement("button");
    b.className = cls;
    b.setAttribute("role", "radio");
    b.title = label;
    b.onclick = onPick;
    return b;
  };
  const checkAll = (group: HTMLElement, isChecked: (b: HTMLElement) => boolean) => {
    for (const b of group.children) b.setAttribute("aria-checked", String(isChecked(b as HTMLElement)));
  };

  const colors = part("look-colors");
  colors.replaceChildren(
    ...PAGE_COLORS.map((c) => {
      const b = radio("look-color", `${c.label} page`, () => {
        look.color = c.id;
        applyColor();
        sync();
        save();
      });
      b.dataset.id = c.id;
      const swatch = document.createElement("i");
      swatch.textContent = "Aa";
      swatch.style.background = c.vars?.bg ?? "var(--bg)";
      swatch.style.color = c.vars?.text ?? "var(--text)";
      b.append(swatch, c.label);
      return b;
    }),
  );

  const layouts = part("look-layouts");
  layouts.replaceChildren(
    ...LAYOUTS.map((l) => {
      const b = radio("look-layout", l.label, () => {
        look.layout = l.id;
        sync();
        save();
        opts.epub.setLayout(l.id);
        opts.onLayoutChanged();
      });
      b.dataset.id = l.id;
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${l.icon}</svg>`;
      b.append(l.label);
      return b;
    }),
  );

  // Width only means something with one column of text; two pages size themselves to the window.
  const width = part<HTMLInputElement>("look-width");
  width.min = String(MIN_MEASURE);
  width.max = String(MAX_MEASURE);
  width.oninput = () => {
    look.width = Number(width.value);
    opts.epub.setMeasure(look.width);
  };
  width.onchange = save;

  const fonts = part("look-fonts");
  fonts.replaceChildren(
    ...FONTS.map((f) => {
      const b = radio("model-option", f.label, () => {
        look.font = f.id;
        applyFont();
        sync();
        save();
        opts.epub.relayout();
      });
      b.dataset.id = f.id;
      const name = document.createElement("span");
      name.textContent = f.label;
      name.style.fontFamily = f.stack;
      b.append(name);
      b.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>');
      return b;
    }),
  );

  const margins = part("look-margins");
  margins.replaceChildren(
    ...MARGIN_CHOICES.map((m) => {
      const b = radio("", `${m.label} margins`, () => {
        look.margins = m.id;
        sync();
        save();
        opts.epub.setMargins(m.id);
      });
      b.dataset.id = m.id;
      b.textContent = m.label;
      return b;
    }),
  );

  const slider = (id: string, key: "lineHeight" | "letterSpacing" | "wordSpacing") => {
    const input = part<HTMLInputElement>(id);
    input.oninput = () => {
      look[key] = Number(input.value);
      applyText();
      sync();
    };
    input.onchange = save;
    return input;
  };
  const line = slider("look-line", "lineHeight");
  const letter = slider("look-letter", "letterSpacing");
  const word = slider("look-word", "wordSpacing");
  const percent = (n: number) => (n === 0 ? "Default" : `${n > 0 ? "+" : ""}${n}%`);

  /** An on/off setting: `apply` puts the new value on the page. */
  const toggle = (id: string, key: "justify" | "hyphenate" | "bold" | "autoNight", apply: () => void) => {
    const b = part<HTMLButtonElement>(id);
    b.onclick = () => {
      look[key] = !look[key];
      apply();
      sync();
      save();
    };
    return b;
  };
  const switches = {
    justify: toggle("look-justify", "justify", applyText),
    hyphenate: toggle("look-hyphenate", "hyphenate", applyText),
    bold: toggle("look-bold", "bold", applyText),
    autoNight: toggle("look-auto-night", "autoNight", applyColor),
  };

  // "Only for this book": a book starts its own look from the usual one; turning it off goes back to the usual one.
  const thisBook = part<HTMLButtonElement>("look-this-book");
  thisBook.onclick = () => {
    if (!bookPath) return;
    if (ownLook()) {
      delete books[bookPath];
      write(BOOKS_KEY, books);
      look = { ...global };
      applyAll(true);
    } else {
      books[bookPath] = { ...look };
      write(BOOKS_KEY, books);
      sync();
    }
  };

  part("look-reset").onclick = () => {
    look = { ...look, ...CUSTOMIZE_DEFAULTS };
    applyText();
    opts.epub.setMargins(look.margins);
    sync();
    save();
  };

  const smaller = part<HTMLButtonElement>("look-smaller");
  const larger = part<HTMLButtonElement>("look-larger");
  const nudgeSize = (by: number) => opts.onSize(Math.round((look.size + by) * 100) / 100);
  smaller.onclick = () => nudgeSize(-SIZE_STEP);
  larger.onclick = () => nudgeSize(SIZE_STEP);

  /** Shows the look in every control. */
  function sync() {
    checkAll(colors, (b) => b.dataset.id === look.color);
    checkAll(layouts, (b) => b.dataset.id === look.layout);
    checkAll(fonts, (b) => b.dataset.id === look.font);
    checkAll(margins, (b) => b.dataset.id === look.margins);
    part("look-width-row").hidden = look.layout === "double";
    width.value = String(look.width);
    line.value = String(look.lineHeight);
    letter.value = String(look.letterSpacing);
    word.value = String(look.wordSpacing);
    part("look-line-label").textContent = `${look.lineHeight.toFixed(2)}×`;
    part("look-letter-label").textContent = percent(look.letterSpacing);
    part("look-word-label").textContent = percent(look.wordSpacing);
    for (const [key, b] of Object.entries(switches)) b.setAttribute("aria-checked", String(look[key as keyof typeof switches]));
    thisBook.setAttribute("aria-checked", String(ownLook()));
    thisBook.disabled = !bookPath;
  }

  // ---------- The menu and its Customize sheet ----------

  const main = part("look-main");
  const customize = part("look-customize");
  const showCustomize = (on: boolean) => {
    main.hidden = on;
    customize.hidden = !on;
  };
  part("look-open-customize").onclick = () => showCustomize(true);
  part("look-close-customize").onclick = () => showCustomize(false);

  const setOpen = (open: boolean) => {
    opts.popover.hidden = !open;
    if (!open) showCustomize(false);
    opts.button.setAttribute("aria-expanded", String(open));
    opts.button.setAttribute("aria-pressed", String(open));
  };
  opts.button.onclick = () => setOpen(opts.popover.hidden);
  closeWhenDismissed(opts.popover, opts.button, () => !opts.popover.hidden, () => setOpen(false));

  applyAll(false);

  return {
    /** Shows the menu for an EPUB, or hides it (and closes it) for anything else. */
    setAvailable(available: boolean) {
      opts.anchor.hidden = !available;
      if (!available) setOpen(false);
    },
    /**
     * The book about to open (null when one closes): applies its own look if
     * it keeps one, or the usual one. Call before it loads, so it opens that way.
     */
    setBook(path: string | null) {
      bookPath = path;
      look = clean(path && books[path] ? books[path] : global);
      applyAll(false);
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
