import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The relay serves the built app from its own origin, so dev-mode requests are
// proxied to it (HTTP scene API + the /ws upgrade share the relay port).
export default defineConfig({
  plugins: [react()],
  define: {
    // Excalidraw checks this at runtime; set it so the React build is used.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    proxy: {
      "/scene": "http://localhost:3030",
      "/ws": { target: "ws://localhost:3030", ws: true },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
  },
});
