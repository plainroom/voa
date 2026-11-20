import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// The website (site/): its page and the app's demo its frames play, built with relative paths for GitHub Pages.
// `npm run site` serves it, `npm run site:build` writes dist-site/.
export default defineConfig({
  root: "site",
  base: "./",
  mode: "site",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(__dirname, "site/index.html"), app: path.resolve(__dirname, "site/app.html") } },
  },
});
