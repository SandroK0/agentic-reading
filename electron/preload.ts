import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ExplainEvent, ReaderApi } from "../shared/types";

const api: ReaderApi = {
  openDialog: () => ipcRenderer.invoke("book:open-dialog"),
  pathForFile: (file) => webUtils.getPathForFile(file),
  readBook: (path) => ipcRenderer.invoke("book:read", path),
  recentBooks: () => ipcRenderer.invoke("book:recents"),
  library: () => ipcRenderer.invoke("book:library"),
  saveBookInfo: (path, info) => ipcRenderer.invoke("book:save-info", path, info),
  bookState: (path) => ipcRenderer.invoke("book:state", path),
  savePage: (path, page) => ipcRenderer.invoke("book:save-page", path, page),
  saveExplanation: (path, explanation) => ipcRenderer.invoke("explanation:save", path, explanation),
  deleteExplanation: (path, id) => ipcRenderer.invoke("explanation:delete", path, id),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  providers: () => ipcRenderer.invoke("llm:providers"),
  generateContents: (path, source) => ipcRenderer.invoke("contents:generate", path, source),
  cancelContents: (path) => ipcRenderer.invoke("contents:cancel", path),
  removeContents: (path) => ipcRenderer.invoke("contents:remove", path),
  explain: (request) => ipcRenderer.invoke("explain:start", request),
  cancel: (id) => ipcRenderer.invoke("explain:cancel", id),
  onExplainEvent: (listener) => {
    ipcRenderer.on("explain:event", (_e, event: ExplainEvent) => listener(event));
  },
  platform: process.platform,
  onFullscreen: (listener) => {
    ipcRenderer.on("window:fullscreen", (_e, fullscreen: boolean) => listener(fullscreen));
  },
  onOpenBook: (listener) => {
    ipcRenderer.on("book:open", (_e, path: string) => listener(path));
  },
  widgetUrl: (id, theme, scheme) => `widget://w/${encodeURIComponent(id)}?theme=${encodeURIComponent(theme)}&scheme=${scheme}`,
};

contextBridge.exposeInMainWorld("reader", api);
