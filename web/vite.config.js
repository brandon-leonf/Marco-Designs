import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs work both at localhost `/` and at a GitHub Pages
  // project path such as `/Marco-Designs/`.
  base: "./",
  plugins: [react()],
});
