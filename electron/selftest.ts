import type { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * End-to-end check, run with:
 *   VR_SELFTEST=<pdf> [VR_SELFTEST_PAGE=n] [VR_SELFTEST_OUT=dir] npx electron .
 * Opens the book, checks the contents sidebar, selects the first few lines of
 * the page, clicks "Explain visually", waits for the explainer, saves
 * screenshots and quits. VR_SELFTEST_NO_EXPLAIN=1 stops before calling Claude.
 */
export async function runSelfTest(win: BrowserWindow, open: (p: string) => void, quit: (code: number) => void) {
  const pdf = process.env.VR_SELFTEST!;
  const page = Number(process.env.VR_SELFTEST_PAGE ?? 1);
  const out = process.env.VR_SELFTEST_OUT ?? path.join(process.cwd(), "selftest-out");
  fs.mkdirSync(out, { recursive: true });

  win.webContents.on("console-message", (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const shot = async (name: string) => {
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log(`[selftest] saved ${name}.png`);
  };
  const waitFor = async (code: string, timeoutMs: number) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js<boolean>(code)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };

  try {
    open(pdf);
    if (!(await waitFor(`document.getElementById("page-total").textContent !== "/ –"`, 30_000))) throw new Error("book never opened");
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await waitFor(`document.getElementById("page-input").value === "${page}" && !!document.querySelector("#text-layer span")`, 15_000);
    await new Promise((r) => setTimeout(r, 1000));
    await shot("1-page");

    await waitFor(`!!document.querySelector(".toc-link") || !!document.querySelector(".toc-empty:not(:empty)")`, 15_000);
    const toc = await js<{ entries: number; top: number; active: string | null; activeVisible: boolean }>(`({
      entries: document.querySelectorAll(".toc-link").length,
      top: document.querySelectorAll("#toc-body > ul > li").length,
      active: document.querySelector(".toc-link.active")?.textContent ?? null,
      activeVisible: !!document.querySelector(".toc-link.active")?.offsetParent,
    })`);
    console.log("[selftest] contents:", JSON.stringify(toc));
    const jumped = await js<{ clicked: string | null; page: string }>(`(() => {
      const link = [...document.querySelectorAll(".toc-link")].find((l) => /segmentation/i.test(l.textContent) && !l.disabled);
      if (!link) return { clicked: null, page: "" };
      link.click();
      return { clicked: link.textContent, page: "" };
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    jumped.page = await js<string>(`document.getElementById("page-input").value`);
    const activeAfter = await js<string | null>(`document.querySelector(".toc-link.active")?.textContent ?? null`);
    console.log("[selftest] contents jump:", JSON.stringify({ ...jumped, activeAfter }));
    await shot("1b-contents-jump");
    if (process.env.VR_SELFTEST_NO_EXPLAIN) return quit(toc.entries > 0 && jumped.clicked ? 0 : 1);
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await waitFor(`document.getElementById("page-input").value === "${page}" && !!document.querySelector("#text-layer span")`, 15_000);

    const selected = await js<string>(`(() => {
      const spans = [...document.querySelectorAll("#text-layer span")].filter((s) => s.textContent.trim().length > 20);
      const first = spans[1] ?? spans[0], last = spans[Math.min(spans.length - 1, 6)];
      const r = document.createRange();
      r.setStart(first.firstChild, 0);
      r.setEnd(last.firstChild, last.textContent.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return sel.toString();
    })()`);
    console.log(`[selftest] selected: ${selected.slice(0, 120).replace(/\s+/g, " ")}…`);
    await new Promise((r) => setTimeout(r, 300));
    await shot("2-selection");

    await js(`document.getElementById("explain-float").click()`);
    const started = Date.now();
    await waitFor(`!!document.querySelector(".card .prose p")`, 120_000);
    await shot("3-streaming");
    const done = await waitFor(
      `!!document.querySelector(".card iframe") || !!document.querySelector(".card .status.error")`,
      240_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    await shot("4-explainer");

    const result = await js<{ error: string | null; prose: string; frameHeight: string | null }>(`({
      error: document.querySelector(".card .status.error")?.textContent ?? null,
      prose: document.querySelector(".card .prose")?.textContent ?? "",
      frameHeight: document.querySelector(".card iframe")?.style.height ?? null,
    })`);
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      if (!frame.url.startsWith("widget://")) continue;
      const inside = await frame
        .executeJavaScript(`({ text: document.body.innerText.slice(0, 200), svg: document.querySelectorAll("svg").length, buttons: document.querySelectorAll("button").length, scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color })`)
        .catch((e: Error) => ({ error: e.message }));
      console.log(`[selftest] widget frame ${frame.url}:`, JSON.stringify(inside));
      // capturePage() leaves out cross-origin frames, so shoot the widget on its own.
      const { BrowserWindow } = await import("electron");
      const solo = new BrowserWindow({ show: false, width: 436, height: 900, webPreferences: { sandbox: true } });
      await solo.loadURL(frame.url);
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(path.join(out, "5-widget.png"), (await solo.webContents.capturePage()).toPNG());
      console.log("[selftest] saved 5-widget.png");
      solo.destroy();
    }
    console.log(`[selftest] finished=${done} in ${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(result));
    quit(done && !result.error ? 0 : 1);
  } catch (err) {
    console.error("[selftest] failed:", err);
    await shot("error").catch(() => {});
    quit(1);
  }
}
