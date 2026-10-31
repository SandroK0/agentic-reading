# Visual Reader

A desktop PDF reader that explains any passage. Select text, then choose **Explain** for a short written explanation or **Explain visually** for a drawing (a labelled diagram, flow or small chart) that appears next to the page.

It uses your Claude subscription through the [Claude Code](https://claude.com/claude-code) CLI you already have signed in. There's no API key and no separate account.

```
┌──────────────────────────────┬─────────────────────────┐
│ PDF page                     │ Explanations            │
│                              │ ┌─────────────────────┐ │
│  [selected passage]          │ │ p. 300 “The second… │ │
│  [Explain│Explain visually]  │ │ short explanation   │ │
│                              │ │ [drawing]           │ │
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
- **Read:** scroll through the book continuously, or jump a page with ‹ › or the ← → keys. Use − + to zoom. The app remembers your page in each book.
- **Explain a passage:** select text, then click **Explain** (`E`) for a few sentences, or **Explain visually** (`V`) for a drawing. **Explain this page** draws the whole page.
- **Follow up:** type a question under any explainer. Follow-ups continue the same conversation and keep its style, so Claude remembers the passage.
- **Pick a model** in the toolbar: Sonnet is faster, Opus gives the best results.
- Explainers are saved per book. Click a card's page badge to jump back to that page.

## How it works

| Piece | What it does |
| --- | --- |
| `electron/claude.ts` | Runs `claude -p` headless with streaming JSON output, no tools, no user or project settings and no MCP servers. It removes `ANTHROPIC_API_KEY` from the environment so the CLI uses your subscription. |
| `electron/prompt.ts` | The system prompts, one per mode: a short `<explanation>`, or a caption plus a static `<widget>` drawing and the design rules it follows |
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
