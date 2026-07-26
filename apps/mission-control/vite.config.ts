import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 5174, not 5173: BuggyBoard's own frontend owns 5173 and both run during the demo.
// strictPort so a silent shift to another port can't land us outside the agents
// app's CORS allow-list.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
});
