# Visual Reader

A desktop PDF reader that explains any passage visually. Select text, click **Explain visually**, and an interactive explainer (a stepper, calculator, diagram or small simulation) appears next to the page.

It uses your Claude subscription through the [Claude Code](https://claude.com/claude-code) CLI you already have signed in. There's no API key and no separate account.

```
┌──────────────────────────────┬─────────────────────────┐
│ PDF page                     │ Explanations            │
│                              │ ┌─────────────────────┐ │
│  [selected passage]          │ │ p. 300 “The second… │ │
│     └ Explain visually       │ │ short explanation   │ │
│                              │ │ [interactive widget]│ │
│                              │ │ Ask a follow-up…    │ │
└──────────────────────────────┴─┴─────────────────────┴─┘
```

## Run it

Requires Node 20+ and the `claude` CLI, installed and signed in (run `claude` once in a terminal if you haven't).

```bash
npm install
npm start          # builds, then opens the app
```

After the first build, `npx electron .` opens it without rebuilding.

## Use

- **Open a book:** click Open (⌘O), drop a PDF on the window, or use File → Open recent.
- **Read:** use ‹ › or the arrow keys to turn pages, and − + to zoom. The app remembers your page in each book.
- **Explain a passage:** select text, then click **Explain visually** (or press `E`). **Explain this page** does the whole page.
- **Follow up:** type a question under any explainer, or use an "Ask about this" button inside a widget. Follow-ups continue the same conversation, so Claude remembers the passage.
- **Pick a model** in the toolbar: Sonnet is faster, Opus gives the best results.
- Explainers are saved per book. Click a card's page badge to jump back to that page.

## How it works

| Piece | What it does |
| --- | --- |
| `electron/claude.ts` | Runs `claude -p` headless with streaming JSON output, no tools, no user or project settings and no MCP servers. It removes `ANTHROPIC_API_KEY` from the environment so the CLI uses your subscription. |
| `electron/prompt.ts` | The system prompt: output format (`<explanation>` plus `<widget>`) and the design rules widgets follow |
| `electron/widget.ts` | Wraps each widget with theme tokens and base styles. Each widget runs at `widget://` in an iframe sandboxed to `allow-scripts`, under a CSP that only allows cdnjs, jsDelivr and unpkg |
| `electron/main.ts` | Window, File menu, the `app://` and `widget://` protocols, and IPC |
| `electron/store.ts` | `state.json` in the app's data folder: recent books, page per book, saved explainers, settings |
| `src/main.ts` | The renderer: PDF.js viewer and text layer, selection, explainer cards with live streaming |

## Testing

```bash
npm run build
VR_SELFTEST="/path/to/book.pdf" VR_SELFTEST_PAGE=300 npx electron .
```

The self-test opens the book in a throwaway profile, selects part of the page and clicks Explain. It waits for the explainer and saves screenshots to `selftest-out/`, including the widget on its own. It makes one real request through your subscription. Set `VR_DEBUG=1` to log the CLI's events.
