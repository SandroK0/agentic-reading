import { defineConfig } from "vite";

// The renderer is served by the app:// protocol from dist/renderer.
export default defineConfig({
  root: "src",
  base: "./",
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    target: "esnext",
  },
  optimizeDeps: { include: ["pdfjs-dist"] },
});
