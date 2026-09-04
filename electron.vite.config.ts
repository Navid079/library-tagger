import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true }
  },
  renderer: {
    resolve: { alias: { "@": resolve("src/renderer"), "@shared": resolve("src/shared") } },
    plugins: [react(), tailwindcss()],
    build: { sourcemap: true }
  }
});
