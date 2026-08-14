import { defineConfig } from "vite";
import { markdownPlugin } from "./vite-plugins/markdown";

// GeoLibre loads an external plugin by fetching `entry` from plugin.json and
// running it through `import(URL.createObjectURL(...))`. Relative imports inside
// the bundle are never resolved by that loader, so the entry must be one
// self-contained ES module. Hence library mode with inlineDynamicImports.
//
// @google/earthengine is bundled rather than externalised: its package `browser`
// field points at build/browser.js, which Vite picks up automatically for a
// browser target, avoiding the Node-only googleapis dependency in build/main.js.
export default defineConfig({
  plugins: [markdownPlugin()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith(".css")) ? "style.css" : "[name][extname]",
      },
    },
  },
  define: {
    // The EE browser bundle probes for a CommonJS environment.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
