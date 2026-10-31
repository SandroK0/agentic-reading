import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentsSource, ExplainEvent, ExplainRequest, Explanation, Settings } from "../shared/types";
import { ContentsGenerator } from "./contents";
import { Explainer } from "./explainer";
import { createProviders } from "./llm";
import { runSelfTest } from "./selftest";
import { Store } from "./store";
import { WIDGET_CSP, widgetPage } from "./widget";

// Keep self-test runs from touching the real library and history.
if (process.env.VR_SELFTEST) app.setPath("userData", path.join(app.getPath("temp"), "agentic-reading-selftest"));

// The app used to be called Visual Reader. Copy its data (library, explanations,
// sidebar settings) over the first time, and leave the old folder as a backup.
const legacyData = path.join(app.getPath("appData"), "Visual Reader");
if (
  !process.env.VR_SELFTEST &&
  !fs.existsSync(path.join(app.getPath("userData"), "state.json")) &&
  fs.existsSync(path.join(legacyData, "state.json"))
) {
  fs.cpSync(legacyData, app.getPath("userData"), { recursive: true });
}

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const store = new Store(path.join(app.getPath("userData"), "state.json"));
const providers = createProviders({ workDir: path.join(app.getPath("userData"), "claude-workdir") });
const explainer = new Explainer(providers);
const contentsGenerator = new ContentsGenerator(providers);

/** Widget HTML by explanation id, served at widget://w/<id>. */
const widgets = new Map<string, string>();
for (const e of store.allExplanations()) rememberWidgets(e);

/** Makes an explanation's drawings, follow-ups included, servable at widget://w/<id>. */
function rememberWidgets(e: Explanation) {
  widgets.set(e.id, e.html);
  for (const f of e.followUps ?? []) widgets.set(f.id, f.html);
}

let win: BrowserWindow | null = null;
let pendingOpen: string | null = process.argv.find((a) => a.toLowerCase().endsWith(".pdf")) ?? null;

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "widget", privileges: { standard: true, secure: true } },
]);

function registerProtocols() {
  // The renderer is served from app:// rather than file:// so PDF.js's worker
  // and font fetches are same-origin.
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  protocol.handle("widget", (req) => {
    const url = new URL(req.url);
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const html = widgets.get(id);
    if (html === undefined) return new Response("Not found", { status: 404 });
    return new Response(widgetPage(html, url.searchParams.get("theme")), {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": WIDGET_CSP },
    });
  });
}

/** Links open in the real browser and nothing navigates the app; only the panel pop-out may open a window. */
function lockDown(contents: Electron.WebContents) {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === "about:blank" && frameName === "explanations") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 860,
          minWidth: 360,
          minHeight: 400,
          title: "Explanations",
          ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
        },
      };
    }
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e) => e.preventDefault());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Agentic Reading",
    backgroundColor: "#f6f5f1",
    // On macOS the toolbar doubles as the title bar, with the window buttons inset into it.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep rendering pages and streaming explainers while the window is behind others.
      backgroundThrottling: false,
    },
  });

  // Links in explainers open in the real browser; nothing navigates the app.
  lockDown(win.webContents);
  // The Explanations panel can pop out into its own window; the renderer moves the panel into it.
  win.webContents.on("did-create-window", (child) => lockDown(child.webContents));
  win.webContents.on("did-finish-load", () => {
    if (process.env.VR_SELFTEST) {
      void runSelfTest(win!, sendOpen, (code) => app.exit(code));
      return;
    }
    if (pendingOpen) sendOpen(pendingOpen);
    pendingOpen = null;
  });
  // The toolbar leaves room for the window buttons, except in full screen where macOS hides them.
  win.on("enter-full-screen", () => win?.webContents.send("window:fullscreen", true));
  win.on("leave-full-screen", () => win?.webContents.send("window:fullscreen", false));
  win.on("closed", () => {
    win = null;
    // A popped-out panel has nothing to show without the reader.
    for (const other of BrowserWindow.getAllWindows()) other.close();
  });
  void win.loadURL("app://reader/index.html");
}

function sendOpen(bookPath: string) {
  if (!win) {
    pendingOpen = bookPath;
    return;
  }
  win.webContents.send("book:open", bookPath);
}

async function openWithDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog(win!, {
    title: "Open a PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const recent = store.recents();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: async () => {
              const picked = await openWithDialog();
              if (picked) sendOpen(picked);
            },
          },
          {
            label: "Open recent",
            submenu: recent.length
              ? recent.map((p) => ({ label: path.basename(p), click: () => sendOpen(p) }))
              : [{ label: "No recent books", enabled: false }],
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function assertPdf(bookPath: unknown): string {
  if (typeof bookPath !== "string" || !path.isAbsolute(bookPath) || !bookPath.toLowerCase().endsWith(".pdf")) {
    throw new Error("Not a PDF path");
  }
  return bookPath;
}

function registerIpc() {
  ipcMain.handle("book:open-dialog", () => openWithDialog());
  ipcMain.handle("book:read", async (_e, bookPath: string) => {
    const file = assertPdf(bookPath);
    const bytes = await fs.promises.readFile(file);
    store.touchRecent(file);
    buildMenu();
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });
  ipcMain.handle("book:recents", () => store.recents());
  ipcMain.handle("book:state", (_e, bookPath: string) => store.bookState(assertPdf(bookPath)));
  ipcMain.handle("book:save-page", (_e, bookPath: string, page: number) => store.savePage(assertPdf(bookPath), page));
  ipcMain.handle("explanation:save", (_e, bookPath: string, explanation: Explanation) => {
    rememberWidgets(explanation);
    store.saveExplanation(assertPdf(bookPath), explanation);
  });
  ipcMain.handle("explanation:delete", (_e, bookPath: string, id: string) => {
    widgets.delete(id);
    store.deleteExplanation(assertPdf(bookPath), id);
  });
  ipcMain.handle("settings:get", () => store.settings());
  ipcMain.handle("settings:save", (_e, settings: Settings) => store.saveSettings(settings));

  ipcMain.handle("explain:start", (e, req: ExplainRequest) => {
    const emit = (event: ExplainEvent) => {
      if (event.type === "done") widgets.set(event.id, event.html);
      if (!e.sender.isDestroyed()) e.sender.send("explain:event", event);
    };
    const bookPath = assertPdf(req.bookPath);
    const parent = req.parentId ? store.bookState(bookPath).explanations.find((x) => x.id === req.parentId) : undefined;
    void explainer.explain(req, store.settings(), parent, emit);
  });
  ipcMain.handle("explain:cancel", (_e, id: string) => explainer.cancel(id));
  ipcMain.handle("llm:providers", () => explainer.catalog());

  ipcMain.handle("contents:generate", async (_e, bookPath: string, source: ContentsSource) => {
    const file = assertPdf(bookPath);
    const contents = await contentsGenerator.generate(file, source, store.settings());
    store.saveGeneratedContents(file, contents);
    return contents;
  });
  ipcMain.handle("contents:cancel", (_e, bookPath: string) => contentsGenerator.cancel(assertPdf(bookPath)));
  ipcMain.handle("contents:remove", (_e, bookPath: string) => store.saveGeneratedContents(assertPdf(bookPath), null));
}

// macOS "Open with" / dropping a PDF on the Dock icon.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  sendOpen(filePath);
});

app.whenReady().then(() => {
  registerProtocols();
  registerIpc();
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  explainer.cancelAll();
  contentsGenerator.cancelAll();
});
