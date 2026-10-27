/** Renders the explainer's short prose: paragraphs, "- " bullets, **bold** and `code`. */

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (s: string) =>
  escape(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

export function renderProse(text: string): string {
  const blocks: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(`<ul>${bullets.map((b) => `<li>${inline(b)}</li>`).join("")}</ul>`);
    bullets = [];
  };
  for (const raw of text.trim().split("\n")) {
    const line = raw.trim();
    if (/^[-*] /.test(line)) bullets.push(line.slice(2));
    else {
      flush();
      if (line) blocks.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  return blocks.join("");
}
