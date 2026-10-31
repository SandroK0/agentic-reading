import type { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * End-to-end check, run with:
 *   VR_SELFTEST=<pdf> [VR_SELFTEST_PAGE=n] [VR_SELFTEST_OUT=dir] npx electron .
 * Opens the book, checks the contents sidebar, selects the first few lines of
 * the page, clicks "Explain visually", waits for the explainer, saves
 * screenshots and quits. VR_SELFTEST_NO_EXPLAIN=1 stops before calling Claude;
 * VR_SELFTEST_MODE=text uses Explain instead of Explain visually, and
 * VR_SELFTEST_FOLLOWUP=1 also asks a follow-up on the new card.
 * VR_SELFTEST_QUESTION="…" types a question into the selection menu first.
 * VR_SELFTEST_THEMES=1 screenshots every theme in light and dark.
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
    await waitFor(`document.getElementById("page-input").value === "${page}" && !!document.querySelector('.page[data-page=\"${page}\"] .textLayer span')`, 15_000);
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
    const scrolled = await js<{ before: string }>(`(() => {
      const v = document.getElementById("viewer");
      const before = document.getElementById("page-input").value;
      v.scrollTop += v.clientHeight * 2.5;
      return { before };
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const afterScroll = await js<{ page: string; drawn: number; pages: number }>(`({
      page: document.getElementById("page-input").value,
      drawn: document.querySelectorAll(".page canvas").length,
      pages: document.querySelectorAll(".page").length,
    })`);
    console.log("[selftest] scroll:", JSON.stringify({ ...scrolled, ...afterScroll }));
    await shot("1c-scrolled");

    // Ctrl + scroll zooms around the pointer: the zoom changes and the text under the pointer stays put.
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await new Promise((r) => setTimeout(r, 1000));
    const probe = `(() => {
      const v = document.getElementById("viewer").getBoundingClientRect();
      const x = v.left + v.width / 2, y = v.top + v.height * 0.6;
      const caret = document.caretPositionFromPoint(x, y);
      const span = caret?.offsetNode?.parentElement;
      return { x, y, zoom: document.getElementById("zoom-label").textContent, text: span?.textContent?.slice(0, 30) ?? null };
    })()`;
    const unzoomed = await js<{ x: number; y: number; zoom: string; text: string | null }>(probe);
    for (let i = 0; i < 4; i++) {
      win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(unzoomed.x), y: Math.round(unzoomed.y), deltaX: 0, deltaY: 120, modifiers: ["control"] });
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 600));
    const zoomed = await js<{ zoom: string; text: string | null }>(probe);
    const zoomOk = zoomed.zoom !== unzoomed.zoom && !!unzoomed.text && zoomed.text === unzoomed.text;
    console.log(`[selftest] ctrl+scroll zoom: ok=${zoomOk} ${JSON.stringify({ unzoomed, zoomed })}`);
    await shot("1e-zoomed");
    // The same notches the other way undo the zoom exactly, since each one scales by a fixed factor.
    for (let i = 0; i < 4; i++) {
      win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(unzoomed.x), y: Math.round(unzoomed.y), deltaX: 0, deltaY: -120, modifiers: ["control"] });
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 600));

    // Drag both sidebar handles with the mouse; the page should re-fit to the new width.
    const sidebarDrag = async (handle: string, dx: number) => {
      const at = await js<[number, number]>(`(() => { const r = document.getElementById("${handle}").getBoundingClientRect(); return [r.left, r.top + 200]; })()`);
      const send = (type: "mouseDown" | "mouseMove" | "mouseUp", x: number) =>
        win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(at[1]), button: "left", clickCount: 1, modifiers: type === "mouseMove" ? ["leftbuttondown"] : [] });
      send("mouseDown", at[0]);
      for (let i = 1; i <= 10; i++) {
        send("mouseMove", at[0] + (dx * i) / 10);
        await new Promise((r) => setTimeout(r, 16));
      }
      send("mouseUp", at[0] + dx);
    };
    const widths = () =>
      js<{ toc: number; panel: number; page: number }>(`({
        toc: document.getElementById("toc").offsetWidth,
        panel: document.getElementById("panel").offsetWidth,
        page: document.querySelector('.page[data-page="' + document.getElementById("page-input").value + '"]').offsetWidth,
      })`);
    const before = await widths();
    await sidebarDrag("toc-resizer", 60);
    await sidebarDrag("panel-resizer", -100);
    await new Promise((r) => setTimeout(r, 800));
    const after = await widths();
    const resizeOk = after.toc - before.toc === 60 && after.panel - before.panel === 100 && after.page < before.page;
    console.log(`[selftest] resize sidebars: ok=${resizeOk} ${JSON.stringify({ before, after })}`);
    await shot("1d-resized");
    await js(`(() => { for (const id of ["toc-resizer", "panel-resizer"]) document.getElementById(id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await waitFor(`document.getElementById("page-input").value === "${page}" && !!document.querySelector('.page[data-page=\"${page}\"] .textLayer span')`, 15_000);

    // Real mouse drags that end off the text (right margin, gap between lines) must not
    // grab text past the line the pointer is on.
    const drag = async (label: string, endAt: "right" | "left" | "bottom") => {
      const plan = await js<{ from: [number, number]; to: [number, number]; tail: string | null; head: string } | null>(`(() => {
        const spans = [...document.querySelectorAll('.page[data-page="${page}"] .textLayer span')]
          .filter((s) => s.textContent.trim().length > 20 && !s.querySelector("span"));
        if (spans.length < 8) return null;
        const a = spans[2].getBoundingClientRect(), b = spans[5].getBoundingClientRect();
        const line = [...spans[5].parentElement.querySelectorAll("span")]
          .filter((s) => !s.querySelector("span") && Math.abs(s.getBoundingClientRect().top - b.top) < 3)
          .sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left);
        const right = line[line.length - 1].getBoundingClientRect().right;
        const pageLeft = spans[5].closest(".page").getBoundingClientRect().left;
        return {
          from: [a.left + 1, a.top + a.height / 2],
          to: [${endAt === "right" ? "right + 30" : "pageLeft + 20"}, ${endAt === "bottom" ? 'document.getElementById("viewer").getBoundingClientRect().bottom - 4' : "b.top + b.height / 2"}],
          tail: ${endAt === "right" ? 'line.map((s) => s.textContent).join("").replace(/\\s+/g, " ").trim().slice(-12)' : "null"},
          head: spans[5].textContent.replace(/\\s+/g, " ").trim().slice(0, 15),
        };
      })()`);
      if (!plan) return null;
      await js(`getSelection().removeAllRanges()`);
      const send = (type: "mouseDown" | "mouseMove" | "mouseUp", [x, y]: [number, number]) =>
        win.webContents.sendInputEvent({
          type,
          x: Math.round(x),
          y: Math.round(y),
          button: "left",
          clickCount: 1,
          modifiers: type === "mouseMove" ? ["leftbuttondown"] : [],
        });
      send("mouseDown", plan.from);
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        send("mouseMove", [plan.from[0] + (plan.to[0] - plan.from[0]) * t, plan.from[1] + (plan.to[1] - plan.from[1]) * t]);
        await new Promise((r) => setTimeout(r, 20));
      }
      const scrollBefore = await js<number>(`document.getElementById("viewer").scrollTop`);
      if (endAt === "bottom") await new Promise((r) => setTimeout(r, 800));
      send("mouseUp", plan.to);
      const scrolled = (await js<number>(`document.getElementById("viewer").scrollTop`)) - scrollBefore;
      await new Promise((r) => setTimeout(r, 300));
      const text = (await js<string>(`getSelection().toString()`)).replace(/\s+/g, " ").trim();
      // Ending in the right margin should stop at the end of that line; in the left margin, before it.
      // Holding at the bottom edge should scroll and keep extending the selection.
      const ok =
        endAt === "bottom"
          ? scrolled > 100 && text.length > 1000
          : plan.tail
            ? text.endsWith(plan.tail)
            : !text.includes(plan.head) && text.length > 40;
      console.log(`[selftest] drag to ${label} margin: ok=${ok}, got …"${text.slice(-60)}" (${text.length} chars${scrolled ? `, scrolled ${Math.round(scrolled)}px` : ""})`);
      await shot(`2b-drag-${label}`);
      return ok;
    };
    const dragOk = [await drag("right", "right"), await drag("left", "left"), await drag("bottom", "bottom")];

    // A drag from the end of one page onto the next must still show the menu, on screen.
    await js(`getSelection().removeAllRanges()`);
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await new Promise((r) => setTimeout(r, 1000));
    const across = await js<{ from: [number, number]; to: [number, number] } | null>(`(() => {
      const leaves = (n) => [...document.querySelectorAll('.page[data-page="' + n + '"] .textLayer span')]
        .filter((s) => s.textContent.trim().length > 10 && !s.querySelector("span"));
      const a = leaves(${page}).pop(), b = leaves(${page + 1})[2];
      if (!a || !b) return null;
      const v = document.getElementById("viewer");
      v.scrollTop += a.getBoundingClientRect().top - v.getBoundingClientRect().top - 200;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return { from: [ra.left + 2, ra.top + ra.height / 2], to: [rb.right - 2, rb.top + rb.height / 2] };
    })()`);
    let acrossOk = false;
    if (across) {
      const send = (type: "mouseDown" | "mouseMove" | "mouseUp", [x, y]: [number, number]) =>
        win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, modifiers: type === "mouseMove" ? ["leftbuttondown"] : [] });
      send("mouseDown", across.from);
      for (let i = 1; i <= 12; i++) {
        send("mouseMove", [across.from[0] + (across.to[0] - across.from[0]) * (i / 12), across.from[1] + (across.to[1] - across.from[1]) * (i / 12)]);
        await new Promise((r) => setTimeout(r, 20));
      }
      send("mouseUp", across.to);
      await new Promise((r) => setTimeout(r, 300));
      const menu = await js<{ shown: boolean; onScreen: boolean; chars: number }>(`(() => {
        const m = document.getElementById("selection-menu"), v = document.getElementById("viewer").getBoundingClientRect();
        const r = m.getBoundingClientRect();
        return { shown: !m.hidden, onScreen: r.top >= v.top && r.bottom <= v.bottom, chars: getSelection().toString().length };
      })()`);
      acrossOk = menu.shown && menu.onScreen && menu.chars > 20;
      console.log(`[selftest] drag across pages: ok=${acrossOk} ${JSON.stringify(menu)}`);
      await shot("2c-drag-across-pages");
    }
    dragOk.push(acrossOk);
    await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
    await new Promise((r) => setTimeout(r, 500));

    const selected = await js<string>(`(() => {
      const spans = [...document.querySelectorAll('.page[data-page=\"${page}\"] .textLayer span')].filter((s) => s.textContent.trim().length > 20);
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
    const floating = await js<boolean>(`!document.getElementById("selection-menu").hidden`);
    console.log(`[selftest] selection menu shown: ${floating}`);

    // Clicking into the question box and typing must keep the menu open for that selection.
    const question = process.env.VR_SELFTEST_QUESTION ?? "Why would you change the defaults?";
    const box = await js<[number, number]>(`(() => { const r = document.getElementById("selection-question").getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
    for (const type of ["mouseDown", "mouseUp"] as const) {
      win.webContents.sendInputEvent({ type, x: Math.round(box[0]), y: Math.round(box[1]), button: "left", clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.insertText(question);
    await new Promise((r) => setTimeout(r, 200));
    const asking = await js<{ open: boolean; focused: boolean; value: string; marked: number }>(`({
      open: !document.getElementById("selection-menu").hidden,
      focused: document.activeElement?.id === "selection-question",
      value: document.getElementById("selection-question").value,
      // The passage stays marked even though the page selection moved into the box.
      marked: [...(CSS.highlights.get("pending-selection") ?? [])].map((r) => r.toString().length)[0] ?? 0,
    })`);
    const askingOk = asking.open && asking.focused && asking.value === question && asking.marked > 20;
    console.log(`[selftest] question box: ok=${askingOk} ${JSON.stringify(asking)}`);
    await shot("2d-question");

    // Every theme, in light and dark: a screenshot of each, and the drawings must follow.
    if (process.env.VR_SELFTEST_THEMES) {
      const { nativeTheme } = await import("electron");
      const ids = await js<string[]>(`[...document.getElementById("theme").options].map((o) => o.value)`);
      for (const scheme of ["light", "dark"] as const) {
        nativeTheme.themeSource = scheme;
        for (const id of ids) {
          await js(`(() => { const s = document.getElementById("theme"); s.value = "${id}"; s.dispatchEvent(new Event("change")); })()`);
          await new Promise((r) => setTimeout(r, 900));
          const look = await js<{ bg: string; frames: string[] }>(`({
            bg: getComputedStyle(document.body).backgroundColor,
            frames: [...document.querySelectorAll(".card iframe")].map((f) => new URL(f.src).searchParams.get("theme")),
          })`);
          console.log(`[selftest] theme ${id}/${scheme}: ${JSON.stringify(look)}`);
          await shot(`theme-${id}-${scheme}`);
        }
      }
      nativeTheme.themeSource = "system";
    }

    if (process.env.VR_SELFTEST_NO_EXPLAIN) {
      return quit(toc.entries > 0 && jumped.clicked && floating && askingOk && zoomOk && resizeOk && !dragOk.includes(false) ? 0 : 1);
    }
    // Without VR_SELFTEST_QUESTION, explain with the default (empty) question.
    if (!process.env.VR_SELFTEST_QUESTION) await js(`document.getElementById("selection-question").value = ""`);

    const mode = process.env.VR_SELFTEST_MODE === "text" ? "text" : "visual";
    await js(`document.getElementById("explain-${mode}").click()`);
    const started = Date.now();
    await waitFor(`!!document.querySelector(".card .prose p")`, 120_000);
    await shot("3-streaming");
    const done = await waitFor(
      mode === "text"
        ? `!!document.querySelector(".card .followup:not([hidden])") || !!document.querySelector(".card .status.error")`
        : `!!document.querySelector(".card iframe") || !!document.querySelector(".card .status.error")`,
      240_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    await shot("4-explainer");

    const result = await js<{ error: string | null; prose: string; asked: string | null; frameHeight: string | null }>(`({
      error: document.querySelector(".card .status.error")?.textContent ?? null,
      prose: document.querySelector(".card .prose")?.textContent ?? "",
      asked: document.querySelector(".card .card-question")?.textContent ?? null,
      frameHeight: document.querySelector(".card iframe")?.style.height ?? null,
    })`);
    if (mode === "text") console.log(`[selftest] text explanation: ${result.prose.trim().split(/\s+/).length} words`);
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

    // A follow-up continues the same conversation, through the parent card.
    if (done && !result.error && process.env.VR_SELFTEST_FOLLOWUP) {
      await js(`(() => {
        const form = document.querySelector(".card .followup");
        form.querySelector("input").value = "Say that again in one short sentence.";
        form.requestSubmit();
      })()`);
      const followed = await waitFor(
        `document.querySelectorAll(".card").length >= 2 && !!document.querySelector(".card .followup:not([hidden])") && document.querySelector(".card").querySelector(".followup:not([hidden]), .status.error") !== null`,
        180_000,
      );
      const reply = await js<{ error: string | null; prose: string; quote: string }>(`({
        error: document.querySelector(".card .status.error")?.textContent ?? null,
        prose: document.querySelector(".card .prose")?.textContent ?? "",
        quote: document.querySelector(".card .quote")?.textContent ?? "",
      })`);
      console.log(`[selftest] follow-up finished=${followed}`, JSON.stringify(reply));
      await shot("6-followup");
      if (!followed || reply.error) return quit(1);
    }
    quit(done && !result.error ? 0 : 1);
  } catch (err) {
    console.error("[selftest] failed:", err);
    await shot("error").catch(() => {});
    quit(1);
  }
}
