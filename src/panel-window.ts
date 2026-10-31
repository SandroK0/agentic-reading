/**
 * Where the Explanations panel lives: docked beside the page, in a window of
 * its own, or hidden. Popping out moves the panel's own DOM into a same-origin
 * window, so cards keep streaming and their handlers keep working with no
 * syncing; the window only needs the stylesheets, the theme, and the frame
 * messages forwarded. Closing that window docks the panel again.
 */

export type PanelPlace = "docked" | "window" | "hidden";

interface Options {
  /** Handles messages from explainer frames, wherever the panel is. */
  onFrameMessage: (e: MessageEvent) => void;
  /** Called after every move, with where the panel is now. */
  onChange: (place: PanelPlace) => void;
}

/** Window name the main process recognises when it allows the pop-out (electron/main.ts). */
const WINDOW_NAME = "explanations";
const HIDDEN_KEY = "visual-reader:panel-hidden";

export class PanelWindow {
  private popup: Window | null = null;
  private layout: HTMLElement;

  constructor(
    private panel: HTMLElement,
    private opts: Options,
  ) {
    this.layout = panel.parentElement!;
    if (load()) this.hide();
    else this.opts.onChange("docked");
  }

  get place(): PanelPlace {
    if (this.popup) return "window";
    return this.panel.hidden ? "hidden" : "docked";
  }

  popOut() {
    if (this.popup) {
      this.popup.focus();
      return;
    }
    const popup = window.open("about:blank", WINDOW_NAME);
    if (!popup) return;
    const doc = popup.document;
    doc.title = "Explanations";
    doc.documentElement.className = `${document.documentElement.className} panel-window`;
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
    for (const el of document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')) {
      const copy = el.cloneNode(true) as HTMLElement;
      // about:blank has no base URL of its own; point stylesheets at the app.
      if (copy instanceof HTMLLinkElement) copy.href = (el as HTMLLinkElement).href;
      doc.head.append(copy);
    }
    this.panel.hidden = false;
    doc.body.append(this.panel);
    popup.addEventListener("message", this.opts.onFrameMessage);
    // Closing the window puts the panel back (dock() closing it itself is a no-op here).
    popup.addEventListener("pagehide", () => {
      if (this.popup === popup) this.dock();
    });
    this.popup = popup;
    this.layout.classList.add("panel-away");
    this.opts.onChange("window");
  }

  dock() {
    const popup = this.popup;
    this.popup = null;
    this.layout.append(this.panel);
    this.panel.hidden = false;
    this.layout.classList.remove("panel-away");
    save(false);
    if (popup && !popup.closed) popup.close();
    this.opts.onChange("docked");
  }

  hide() {
    if (this.popup) this.dock();
    this.panel.hidden = true;
    this.layout.classList.add("panel-away");
    save(true);
    this.opts.onChange("hidden");
  }

  /** The toolbar button: hide when docked, show when hidden, bring the window forward when popped out. */
  toggle() {
    if (this.place === "window") this.popup!.focus();
    else if (this.place === "hidden") this.dock();
    else this.hide();
  }

  setTheme(id: string) {
    if (this.popup) this.popup.document.documentElement.dataset.theme = id;
  }

  setTitle(title: string) {
    if (this.popup) this.popup.document.title = title;
  }
}

function load(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

function save(hidden: boolean) {
  try {
    localStorage.setItem(HIDDEN_KEY, String(hidden));
  } catch {
    // the choice just won't persist
  }
}
