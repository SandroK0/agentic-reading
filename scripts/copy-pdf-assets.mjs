// Copies PDF.js's standard fonts and CMaps next to the renderer so books that
// rely on them render offline, without fetching from a CDN.
import fs from "node:fs";

for (const dir of ["standard_fonts", "cmaps"]) {
  fs.cpSync(`node_modules/pdfjs-dist/${dir}`, `dist/renderer/pdfjs/${dir}`, { recursive: true });
}
console.log("copied pdf.js fonts and cmaps");
