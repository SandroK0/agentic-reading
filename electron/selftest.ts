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
 * VR_SELFTEST_SCREENSHOTS=<dir> stages two explanations and saves README screenshots there
 * (use with VR_SELFTEST_PROFILE=<name> for an empty profile).
 * VR_SELFTEST_GENERATE_TOC=1 generates contents for a PDF without an outline (or loads saved ones).
 * VR_SELFTEST_NOTES_ONLY=1 checks only highlights, notes and bookmarks (works for PDFs and EPUBs).
 * An .epub runs its own shorter check (see epubSelfTest).
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
    // The library comes first, before any book is open.
    await waitFor(`!!document.querySelector("#empty > *")`, 10_000);
    await shot("0-library");
    const libraryPanel = await js<{ panel: string; button: string }>(`({ panel: getComputedStyle(document.getElementById("panel")).display, button: getComputedStyle(document.getElementById("panel-btn")).display })`);
    console.log(`[selftest] library has no explanations panel ok=${libraryPanel.panel === "none" && libraryPanel.button === "none"}`, JSON.stringify(libraryPanel));
    open(pdf);
    if (!(await waitFor(`document.getElementById("page-total").textContent !== "/ –"`, 30_000))) throw new Error("book never opened");
    // Back to the library and into the book again: the library now knows the book's title and length.
    await js(`document.getElementById("home-btn").click()`);
    const library = await waitFor(`!!document.querySelector("#empty .continue h3") && !document.getElementById("empty").hidden`, 10_000);
    console.log(`[selftest] library after closing: ok=${library}`);
    await shot("0b-library-after");
    await js(`document.querySelector("#empty .continue button.primary").click()`);
    if (!(await waitFor(`document.getElementById("page-total").textContent !== "/ –" && !document.getElementById("pages").hidden`, 30_000))) throw new Error("book never reopened");
    // VR_SELFTEST_NOTES_ONLY=1 checks only highlights, notes and bookmarks, in any book (it's how PDFs get them checked).
    if (process.env.VR_SELFTEST_NOTES_ONLY) return quit((await notesTest(js, waitFor, (ms) => new Promise((r) => setTimeout(r, ms)), shot)) ? 0 : 1);
    if (/\.epub$/i.test(pdf)) return quit((await epubSelfTest(js, waitFor, shot, win)) ? 0 : 1);

    // README screenshots: two real explanations on the page, then the app in a few themes, saved to VR_SELFTEST_SCREENSHOTS.
    if (process.env.VR_SELFTEST_SCREENSHOTS) {
      const dir = process.env.VR_SELFTEST_SCREENSHOTS;
      fs.mkdirSync(dir, { recursive: true });
      const { nativeTheme } = await import("electron");
      // Same framing for every shot: the top of the page, the newest card first, drawings fully grown.
      const frame = async () => {
        await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!!document.querySelector('.page[data-page="${page}"] .textLayer span')`, 15_000);
        await waitFor(`[...document.querySelectorAll(".card iframe")].every((f) => f.style.height && f.style.height !== "120px")`, 30_000);
        await js(`document.getElementById("cards").scrollTop = 0`);
      };
      const save = async (name: string) => {
        await new Promise((r) => setTimeout(r, 1200));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${name}.png`), image.resize({ width: 1600, quality: "best" }).toPNG());
        console.log(`[selftest] screenshot ${name}.png`);
      };
      const setTheme = (id: string) => js(`(() => { const s = document.getElementById("theme"); s.value = "${id}"; s.dispatchEvent(new Event("change")); })()`);
      // Selects lines `from`..`to` of the page's longer text spans and opens the selection menu.
      const select = (from: number, to: number) =>
        js<string>(`(() => {
          const spans = [...document.querySelectorAll('.page[data-page="${page}"] .textLayer span')].filter((s) => s.textContent.trim().length > 20);
          const first = spans[${from}], last = spans[Math.min(spans.length - 1, ${to})];
          const r = document.createRange();
          r.setStart(first.firstChild, 0);
          r.setEnd(last.firstChild, last.textContent.length);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return sel.toString();
        })()`);
      const finished = () => waitFor(`![...document.querySelectorAll(".card .status")].some((s) => !s.hidden && !s.classList.contains("error"))`, 240_000);

      nativeTheme.themeSource = "light";
      await setTheme("ink");
      await js(`(() => { const i = document.getElementById("page-input"); i.value = "${page}"; i.dispatchEvent(new Event("change")); })()`);
      await waitFor(`!!document.querySelector('.page[data-page="${page}"] .textLayer span')`, 15_000);

      await select(1, 6);
      await js(`document.getElementById("selection-question").value = "Why would you ever change the defaults?"`);
      await js(`document.getElementById("explain-text").click()`);
      await new Promise((r) => setTimeout(r, 1000));
      await finished();
      await select(14, 19);
      await js(`document.getElementById("explain-visual").click()`);
      await new Promise((r) => setTimeout(r, 1000));
      await finished();
      await waitFor(`[...document.querySelectorAll(".card iframe")].every((f) => f.style.height && f.style.height !== "120px")`, 30_000);
      await js(`getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))`);
      await frame();
      await save("reader");

      await select(8, 11);
      await js(`document.getElementById("selection-question").value = "How is this different from fork()?"`);
      await save("ask");
      await js(`getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))`);

      nativeTheme.themeSource = "dark";
      await setTheme("night");
      await frame();
      await save("night-library");
      await setTheme("graphite");
      await frame();
      await save("graphite-dark");
      nativeTheme.themeSource = "system";
      return quit(0);
    }

    // For a PDF without an outline: generate contents with the model (or find saved ones), then jump through them.
    if (process.env.VR_SELFTEST_GENERATE_TOC) {
      await waitFor(`!!document.querySelector(".toc-offer button.primary, .toc-generated")`, 30_000);
      const saved = await js<boolean>(`!!document.querySelector(".toc-generated")`);
      const started = Date.now();
      if (!saved) {
        await js(`document.querySelector(".toc-offer button.primary").click()`);
        await new Promise((r) => setTimeout(r, 3000));
        await shot("toc-1-progress");
        console.log(`[selftest] toc progress: ${await js<string>(`document.querySelector(".toc-offer")?.textContent ?? ""`)}`);
      }
      const done = await waitFor(`!!document.querySelector(".toc-generated") || !!document.querySelector(".toc-offer .toc-error")`, 600_000);
      const result = await js<{ error: string | null; entries: number; top: number; first: string[] }>(`({
        error: document.querySelector(".toc-error")?.textContent ?? null,
        entries: document.querySelectorAll(".toc-link").length,
        top: document.querySelectorAll("#toc-body > ul > li").length,
        first: [...document.querySelectorAll(".toc-link")].slice(0, 12).map((l) => l.textContent),
      })`);
      console.log(`[selftest] toc ${saved ? "loaded from save" : "generated"} in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(result)}`);
      const jump = await js<{ title: string; target: string } | null>(`(() => {
        const links = [...document.querySelectorAll(".toc-link:not(.branch)")].filter((l) => !l.disabled);
        const link = links[Math.floor(links.length / 2)];
        if (!link) return null;
        link.click();
        return { title: link.textContent, target: link.querySelector(".toc-page").textContent };
      })()`);
      await new Promise((r) => setTimeout(r, 1500));
      const landed = await js<string>(`document.getElementById("page-input").value`);
      console.log(`[selftest] toc jump: ${JSON.stringify({ ...jump, landed })}`);
      await shot("toc-2-generated");
      return quit(done && !result.error && result.entries > 0 && jump?.target === landed ? 0 : 1);
    }
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
    // A branch's arrow opens and closes it, by real clicks.
    const twisty = await js<{ x: number; y: number } | null>(`(() => {
      const t = document.querySelector(".toc-link.active").closest("ul").closest("li").querySelector(":scope > .toc-row > .toc-twisty");
      t.id = "selftest-twisty";
      if (!t) return null;
      t.scrollIntoView({ block: "center" });
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (twisty) {
      const state = () => js<boolean>(`document.getElementById("selftest-twisty").closest("li").classList.contains("open")`);
      const click = async () => {
        for (const type of ["mouseDown", "mouseUp"] as const) {
          win.webContents.sendInputEvent({ type, x: Math.round(twisty.x), y: Math.round(twisty.y), button: "left", clickCount: 1 });
        }
        await new Promise((r) => setTimeout(r, 300));
      };
      const before = await state();
      await click();
      const once = await state();
      await click();
      const twice = await state();
      console.log(`[selftest] contents arrow toggles: ok=${once !== before && twice === before}`, JSON.stringify({ before, once, twice }));
      // The section's own row toggles it too, and its page number still jumps there.
      const row = await js<{ toggles: boolean; jumped: string | null }>(`(async () => {
        const li = document.getElementById("selftest-twisty").closest("li");
        const link = li.querySelector(":scope > .toc-row > .toc-link");
        const before = li.classList.contains("open");
        link.click();
        const toggles = li.classList.contains("open") !== before;
        link.click();
        const go = li.querySelector(":scope > .toc-row > .toc-page-btn");
        go?.click();
        await new Promise((r) => setTimeout(r, 1000));
        return { toggles, jumped: go ? document.getElementById("page-input").value + " of " + go.textContent : null };
      })()`);
      console.log(`[selftest] contents row toggles: ok=${row.toggles}`, JSON.stringify(row));
    }
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

    // A card minimises to its header and remembers it; "collapse all" minimises every card, then expands them again.
    const minimise = await js<{ cards: number; collapsed: boolean; bodyHidden: boolean; saved: boolean | null; allCollapsed: boolean; allExpanded: boolean }>(`(async () => {
      const card = document.querySelector(".card");
      if (!card) return { cards: 0, collapsed: false, bodyHidden: false, saved: null, allCollapsed: false, allExpanded: false };
      card.querySelector(".card-toggle").click();
      const collapsed = card.classList.contains("collapsed");
      const bodyHidden = card.querySelector(".card-body").offsetParent === null;
      await new Promise((r) => setTimeout(r, 300));
      const saved = (await window.reader.bookState(${JSON.stringify(pdf)})).explanations[0]?.collapsed ?? null;
      card.querySelector(".card-toggle").click();
      document.getElementById("panel-collapse-all").click();
      const allCollapsed = [...document.querySelectorAll(".card")].every((c) => c.classList.contains("collapsed"));
      document.getElementById("panel-collapse-all").click();
      const allExpanded = [...document.querySelectorAll(".card")].every((c) => !c.classList.contains("collapsed"));
      return { cards: document.querySelectorAll(".card").length, collapsed, bodyHidden, saved, allCollapsed, allExpanded };
    })()`);
    const minimiseOk = minimise.cards === 0 || (minimise.collapsed && minimise.bodyHidden && minimise.saved === true && minimise.allCollapsed && minimise.allExpanded);
    console.log(`[selftest] minimise cards: ok=${minimiseOk} ${JSON.stringify(minimise)}`);

    // The Explanations panel hides, comes back, pops out into its own window, and docks again when that closes.
    const { BrowserWindow } = await import("electron");
    const pageWidth = () => js<number>(`document.querySelector(".page").offsetWidth`);
    const widthDocked = await pageWidth();
    await js(`document.getElementById("panel-close").click()`);
    await new Promise((r) => setTimeout(r, 800));
    const hidden = { panelHidden: await js<boolean>(`document.getElementById("panel").hidden`), pageWider: (await pageWidth()) > widthDocked };
    await js(`document.getElementById("panel-btn").click()`);
    await new Promise((r) => setTimeout(r, 800));
    const shownAgain = await js<boolean>(`!document.getElementById("panel").hidden`);
    await js(`document.getElementById("panel-popout").click()`);
    await new Promise((r) => setTimeout(r, 2500));
    const popup = BrowserWindow.getAllWindows().find((w) => w !== win);
    const away = {
      windows: BrowserWindow.getAllWindows().length,
      panelInMain: await js<boolean>(`!!document.getElementById("panel")`),
      popupCards: popup ? await popup.webContents.executeJavaScript(`document.querySelectorAll(".card").length`) : -1,
      // Drawings report their height to the window they're in; still 120px would mean the messages are lost.
      popupFrameHeights: popup ? await popup.webContents.executeJavaScript(`[...document.querySelectorAll(".card iframe")].map((f) => f.style.height)`) : [],
      popupTheme: popup ? await popup.webContents.executeJavaScript(`document.documentElement.dataset.theme + " " + getComputedStyle(document.body).backgroundColor`) : "",
    };
    if (popup) fs.writeFileSync(path.join(out, "1f-panel-window.png"), (await popup.webContents.capturePage()).toPNG());
    await shot("1f-panel-away");
    popup?.close();
    await new Promise((r) => setTimeout(r, 1000));
    const back = await js<boolean>(`!!document.getElementById("panel") && !document.getElementById("panel").hidden`);
    const panelOk = hidden.panelHidden && hidden.pageWider && shownAgain && away.windows === 2 && !away.panelInMain && back;
    console.log(`[selftest] explanations panel: ok=${panelOk} ${JSON.stringify({ hidden, shownAgain, away, back })}`);

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
      return quit(toc.entries > 0 && jumped.clicked && floating && askingOk && zoomOk && minimiseOk && panelOk && resizeOk && !dragOk.includes(false) ? 0 : 1);
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

    // A follow-up continues the same conversation, as a new turn inside the same card.
    if (done && !result.error && process.env.VR_SELFTEST_FOLLOWUP) {
      const cardsBefore = await js<number>(`document.querySelectorAll(".card").length`);
      await js(`(() => {
        const form = document.querySelector(".card .followup");
        form.querySelector("input").value = "Say that again in one short sentence.";
        form.requestSubmit();
      })()`);
      const followed = await waitFor(
        `(() => { const c = document.querySelector(".card"); return c.querySelectorAll(".turn").length >= 2 && (!!c.querySelector(".followup:not([hidden])") || !!c.querySelector(".status.error")); })()`,
        180_000,
      );
      const reply = await js<{ error: string | null; cards: number; turns: number; question: string; prose: string }>(`(() => {
        const c = document.querySelector(".card"), last = [...c.querySelectorAll(".turn")].pop();
        return {
          error: c.querySelector(".status.error")?.textContent ?? null,
          cards: document.querySelectorAll(".card").length,
          turns: c.querySelectorAll(".turn").length,
          question: last?.querySelector(".card-question")?.textContent ?? "",
          prose: last?.querySelector(".prose")?.textContent ?? "",
        };
      })()`);
      const saved = await js<number>(`window.reader.bookState(${JSON.stringify(pdf)}).then((s) => s.explanations[0]?.followUps?.length ?? 0)`);
      console.log(`[selftest] follow-up finished=${followed} sameCard=${reply.cards === cardsBefore} savedFollowUps=${saved}`, JSON.stringify(reply));
      await shot("6-followup");
      if (!followed || reply.error || reply.cards !== cardsBefore || saved < 1) return quit(1);
    }
    quit(done && !result.error ? 0 : 1);
  } catch (err) {
    console.error("[selftest] failed:", err);
    await shot("error").catch(() => {});
    quit(1);
  }
}

type Js = <T>(code: string) => Promise<T>;

/**
 * EPUB check: the contents list, jumping and scrolling through sections, zoom
 * keeping your place, then selecting a paragraph and asking for a written
 * explanation (skipped with VR_SELFTEST_NO_EXPLAIN), whose card jumps back to the passage.
 */
async function epubSelfTest(js: Js, waitFor: (code: string, ms: number) => Promise<boolean>, shot: (name: string) => Promise<void>, win: BrowserWindow) {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await waitFor(`!!document.querySelector(".epub-section")`, 15_000);
  await waitFor(`!!document.querySelector(".toc-link") || !!document.querySelector(".toc-empty")`, 15_000);
  const opened = await js<{ sections: number; total: string; title: string; entries: number; images: number; brokenImages: number }>(`({
    sections: document.querySelectorAll(".epub-section").length,
    total: document.getElementById("page-total").textContent,
    title: document.getElementById("title").textContent,
    entries: document.querySelectorAll(".toc-link:not(:disabled)").length,
    images: document.querySelectorAll(".epub-section img").length,
    brokenImages: [...document.querySelectorAll(".epub-section img")].filter((i) => i.complete && !i.naturalWidth).length,
  })`);
  console.log("[selftest] epub opened:", JSON.stringify(opened));
  await shot("epub-1-open");

  // The checks below scroll, so start in the scrolling layout, picked from the Aa menu.
  const pickLayout = (label: string) => js(`(() => {
    document.getElementById("look-btn").click();
    document.querySelector('.look-layout[title="${label}"]').click();
    document.getElementById("look-btn").click();
  })()`);
  await pickLayout("Scroll");
  await pause(500);

  // A contents entry lands on its section and lights up.
  const jump = await js<{ title: string; target: string } | null>(`(() => {
    const links = [...document.querySelectorAll(".toc-link:not(:disabled):not(.branch)")];
    const link = links[Math.min(3, links.length - 1)];
    if (!link) return null;
    link.click();
    return { title: link.textContent, target: link.querySelector(".toc-page").textContent };
  })()`);
  await pause(800);
  const landed = await js<{ page: string; active: string | null }>(`({ page: document.getElementById("page-input").value, active: document.querySelector(".toc-link.active")?.textContent ?? null })`);
  const jumpOk = !!jump && jump.target === landed.page && landed.active === jump.title;
  console.log(`[selftest] epub contents jump ok=${jumpOk}`, JSON.stringify({ ...jump, ...landed }));
  await shot("epub-2-jump");

  // EPUB contents are a dropdown over the text: closed at first, open from its button, closed again by a jump.
  const dropdown = await js<{ closedAtStart: boolean; floats: boolean; fullWidth: boolean; closedAfterJump: boolean; page: string }>(`(async () => {
    const toc = document.getElementById("toc");
    const closedAtStart = toc.hidden;
    const before = document.getElementById("viewer").clientWidth;
    document.getElementById("toc-btn").click();
    await new Promise((r) => setTimeout(r, 300));
    const floats = !toc.hidden && getComputedStyle(toc).position === "absolute";
    const fullWidth = document.getElementById("viewer").clientWidth === before;
    const links = [...document.querySelectorAll(".toc-link:not(:disabled):not(.branch)")];
    const link = links[Math.min(5, links.length - 1)];
    return { closedAtStart, floats, fullWidth, closedAfterJump: false, page: link.querySelector(".toc-page").textContent };
  })()`);
  await shot("epub-2b-contents-dropdown");
  await js(`(() => { const links = [...document.querySelectorAll(".toc-link:not(:disabled):not(.branch)")]; links[Math.min(5, links.length - 1)].click(); })()`);
  await pause(500);
  dropdown.closedAfterJump = await js<boolean>(`document.getElementById("toc").hidden`);
  const landedPage = await js<string>(`document.getElementById("page-input").value`);
  const dropdownOk = dropdown.closedAtStart && dropdown.floats && dropdown.fullWidth && dropdown.closedAfterJump && landedPage === dropdown.page;
  console.log(`[selftest] epub contents dropdown ok=${dropdownOk}`, JSON.stringify({ ...dropdown, landedPage }));

  // Scrolling moves the section number on; zooming keeps the same text at the top.
  await js(`document.getElementById("viewer").scrollTop += document.getElementById("viewer").clientHeight * 3`);
  await pause(800);
  const topText = `(() => { const v = document.getElementById("viewer").getBoundingClientRect(); const c = document.caretPositionFromPoint(v.left + v.width / 2, v.top + 40); return c?.offsetNode?.textContent?.trim().slice(0, 40) ?? null; })()`;
  const before = await js<{ page: string; text: string | null }>(`({ page: document.getElementById("page-input").value, text: ${topText} })`);
  await js(`document.getElementById("zoom-in").click()`);
  await pause(500);
  const after = await js<{ page: string; zoom: string; size: string; text: string | null }>(`({
    page: document.getElementById("page-input").value,
    zoom: document.getElementById("zoom-label").textContent,
    size: getComputedStyle(document.querySelector(".epub-section")).fontSize,
    text: ${topText},
  })`);
  const zoomOk = after.zoom === "125%" && after.page === before.page;
  console.log(`[selftest] epub scroll+zoom ok=${zoomOk}`, JSON.stringify({ before, after }));
  await shot("epub-3-zoomed");
  await js(`document.getElementById("zoom-out").click()`);

  // Select from the middle of the longest paragraph to its end, the way a mouse would, and check the menu comes up.
  // Starting mid-paragraph lets the paginated card jump below check it lands on the passage, not the paragraph.
  const selected = await js<{ text: string; paragraph: string; offset: number; section: string } | null>(`(() => {
    const sheet = document.querySelectorAll(".epub-section")[${jump?.target ?? 1} - 1];
    const p = [...sheet.querySelectorAll("p")].sort((a, b) => b.textContent.length - a.textContent.length)[0];
    const node = p && [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > 200);
    if (!node) return null;
    p.scrollIntoView({ block: "center" });
    const offset = node.textContent.indexOf(" ", Math.floor(node.textContent.length / 2)) + 1;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(p, p.childNodes.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { text: range.toString().trim().slice(0, 60), paragraph: p.textContent.trim().slice(0, 60), offset, section: sheet.dataset.page };
  })()`);
  await pause(300);
  const menu = await js<boolean>(`!document.getElementById("selection-menu").hidden`);
  console.log(`[selftest] epub selection menu=${menu}`, JSON.stringify(selected));
  await shot("epub-4-selected");
  if (!selected || !menu) return false;

  // The paginated checks change layout, which clears the selection, so they run after Explain (or instead of it).
  // Each group runs whatever an earlier one found, so one failure doesn't hide the rest.
  const groups = async () => [
    await epubPagedTest(js, pause, shot, pickLayout),
    await epubReadingToolsTest(js, waitFor, pause, shot, pickLayout, win),
    await notesTest(js, waitFor, pause, shot),
  ].every(Boolean);
  if (process.env.VR_SELFTEST_NO_EXPLAIN) return (await groups()) && dropdownOk && jumpOk && zoomOk && opened.sections > 0 && opened.brokenImages === 0;

  await js(`document.getElementById("explain-text").click()`);
  const done = await waitFor(`!!document.querySelector(".card .followup:not([hidden])") || !!document.querySelector(".card .status.error")`, 180_000);
  const card = await js<{ error: string | null; label: string; prose: string }>(`({
    error: document.querySelector(".card .status.error")?.textContent ?? null,
    label: document.querySelector(".card .page-link")?.textContent ?? "",
    prose: document.querySelector(".card .prose")?.textContent?.slice(0, 200) ?? "",
  })`);
  console.log(`[selftest] epub explain finished=${done}`, JSON.stringify(card));

  // The card's link goes back to the passage itself (not just its paragraph), even from far away.
  await js(`document.getElementById("viewer").scrollTop = 0`);
  await pause(300);
  await js(`document.querySelector(".card .page-link").click()`);
  await pause(500);
  const back = await js<{ page: string; visible: boolean }>(`(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const p = [...document.querySelectorAll(".epub-section p")].find((p) => p.textContent.trim().startsWith(${JSON.stringify(selected.paragraph)}));
    const node = p && [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > 200);
    if (!node) return { page: document.getElementById("page-input").value, visible: false };
    const at = document.createRange(); at.setStart(node, ${selected.offset}); at.setEnd(node, ${selected.offset} + 1);
    const r = at.getBoundingClientRect();
    return { page: document.getElementById("page-input").value, visible: r.top >= v.top - 1 && r.top < v.bottom };
  })()`);
  console.log("[selftest] epub card jump:", JSON.stringify(back));
  await shot("epub-5-explained");

  // Paginated, at a size where long paragraphs run across pages, the card lands on the page with the passage itself.
  await pickLayout("Single");
  await js(`(() => { for (let i = 0; i < 10; i++) document.getElementById("look-larger").click(); })()`);
  await pause(600);
  await js(`(() => { const i = document.getElementById("page-input"); i.value = "1"; i.dispatchEvent(new Event("change")); })()`);
  await pause(400);
  await js(`document.querySelector(".card .page-link").click()`);
  await pause(700);
  const pagedBack = await js<{ page: string; passageShown: boolean; paragraphStartShown: boolean }>(`(() => {
    const box = document.getElementById("pages").getBoundingClientRect();
    const shown = (r) => r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1;
    const p = [...document.querySelectorAll(".epub-section.current p")].find((p) => p.textContent.trim().startsWith(${JSON.stringify(selected.paragraph)}));
    const node = p && [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > 200);
    if (!node) return { page: document.getElementById("page-input").value, passageShown: false, paragraphStartShown: false };
    const at = document.createRange(); at.setStart(node, ${selected.offset}); at.setEnd(node, ${selected.offset} + 1);
    const first = document.createRange(); first.setStart(node, 0); first.setEnd(node, 1);
    return { page: document.getElementById("page-input").value, passageShown: shown(at.getBoundingClientRect()), paragraphStartShown: shown(first.getBoundingClientRect()) };
  })()`);
  await shot("epub-5b-explained-paged");
  await js(`(() => { for (let i = 0; i < 10; i++) document.getElementById("look-smaller").click(); })()`);
  await pickLayout("Scroll");
  const pagedJumpOk = pagedBack.page === selected.section && pagedBack.passageShown;
  console.log(`[selftest] epub paginated card jump ok=${pagedJumpOk}`, JSON.stringify(pagedBack));
  const pagedOk = await groups();
  return done && !card.error && back.page === selected.section && back.visible && jumpOk && zoomOk && pagedOk && dropdownOk && pagedJumpOk;
}

/**
 * Two pages, then one: columns, page turns by key and edge, crossing into the
 * next section and back onto its last page, bigger text adding pages, and the
 * Sepia page colour.
 */
async function epubPagedTest(js: Js, pause: (ms: number) => Promise<unknown>, shot: (name: string) => Promise<void>, pickLayout: (label: string) => Promise<unknown>) {
  const state = `(() => {
    const s = document.querySelector(".epub-section.current");
    return {
      paged: document.getElementById("viewer").classList.contains("epub-paged"),
      section: document.getElementById("page-input").value,
      columns: s ? getComputedStyle(s).columnCount : null,
      shift: s ? Math.round(new DOMMatrix(getComputedStyle(s).transform).m41) : null,
      turnsShown: !document.getElementById("turn-next").hidden,
      scrollable: document.getElementById("viewer").scrollHeight > document.getElementById("viewer").clientHeight + 4,
      menu: !document.getElementById("selection-menu").hidden,
    };
  })()`;
  type State = { paged: boolean; section: string; columns: string | null; shift: number | null; turnsShown: boolean; scrollable: boolean; menu: boolean };
  const key = (k: string, shiftKey = false) => js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, shiftKey: ${shiftKey}, bubbles: true }))`);

  // Two pages need a wide reader: hide the explanations while checking them (and let the panel finish sliding away).
  await js(`document.getElementById("panel-btn").click()`);
  await pause(500);
  await pickLayout("Two pages");
  await pause(600);
  // Start from the top of a long section: the contents' fourth entry, as in the jump check.
  await js(`(() => { const i = document.getElementById("page-input"); i.value = String(Math.min(4, Number(document.getElementById("page-total").textContent.split("/")[1]))); i.dispatchEvent(new Event("change")); })()`);
  await pause(400);
  const start = await js<State>(state);
  await shot("epub-6-two-pages");
  await key("ArrowRight");
  await pause(600);
  const turned = await js<State>(state);
  await shot("epub-7-turned");
  await js(`document.getElementById("turn-prev").click()`);
  await pause(600);
  const back = await js<State>(state);
  const twoOk = start.paged && start.columns === "2" && start.turnsShown && !start.scrollable
    && (turned.shift! < start.shift! || Number(turned.section) === Number(start.section) + 1)
    && back.section === start.section && back.shift === start.shift;
  console.log(`[selftest] epub two pages ok=${twoOk}`, JSON.stringify({ start, turned, back }));

  // Space after closing the Aa menu with its button turns the page instead of reopening the menu.
  await js(`(() => { const b = document.getElementById("look-btn"); b.click(); b.click(); b.focus(); })()`);
  await js(`document.getElementById("look-btn").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))`);
  await pause(600);
  const spaced = await js<State & { menuOpen: boolean }>(`({ ...${state}, menuOpen: !document.getElementById("look").hidden })`);
  await key(" ", true);
  await pause(600);
  const spaceOk = !spaced.menuOpen && (spaced.shift! < start.shift! || spaced.section !== start.section);
  console.log(`[selftest] epub space with a toolbar button focused ok=${spaceOk}`, JSON.stringify(spaced));

  // Turn until the section changes, then one back lands on the previous section's last page.
  let crossed: State = start;
  for (let i = 0; i < 60; i++) {
    await key(" ");
    await pause(80);
    crossed = await js<State>(state);
    if (crossed.section !== start.section) break;
  }
  await pause(400);
  await key(" ", true);
  await pause(600);
  const lastPage = await js<State>(state);
  const crossOk = Number(crossed.section) === Number(start.section) + 1 && crossed.shift === 0 && lastPage.section === start.section && lastPage.shift! <= 0;
  console.log(`[selftest] epub across sections ok=${crossOk}`, JSON.stringify({ crossed, lastPage }));

  // Single page, bigger text: same section, one column, and its pages move further apart.
  await js(`document.getElementById("panel-btn").click()`);
  await pickLayout("Single");
  await pause(600);
  const single = await js<State>(state);
  await js(`document.getElementById("look-larger").click(); document.getElementById("look-larger").click()`);
  await pause(600);
  const bigger = await js<State & { size: string; label: string }>(`({ ...${state}, size: getComputedStyle(document.querySelector(".epub-section.current")).fontSize, label: document.getElementById("look-size-label").textContent })`);
  await js(`document.querySelector('.look-color[title="Sepia page"]').click()`);
  await pause(300);
  const sepia = await js<string>(`getComputedStyle(document.getElementById("viewer")).backgroundColor`);
  await shot("epub-8-single-sepia");
  await js(`document.getElementById("look-smaller").click(); document.getElementById("look-smaller").click(); document.querySelector('.look-color[title="Theme page"]').click()`);
  const singleOk = single.paged && single.columns === "1" && single.section === lastPage.section && bigger.label === "120%" && bigger.section === single.section && sepia === "rgb(246, 238, 220)";
  console.log(`[selftest] epub single page, size and colour ok=${singleOk}`, JSON.stringify({ single, bigger, sepia }));
  // Width: in Single and Scroll the slider makes the text wider and keeps your section; Two pages hides it.
  const setWidth = (v: number) => js(`(() => { const r = document.getElementById("look-width"); r.value = "${v}"; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); })()`);
  const widths = async () => js<{ box: number; section: string; sliderShown: boolean }>(`({
    box: document.getElementById("pages").getBoundingClientRect().width,
    section: document.getElementById("page-input").value,
    sliderShown: !document.getElementById("look-width-row").hidden,
  })`);
  await pickLayout("Single");
  await pause(400);
  const singleBefore = await widths();
  await setWidth(24);
  await pause(400);
  const singleNarrow = await widths();
  await setWidth(32);
  await pickLayout("Scroll");
  await pause(400);
  const scrollBefore = await widths();
  await setWidth(50);
  await pause(400);
  const scrollWide = await widths();
  await setWidth(32);
  await pickLayout("Two pages");
  await pause(400);
  const twoHidesSlider = !(await widths()).sliderShown;
  const widthOk = singleBefore.sliderShown && singleNarrow.box < singleBefore.box - 50 && singleNarrow.section === singleBefore.section
    && scrollWide.box > scrollBefore.box + 50 && twoHidesSlider;
  console.log(`[selftest] epub width ok=${widthOk}`, JSON.stringify({ singleBefore, singleNarrow, scrollBefore, scrollWide, twoHidesSlider }));

  // The app theme never changes the book's font: Graphite & Violet's sans-serif stays in the interface.
  const fontIn = (theme: string) => js<string>(`(() => {
    const s = document.getElementById("theme"); s.value = "${theme}"; s.dispatchEvent(new Event("change"));
    return getComputedStyle(document.querySelector(".epub-section.current")).fontFamily;
  })()`);
  const inkFont = await fontIn("ink");
  const graphiteFont = await fontIn("graphite");
  await fontIn("ink");
  const fontOk = inkFont === graphiteFont && /New York/.test(inkFont);
  console.log(`[selftest] epub font ignores app theme ok=${fontOk}`, JSON.stringify({ inkFont, graphiteFont }));

  await js(`document.getElementById("look-btn").click()`);
  await pause(300);
  await shot("epub-9-look-menu");
  await js(`document.getElementById("look-btn").click()`);
  return twoOk && spaceOk && crossOk && singleOk && fontOk && widthOk;
}

