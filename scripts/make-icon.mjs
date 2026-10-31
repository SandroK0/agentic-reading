// Renders build/icon.svg to build/icon.png (1024px), which electron-builder turns into the app icon.
// Run with: npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";

app.whenReady().then(async () => {
  const svg = fs.readFileSync("build/icon.svg", "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace("<svg ", '<svg width="1024" height="1024" ')}`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  fs.writeFileSync("build/icon.png", image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
  console.log("wrote build/icon.png", image.getSize());
  app.quit();
});
