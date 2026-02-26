import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Dev proxy — avoids CORS entirely in local development.
    // In production (Vercel) VITE_API_URL points to the AWS backend directly.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      "/exports": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },

  build: {
    // Output dir used by Vercel automatically
    outDir: "dist",
    sourcemap: false,
  },
});
