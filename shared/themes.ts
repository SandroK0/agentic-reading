/**
 * The app's themes, defined once. The renderer turns them into CSS for the
 * reader, and the main process turns them into CSS for explainer drawings, so
 * a drawing always matches the theme around it. Each theme has a light and a
 * dark palette and follows the system setting, unless it's `darkOnly`.
 */

export type ThemeId = "ink" | "night" | "graphite" | "forest";

export interface Theme {
  id: ThemeId;
  label: string;
  /** Always dark, whatever the system setting. */
  darkOnly?: boolean;
  light: Palette;
  dark: Palette;
}

/** CSS custom properties, without the leading "--". */
type Palette = Record<string, string>;

const SERIF = 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Status and categorical colours shared by every theme; themes override only what they need. */
const SHARED_LIGHT: Palette = {
  good: "#2f7a3b", "good-bg": "#e6f2e5",
  warn: "#8a5a0b", "warn-bg": "#f8eed9",
  bad: "#b42318", "bad-bg": "#fdecea",
  c1: "#e8ecfb", "c1-text": "#2a3a8c",
  c2: "#e3f4ef", "c2-text": "#155244",
  c3: "#fbece6", "c3-text": "#7a2e15",
  c4: "#f3e9fb", "c4-text": "#5b2a86",
  "page-filter": "none",
  shadow: "0 8px 24px rgba(15, 20, 30, 0.12), 0 1px 3px rgba(15, 20, 30, 0.08)",
  "font-ui": SANS,
  "font-prose": SANS,
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  radius: "8px",
  "card-radius": "12px",
  "toolbar-blur": "none",
  "menu-bg": "var(--bg)",
  "field-bg": "var(--canvas)",
  hover: "var(--surface)",
  "page-shadow": "0 0 0 0.5px rgba(15, 20, 30, 0.10), 0 2px 10px rgba(15, 20, 30, 0.07)",
};

const SHARED_DARK: Palette = {
  ...SHARED_LIGHT,
  good: "#7cc68a", "good-bg": "#183a21",
  warn: "#f0b44c", "warn-bg": "#3d2c0c",
  bad: "#f2918a", "bad-bg": "#4a1916",
  c1: "#26305e", "c1-text": "#c9d3ff",
  c2: "#143d33", "c2-text": "#a8e3d2",
  c3: "#4d2214", "c3-text": "#f6c6b3",
  c4: "#3a2152", "c4-text": "#e2c8f7",
  "page-filter": "brightness(0.92)",
  shadow: "0 10px 30px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4)",
  "menu-bg": "var(--surface)",
  "field-bg": "var(--bg)",
  hover: "rgba(255, 255, 255, 0.06)",
  "page-shadow": "0 0 0 0.5px rgba(255, 255, 255, 0.06), 0 4px 18px rgba(0, 0, 0, 0.45)",
};