/**
 * The EPUB reader's tools: the Customize sheet, a book keeping its own
 * look, Night in dark mode, the whole-book page count and progress bar, the
 * "Back to" button, search, and the toolbar resting while you read.
 */
async function epubReadingToolsTest(
  js: Js,
  waitFor: (code: string, ms: number) => Promise<boolean>,
  pause: (ms: number) => Promise<unknown>,
  shot: (name: string) => Promise<void>,
  pickLayout: (label: string) => Promise<unknown>,
  win: BrowserWindow,
) {
  const results: Record<string, boolean> = {};
  const section = () => js<string>(`document.getElementById("page-input").value`);
  const openLook = () => js(`document.getElementById("look").hidden && document.getElementById("look-btn").click()`);
  const closeLook = () => js(`document.getElementById("look").hidden || document.getElementById("look-btn").click()`);
  const slide = (id: string, v: number) => js(`(() => { const r = document.getElementById("${id}"); r.value = "${v}"; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); })()`);
  const current = `document.querySelector(".epub-section.current")`;

  await js(`document.getElementById("panel-btn").getAttribute("aria-pressed") === "true" && document.getElementById("panel-btn").click()`);
  await pickLayout("Two pages");
  await js(`(() => { const i = document.getElementById("page-input"); i.value = "4"; i.dispatchEvent(new Event("change")); })()`);
  await pause(500);

  // Customize: spacing, justification and margins reach the page; Reset puts them back.
  await openLook();
  await js(`document.getElementById("look-open-customize").click()`);
  await pause(200);
  const boxBefore = await js<number>(`document.getElementById("pages").getBoundingClientRect().width`);
  await slide("look-line", 2);
  await js(`document.getElementById("look-justify").click(); document.querySelector('#look-margins [data-id="wide"]').click()`);
  await pause(500);
  const custom = await js<{ lineRatio: number; align: string; box: number; sheetShown: boolean }>(`(() => {
    const s = ${current}, p = s.querySelector("p");
    return { lineRatio: parseFloat(getComputedStyle(p).lineHeight) / parseFloat(getComputedStyle(p).fontSize), align: getComputedStyle(p).textAlign,
      box: document.getElementById("pages").getBoundingClientRect().width, sheetShown: !document.getElementById("look-customize").hidden };
  })()`);
  await shot("epub-10-customize");
  await js(`document.getElementById("look-reset").click()`);
  await pause(500);
  const reset = await js<{ lineRatio: number; align: string }>(`(() => { const p = ${current}.querySelector("p"); return { lineRatio: parseFloat(getComputedStyle(p).lineHeight) / parseFloat(getComputedStyle(p).fontSize), align: getComputedStyle(p).textAlign }; })()`);
  await js(`document.getElementById("look-close-customize").click()`);
  results.customize = custom.sheetShown && Math.abs(custom.lineRatio - 2) < 0.05 && custom.align === "justify" && custom.box < boxBefore - 20 && Math.abs(reset.lineRatio - 1.6) < 0.05 && reset.align !== "justify";
  console.log(`[selftest] epub customize ok=${results.customize}`, JSON.stringify({ boxBefore, custom, reset }));

  // A book can keep its own look; turning that off goes back to the usual one.
  const bg = () => js<string>(`getComputedStyle(document.getElementById("viewer")).backgroundColor`);
  const usualBg = await bg();
  await js(`document.getElementById("look-this-book").click(); document.querySelector('.look-color[title="Sepia page"]').click()`);
  await pause(200);
  const own = { bg: await bg(), saved: await js<boolean>(`Object.keys(JSON.parse(localStorage.getItem("visual-reader:reading-look-books") || "{}")).length > 0`) };
  await js(`document.getElementById("look-this-book").click()`);
  await pause(300);
  const backToUsual = await bg();
  results.perBook = own.bg === "rgb(246, 238, 220)" && own.saved && backToUsual === usualBg;
  console.log(`[selftest] epub this book only ok=${results.perBook}`, JSON.stringify({ usualBg, own, backToUsual }));

  // Night in dark mode: the page goes Night while the system is dark.
  const { nativeTheme } = await import("electron");
  const themeBefore = nativeTheme.themeSource;
  await js(`document.getElementById("look-auto-night").click()`);
  nativeTheme.themeSource = "dark";
  await pause(400);
  const darkBg = await bg();
  nativeTheme.themeSource = "light";
  await pause(400);
  const lightBg = await bg();
  nativeTheme.themeSource = themeBefore;
  await js(`document.getElementById("look-auto-night").click()`);
  await closeLook();
  results.autoNight = darkBg === "rgb(17, 18, 20)" && lightBg !== darkBg;
  console.log(`[selftest] epub night in dark mode ok=${results.autoNight}`, JSON.stringify({ darkBg, lightBg }));

  // The whole book's pages get counted; the footer shows the pages and what's left in the chapter.
  const counted = await waitFor(`/^Pages? \\d+(–\\d+)? of \\d+$/.test(document.getElementById("epub-pages").textContent)`, 15_000);
  const footer = await js<{ pages: string; left: string; navHidden: boolean }>(`({ pages: document.getElementById("epub-pages").textContent, left: document.getElementById("epub-left").textContent, navHidden: document.getElementById("nav").hidden })`);
  results.footer = counted && /left in chapter|Last page in chapter/.test(footer.left) && footer.navHidden;
  console.log(`[selftest] epub page count and footer ok=${results.footer}`, JSON.stringify(footer));

  // A recount (here, after bigger text) keeps page numbers showing while it runs, then settles on new ones.
  await js(`document.getElementById("look-btn").click(); document.getElementById("look-larger").click()`);
  await pause(80);
  const duringRecount = await js<string>(`document.getElementById("epub-pages").textContent`);
  await pause(1500);
  const afterRecount = await js<string>(`document.getElementById("epub-pages").textContent`);
  await js(`document.getElementById("look-smaller").click(); document.getElementById("look-btn").click()`);
  await pause(1500);
  results.recount = /^Pages? \d/.test(duringRecount) && /^Pages? \d/.test(afterRecount) && afterRecount !== footer.pages;
  console.log(`[selftest] epub page numbers stay through a recount ok=${results.recount}`, JSON.stringify({ before: footer.pages, duringRecount, afterRecount }));

  // The progress bar jumps; "Back to" returns to where you were and goes away.
  const from = await section();
  await js(`(() => {
    const s = document.getElementById("scrubber"), r = s.getBoundingClientRect();
    const at = { clientX: r.left + r.width * 0.75, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true, button: 0 };
    s.dispatchEvent(new PointerEvent("pointerdown", at));
    s.dispatchEvent(new PointerEvent("pointerup", at));
  })()`);
  await pause(600);
  const scrubbed = { section: await section(), back: await js<string | null>(`document.getElementById("back-pill").hidden ? null : document.getElementById("back-label").textContent`) };
  await shot("epub-11-scrubbed");
  await js(`document.getElementById("back-pill").click()`);
  await pause(600);
  const returned = { section: await section(), backHidden: await js<boolean>(`document.getElementById("back-pill").hidden`) };
  results.scrub = Number(scrubbed.section) > Number(from) + 2 && !!scrubbed.back && returned.section === from && returned.backHidden;
  console.log(`[selftest] epub progress bar and back ok=${results.scrub}`, JSON.stringify({ from, scrubbed, returned }));

  // On the bar, → goes to the next chapter without leaving a "Back to".
  const beforeArrow = await section();
  await js(`(() => { const s = document.getElementById("scrubber"); s.focus(); s.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); })()`);
  await pause(500);
  const arrowed = { section: await section(), backHidden: await js<boolean>(`document.getElementById("back-pill").hidden`) };
  await js(`document.getElementById("scrubber").blur()`);
  results.chapterArrow = Number(arrowed.section) === Number(beforeArrow) + 1 && arrowed.backHidden;
  console.log(`[selftest] epub chapter arrow on the bar ok=${results.chapterArrow}`, JSON.stringify({ beforeArrow, arrowed }));

  // Search: ⌘F opens it, results come in by chapter, Return goes to one and marks it, Escape clears the marks.
  await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }))`);
  await pause(200);
  await js(`(() => { const i = document.getElementById("search-input"); i.value = "rabbit"; i.dispatchEvent(new Event("input")); })()`);
  await pause(400);
  const listed = await js<{ open: boolean; focused: boolean; results: number; chapters: number; summary: string }>(`({
    open: !document.getElementById("search").hidden, focused: document.activeElement?.id === "search-input",
    results: document.querySelectorAll(".search-result").length, chapters: document.querySelectorAll(".search-chapter").length,
    summary: document.getElementById("search-summary").textContent })`);
  await js(`document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await pause(500);
  const found = await js<{ count: string; marked: boolean; shown: boolean }>(`(() => {
    const hl = CSS.highlights.get("search-current"); const range = hl && [...hl][0];
    const r = range?.getBoundingClientRect(), box = document.getElementById("pages").getBoundingClientRect();
    return { count: document.getElementById("search-count").textContent, marked: !!range && /rabbit/i.test(range.toString()), shown: !!r && r.left >= box.left - 1 && r.right <= box.right + 1 };
  })()`);
  await shot("epub-12-search");
  await js(`document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await pause(200);
  const cleared = await js<boolean>(`document.getElementById("search").hidden && !CSS.highlights.has("search-hit")`);
  results.search = listed.open && listed.focused && listed.results > 5 && listed.chapters > 1 && /of \d+$/.test(found.count) && found.marked && found.shown && cleared;
  console.log(`[selftest] epub search ok=${results.search}`, JSON.stringify({ listed, found, cleared }));

  // The toolbar rests while you read, and the pointer at the top brings it back.
  await js(`document.activeElement?.blur(); document.dispatchEvent(new MouseEvent("mousemove", { clientY: 10, bubbles: true }))`);
  const rested = await waitFor(`document.body.classList.contains("reading-focus")`, 6_000);
  await pause(600);
  await shot("epub-13-focus");
  await js(`document.dispatchEvent(new MouseEvent("mousemove", { clientY: 10, bubbles: true }))`);
  const woke = await js<boolean>(`!document.body.classList.contains("reading-focus")`);
  results.focus = rested && woke;
  console.log(`[selftest] epub toolbar rests ok=${results.focus}`, JSON.stringify({ rested, woke }));

  // Resizing the window fades the text out, lays it out again unseen, and fades it back in at the same place.
  const [w, h] = win.getSize();
  const beforeResize = await section();
  win.setSize(w - 240, h);
  await pause(60);
  const fadedDuring = await js<boolean>(`document.getElementById("pages").classList.contains("reflowing")`);
  await pause(700);
  const afterResize = await js<{ faded: boolean; opacity: string; section: string }>(`({
    faded: document.getElementById("pages").classList.contains("reflowing"),
    opacity: getComputedStyle(document.getElementById("pages")).opacity,
    section: document.getElementById("page-input").value })`);
  win.setSize(w, h);
  await pause(700);
  results.resizeFade = fadedDuring && !afterResize.faded && afterResize.opacity === "1" && afterResize.section === beforeResize;
  console.log(`[selftest] epub text fades through a resize ok=${results.resizeFade}`, JSON.stringify({ fadedDuring, afterResize, beforeResize }));

  // The toolbar's panel button, clicked for real (mouse down and up), shows the panel and then hides it again.
  const realClick = async (id: string) => {
    const at = await js<{ x: number; y: number }>(`(() => { const r = document.getElementById("${id}").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const) {
      win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: "left", clickCount: 1 });
    }
  };
  const panelState = () => js<{ hidden: boolean; away: boolean; pressed: string | null }>(`({ hidden: document.getElementById("panel").hidden, away: document.querySelector(".layout").classList.contains("panel-away"), pressed: document.getElementById("panel-btn").getAttribute("aria-pressed") })`);
  const clicks = [await panelState()];
  for (let i = 0; i < 4; i++) {
    await realClick("panel-btn");
    await pause(700);
    clicks.push(await panelState());
  }
  results.panelButton = clicks.every((c, i) => i === 0 || c.hidden !== clicks[i - 1].hidden);
  console.log(`[selftest] epub panel button toggles with real clicks ok=${results.panelButton}`, JSON.stringify(clicks));

  // The panel slides back in, and slides out before it hides.
  await js(`document.getElementById("panel-btn").click()`);
  const slidesIn = await js<boolean>(`document.getElementById("panel").getAnimations().length > 0 && !document.getElementById("panel").hidden`);
  await pause(400);
  await js(`document.getElementById("panel-btn").click()`);
  const slidesOut = await js<boolean>(`document.getElementById("panel").getAnimations().length > 0 && !document.getElementById("panel").hidden`);
  await pause(400);
  const goneAfter = await js<boolean>(`document.getElementById("panel").hidden`);
  results.slide = slidesIn && slidesOut && goneAfter;
  console.log(`[selftest] epub explanations panel slides ok=${results.slide}`, JSON.stringify({ slidesIn, slidesOut, goneAfter }));

  // Full screen tucks the explanations panel away, and brings it back after. macOS won't take a window in the
  // background full screen, and the pointer can sit over it when you're using the Mac, so these two checks
  // (and the toolbar resting over the panel, which follows) only count when the test window is in front.
  const inFront = win.isFocused();
  await js(`document.getElementById("panel-btn").click()`);
  await pause(400);
  const panelShown = () => js<boolean>(`!document.getElementById("panel").hidden`);
  const beforeFull = await panelShown();
  win.setFullScreen(true);
  await waitFor(`document.documentElement.classList.contains("fullscreen")`, 5_000);
  await pause(800);
  const inFull = await panelShown();
  win.setFullScreen(false);
  await waitFor(`!document.documentElement.classList.contains("fullscreen")`, 5_000);
  await pause(800);
  const afterFull = await panelShown();
  if (inFront) results.fullScreen = beforeFull && !inFull && afterFull;

  // With the panel docked, the resting toolbar continues the panel to the top of the window.
  await js(`document.activeElement?.blur(); document.dispatchEvent(new MouseEvent("mousemove", { clientY: 10, bubbles: true }))`);
  const restedWithPanel = await waitFor(`document.body.classList.contains("reading-focus")`, 6_000);
  await pause(600);
  const strip = await js<{ strip: number; panel: number; layers: string; pseudo: string }>(`(() => {
    const toolbar = getComputedStyle(document.querySelector(".toolbar"));
    return { strip: parseFloat(getComputedStyle(document.body).getPropertyValue("--docked-panel-width")), panel: document.getElementById("panel").getBoundingClientRect().width,
      layers: toolbar.backgroundImage, pseudo: getComputedStyle(document.querySelector(".toolbar"), "::after").content };
  })()`);
  await shot("epub-14-rest-with-panel");
  // Nothing is laid over the toolbar's buttons: the strip is part of its background.
  if (inFront) results.restWithPanel = restedWithPanel && Math.abs(strip.strip - strip.panel) < 2 && /linear-gradient/.test(strip.layers) && (strip.pseudo === "none" || strip.pseudo === "normal");
  console.log(`[selftest] epub resting toolbar continues the panel ${inFront ? `ok=${results.restWithPanel}` : "skipped (window in background)"}`, JSON.stringify(strip));
  console.log(`[selftest] epub full screen hides the panel ${inFront ? `ok=${results.fullScreen}` : "skipped (window in background)"}`, JSON.stringify({ beforeFull, inFull, afterFull }));
  return Object.values(results).every(Boolean);
}

