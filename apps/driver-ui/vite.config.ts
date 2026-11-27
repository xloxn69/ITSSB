import { defineConfig } from "vite";

export default defineConfig({
  // Assets load from the Pi's local service, so they work without internet.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // During development, forward API calls to a locally running device service.
    proxy: { "/api": "http://127.0.0.1:8765", "/health": "http://127.0.0.1:8765" },
  },
});