export const THEMES: Theme[] = [
  {
    id: "ink",
    label: "Paper & Ink",
    light: {
      ...SHARED_LIGHT,
      bg: "#ffffff", canvas: "#eceff3", surface: "#f4f6f9", "toolbar-bg": "#ffffff",
      text: "#14171c", "text-2": "#535b67", muted: "#8a919c", border: "rgba(20, 30, 50, 0.12)",
      accent: "#2747d6", "on-accent": "#ffffff", "accent-bg": "#e7ecff", selection: "rgba(39, 71, 214, 0.22)",
      "font-prose": SERIF,
    },
    dark: {
      ...SHARED_DARK,
      bg: "#0d1117", canvas: "#080b10", surface: "#161b24", "toolbar-bg": "#0d1117",
      text: "#e6eaf0", "text-2": "#9aa4b2", muted: "#6b7482", border: "rgba(200, 215, 240, 0.12)",
      accent: "#7c9cff", "on-accent": "#0a1438", "accent-bg": "#1a2550", selection: "rgba(124, 156, 255, 0.32)",
      "font-prose": SERIF,
    },
  },
  {
    id: "night",
    label: "Night Library",
    darkOnly: true,
    light: {},
    dark: {
      ...SHARED_DARK,
      bg: "#0b0e14", canvas: "#07090d", surface: "#131821", "toolbar-bg": "#0b0e14",
      text: "#ebe7df", "text-2": "#a39e94", muted: "#706b63", border: "rgba(255, 236, 200, 0.10)",
      accent: "#f0b44c", "on-accent": "#2a1a00", "accent-bg": "#3a2a0e", selection: "rgba(240, 180, 76, 0.32)",
      // Soften white pages so they don't glare in the dark, a little warm, like lamplight.
      "page-filter": "brightness(0.82) sepia(0.12)",
      "font-prose": SERIF,
    },
  },
  {
    id: "graphite",
    label: "Graphite & Violet",
    light: {
      ...SHARED_LIGHT,
      bg: "#ffffff", canvas: "#f1f1f3", surface: "#f6f6f8", "toolbar-bg": "rgba(255, 255, 255, 0.72)",
      text: "#111113", "text-2": "#5d5d66", muted: "#8d8d96", border: "rgba(0, 0, 0, 0.09)",
      accent: "#7c5cff", "on-accent": "#ffffff", "accent-bg": "#efebff", selection: "rgba(124, 92, 255, 0.22)",
      radius: "6px", "card-radius": "10px", "toolbar-blur": "saturate(1.6) blur(18px)",
      "menu-bg": "rgba(255, 255, 255, 0.78)",
    },
    dark: {
      ...SHARED_DARK,
      bg: "#111113", canvas: "#0a0a0b", surface: "#19191c", "toolbar-bg": "rgba(17, 17, 19, 0.72)",
      text: "#ededef", "text-2": "#a0a0a8", muted: "#6f6f78", border: "rgba(255, 255, 255, 0.09)",
      accent: "#9b85ff", "on-accent": "#140a3a", "accent-bg": "#251c4d", selection: "rgba(155, 133, 255, 0.32)",
      radius: "6px", "card-radius": "10px", "toolbar-blur": "saturate(1.6) blur(18px)",
      "menu-bg": "rgba(30, 30, 34, 0.78)",
    },
  },
  {
    id: "forest",
    label: "Forest Study",
    light: {
      ...SHARED_LIGHT,
      bg: "#fbfcfa", canvas: "#e9eee8", surface: "#f1f5ef", "toolbar-bg": "#fbfcfa",
      text: "#17201c", "text-2": "#55625b", muted: "#87928b", border: "rgba(20, 50, 35, 0.12)",
      accent: "#1f6f5c", "on-accent": "#ffffff", "accent-bg": "#e2f1ec", selection: "rgba(31, 111, 92, 0.22)",
      "font-prose": SERIF, radius: "10px", "card-radius": "16px",
    },
    dark: {
      ...SHARED_DARK,
      bg: "#0f1513", canvas: "#0a0f0d", surface: "#17201d", "toolbar-bg": "#0f1513",
      text: "#e3ebe6", "text-2": "#9db0a6", muted: "#6c7d74", border: "rgba(200, 235, 215, 0.11)",
      accent: "#5fc1a4", "on-accent": "#062a20", "accent-bg": "#143a30", selection: "rgba(95, 193, 164, 0.3)",
      "font-prose": SERIF, radius: "10px", "card-radius": "16px",
    },
  },
];

export const DEFAULT_THEME: ThemeId = "ink";

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

function declarations(palette: Palette): string {
  return Object.entries(palette)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(" ");
}

/** CSS that applies `theme` to `selector`, following the system's light/dark setting unless it's dark-only. */
export function themeCss(theme: Theme, selector: string): string {
  if (theme.darkOnly) return `${selector} { color-scheme: dark; ${declarations(theme.dark)} }`;
  return [
    `${selector} { color-scheme: light; ${declarations(theme.light)} }`,
    `@media (prefers-color-scheme: dark) { ${selector} { color-scheme: dark; ${declarations(theme.dark)} } }`,
  ].join("\n");
}

/** CSS for every theme, each keyed on `:root[data-theme="…"]`. */
export function allThemesCss(): string {
  return THEMES.map((t) => themeCss(t, `:root[data-theme="${t.id}"]`)).join("\n");
}