/**
 * Highlights, notes and bookmarks, in whichever book is open (EPUB or PDF):
 * H highlights a selection, N adds a note, selecting a highlight offers to
 * remove it, ⌘D bookmarks the page, and all of it comes back after the book
 * is closed and opened again.
 */
async function notesTest(js: Js, waitFor: (code: string, ms: number) => Promise<boolean>, pause: (ms: number) => Promise<unknown>, shot: (name: string) => Promise<void>) {
  const results: Record<string, boolean> = {};
  const marks = `({
    plain: CSS.highlights.get("user-highlight")?.size ?? 0,
    noted: CSS.highlights.get("user-note")?.size ?? 0,
    items: document.querySelectorAll("#notes-list .note-item").length,
    count: document.getElementById("count-notes").textContent,
  })`;
  type Marks = { plain: number; noted: number; items: number; count: string };
  // Selects `chars` characters, starting `skip` in, of the nth visible run of 50+ characters, and opens the selection menu.
  const select = (nth: number, skip = 0, chars = 40) => js<string | null>(`(() => {
    const roots = [...document.querySelectorAll(".epub-section.current, .page .textLayer")];
    const box = document.getElementById("viewer").getBoundingClientRect();
    const texts = roots.flatMap((root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), out = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.data.trim().length < 50) continue;
        const r = document.createRange(); r.selectNodeContents(n); const rect = r.getBoundingClientRect();
        if (rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right) out.push(n);
      }
      return out;
    });
    const node = texts[${nth}];
    if (!node) return null;
    const start = node.data.search(/\\S/) + ${skip};
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + ${chars});
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  })()`);
  const key = (k: string, meta = false) => js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, metaKey: ${meta}, bubbles: true, cancelable: true }))`);

  await js(`document.getElementById("panel").hidden && document.getElementById("panel-btn").click()`);
  await js(`document.getElementById("tab-notes").click()`);
  await pause(300);
  const before = await js<Marks>(marks);

  // H highlights the selection.
  const first = await select(0);
  await pause(200);
  await key("h");
  await pause(300);
  const highlighted = await js<Marks>(marks);
  results.highlight = !!first && highlighted.plain === before.plain + 1 && highlighted.items === before.items + 1;
  console.log(`[selftest] notes: H highlights ok=${results.highlight}`, JSON.stringify({ first, before, highlighted }));

  // N highlights another passage and opens its note; what you type is kept, and the passage is underlined as noted.
  const second = await select(1);
  await pause(200);
  await key("n");
  await pause(300);
  const editor = await js<boolean>(`document.activeElement?.classList.contains("note-editor") ?? false`);
  await js(`(() => { const box = document.activeElement; box.value = "Remember this one."; box.dispatchEvent(new Event("input")); })()`);
  await pause(700);
  await js(`document.activeElement?.blur()`);
  await js(`document.getElementById("tab-explanations").click(); document.getElementById("tab-notes").click()`);
  await pause(200);
  const noted = await js<Marks & { note: string | null }>(`({ ...${marks}, note: document.querySelector("#notes-list .note-text")?.textContent ?? document.querySelector("#notes-list .note-editor")?.value ?? null })`);
  await shot("notes-1-highlights");
  results.note = !!second && editor && noted.noted === 1 && noted.note === "Remember this one.";
  console.log(`[selftest] notes: N adds a note ok=${results.note}`, JSON.stringify({ second, editor, noted }));

  // Selecting inside the first highlight offers to take it away.
  await select(0, 5, 10);
  await pause(200);
  const offer = await js<string>(`document.getElementById("highlight-label").textContent`);
  await js(`document.getElementById("highlight-text").click()`);
  await pause(300);
  const removed = await js<Marks>(marks);
  results.remove = offer === "Remove highlight" && removed.plain === highlighted.plain - 1;
  console.log(`[selftest] notes: remove a highlight ok=${results.remove}`, JSON.stringify({ offer, removed }));

  // ⌘D bookmarks the page: the button fills, the ribbon shows, it's listed; again takes it away.
  await key("d", true);
  await pause(300);
  const bookmarked = await js<{ pressed: string | null; ribbon: boolean; listed: number }>(`({ pressed: document.getElementById("bookmark-btn").getAttribute("aria-pressed"), ribbon: !document.getElementById("bookmark-ribbon").hidden, listed: document.querySelectorAll("#notes-list .note-item.bookmark").length })`);
  await shot("notes-2-bookmark");
  results.bookmark = bookmarked.pressed === "true" && bookmarked.ribbon && bookmarked.listed === 1;
  console.log(`[selftest] notes: ⌘D bookmarks ok=${results.bookmark}`, JSON.stringify(bookmarked));

  // Closed and opened again, the note and the bookmark come back.
  await js(`document.getElementById("home-btn").click()`);
  await waitFor(`!document.getElementById("empty").hidden && !!document.querySelector("#empty .continue button.primary")`, 10_000);
  await js(`document.querySelector("#empty .continue button.primary").click()`);
  await waitFor(`!document.getElementById("pages").hidden && document.getElementById("count-notes").textContent !== ""`, 20_000);
  await pause(1500);
  const reopened = await js<Marks & { bookmarks: number; pressed: string | null }>(`({ ...${marks}, bookmarks: document.querySelectorAll("#notes-list .note-item.bookmark").length, pressed: document.getElementById("bookmark-btn").getAttribute("aria-pressed") })`);
  results.saved = reopened.noted === 1 && reopened.bookmarks === 1 && reopened.pressed === "true";
  console.log(`[selftest] notes: saved with the book ok=${results.saved}`, JSON.stringify(reopened));

  // Tidy up, so the next run starts clean: remove every mark from the list.
  await js(`(() => { let b; while ((b = document.querySelector("#notes-list .note-actions .danger, #notes-list .note-remove"))) b.click(); })()`);
  await js(`document.getElementById("tab-explanations").click()`);
  return Object.values(results).every(Boolean);
}
