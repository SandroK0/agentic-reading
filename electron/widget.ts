/**
 * Wraps a model-written widget fragment in a full page: theme tokens, base
 * control styles, and a small bridge that reports height and forwards ask().
 * Served from widget:// with its own CSP, inside an iframe sandboxed to
 * allow-scripts only (opaque origin, no access to the app or its APIs).
 */

import { themeById, themeCss } from "../shared/themes";

const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

export const WIDGET_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS}`,
  `font-src data: ${CDNS}`,
  "img-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

const BASE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.6 var(--font-ui); padding: 14px; overflow-wrap: anywhere; -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { font-weight: 500; margin: 0 0 .5em; } h3 { font-size: 15px; }
code, pre { font-family: var(--mono); font-size: 13px; }
button, input, select, textarea { font: inherit; color: var(--text); }
button { background: transparent; border: .5px solid var(--border); border-radius: var(--radius); padding: 5px 12px; cursor: pointer; }
button:hover { background: var(--surface); } button:active { transform: scale(.98); }
button:disabled { opacity: .45; cursor: default; }
input[type=text], input[type=number], select, textarea { background: var(--bg); border: .5px solid var(--border); border-radius: var(--radius); padding: 5px 8px; }
input[type=range] { accent-color: var(--accent); }
svg text { fill: var(--text); }
`;

const BRIDGE = `
(() => {
  const post = (msg) => parent.postMessage(msg, "*");
  window.ask = (question) => post({ type: "vr-ask", question: String(question) });
  const report = () => post({ type: "vr-height", height: Math.ceil(document.documentElement.scrollHeight) });
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
  addEventListener("error", (e) => post({ type: "vr-error", message: String(e.message || e) }));
})();
`;

/** A full widget page for `fragment`, in the reader's theme and light/dark palette so it matches what's around it. */
export function widgetPage(fragment: string, themeId: string | null, scheme: string | null): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${themeCss(themeById(themeId), ":root", scheme === "light" || scheme === "dark" ? scheme : undefined)}
${BASE_CSS}</style><script>${BRIDGE}</script></head>
<body>${fragment}</body></html>`;
}
