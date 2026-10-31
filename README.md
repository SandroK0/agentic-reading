# Agentic Reading

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
- **No contents in the PDF?** Click **Generate with AI** in the Contents sidebar. It reads the book's headings and any printed contents page, and the result is saved with the book. **Regenerate** and **Remove** sit at the top of the list.
- **Move the explanations:** the button at the top of the panel opens it in its own window (closing that window, or the same button, puts it back). × hides it; the **Explanations** button in the toolbar brings it back.
- **Pick a theme** in the toolbar: Paper & Ink, Graphite & Violet and Forest Study follow your system's light or dark mode; Night Library is always dark and dims the page. Drawings follow the theme. Themes live in `shared/themes.ts`.
- **Pick a model** in the toolbar: Sonnet is faster, Opus gives the best results.
- Explainers are saved per book. Click a card's page badge to jump back to that page.

## How it works

| Piece | What it does |
| --- | --- |
| `electron/explainer.ts` | Turns a request into an explanation with whichever provider is selected: builds the prompts, carries the conversation for follow-ups, streams progress and parses the reply |
| `electron/llm/provider.ts` | The `LlmProvider` interface, the only way the app talks to a model |
| `electron/llm/claude-cli.ts` | The Claude Code provider. Runs `claude -p` headless with streaming JSON output, no tools, no user or project settings and no MCP servers. It removes `ANTHROPIC_API_KEY` from the environment so the CLI uses your subscription, and resumes follow-ups from the CLI's session. |
| `electron/llm/index.ts` | The list of available providers |
| `electron/contents.ts` | Generates a table of contents for PDFs without one, through the same providers, and checks the reply |
| `src/contents-source.ts` | Reads the PDF for contents generation: the front pages' text, and heading-like lines picked out by font size |
| `electron/prompt.ts` | The system prompts, one per mode: a short `<explanation>`, or a caption plus a static `<widget>` drawing and the design rules it follows |
| `electron/widget.ts` | Wraps each widget with theme tokens and base styles. Each widget runs at `widget://` in an iframe sandboxed to `allow-scripts`, under a CSP that only allows cdnjs, jsDelivr and unpkg |
| `electron/main.ts` | Window, File menu, the `app://` and `widget://` protocols, and IPC |
| `electron/store.ts` | `state.json` in the app's data folder: recent books, page per book, saved explainers, settings |
| `src/main.ts` | The renderer: PDF.js viewer and text layer, selection, explainer cards with live streaming |

### Adding a model provider

Model access is behind one interface, so supporting a local model or an API means adding a provider, not changing the app:

1. Create `electron/llm/<name>.ts` with a class that implements `LlmProvider`: an `id`, a `label`, its `models` and a `chat()` method. `chat()` gets the system prompt and the whole conversation as messages, streams text through `onText`, and stops when `signal` aborts.
2. Add it to the list in `electron/llm/index.ts`.

The model menu groups models by provider once there's more than one. Conversations are saved as plain messages, so follow-ups keep working when someone switches provider. A provider that can resume a conversation more cheaply (like the Claude CLI's sessions) can return a `resume` handle; others can ignore it.

## Testing

```bash
npm run build
VR_SELFTEST="/path/to/book.pdf" VR_SELFTEST_PAGE=300 npx electron .
```

The self-test opens the book in a throwaway profile, selects part of the page and clicks Explain. It waits for the explainer and saves screenshots to `selftest-out/`, including the widget on its own. It makes one real request through your subscription. Set `VR_DEBUG=1` to log the CLI's events.
