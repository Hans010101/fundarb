import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.ts"]
  },
  server: {
    proxy: { "/api": "http://localhost:8787" }
  },
  build: { sourcemap: true }
});
