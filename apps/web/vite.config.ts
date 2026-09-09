import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3000,
    // The API is same-origin in production; proxy it in development so cookies,
    // uploads and the SSE stream all behave the way they will when deployed.
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
