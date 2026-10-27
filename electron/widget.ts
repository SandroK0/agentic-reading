/**
 * Wraps a model-written widget fragment in a full page: theme tokens, base
 * control styles, and a small bridge that reports height and forwards ask().
 * Served from widget:// with its own CSP, inside an iframe sandboxed to
 * allow-scripts only (opaque origin, no access to the app or its APIs).
 */

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
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface: #f6f5f1; --text: #1f1e1d; --text-2: #5f5e5a; --muted: #8a8880;
  --border: rgba(0,0,0,.14); --accent: #185fa5; --accent-bg: #e6f1fb;
  --good: #3b6d11; --good-bg: #eaf3de; --warn: #854f0b; --warn-bg: #faeeda; --bad: #a32d2d; --bad-bg: #fcebeb;
  --c1: #eeedfe; --c1-text: #3c3489; --c2: #e1f5ee; --c2-text: #085041;
  --c3: #faece7; --c3-text: #712b13; --c4: #fbeaf0; --c4-text: #72243e;
  --mono: ui-monospace, "SF Mono", Menlo, monospace; --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #262624; --surface: #30302e; --text: #f0eee6; --text-2: #b4b2a9; --muted: #888780;
    --border: rgba(255,255,255,.16); --accent: #85b7eb; --accent-bg: #0c447c;
    --good: #97c459; --good-bg: #27500a; --warn: #ef9f27; --warn-bg: #633806; --bad: #f09595; --bad-bg: #791f1f;
    --c1: #3c3489; --c1-text: #cecbf6; --c2: #085041; --c2-text: #9fe1cb;
    --c3: #712b13; --c3-text: #f5c4b3; --c4: #72243e; --c4-text: #f4c0d1;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 14px; overflow-wrap: anywhere; }
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

export function widgetPage(fragment: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style><script>${BRIDGE}</script></head>
<body>${fragment}</body></html>`;
}
