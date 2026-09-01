import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const exampleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: exampleRoot,
  publicDir: resolve(exampleRoot, "../../public"),
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
  build: {
    outDir: resolve(exampleRoot, "../../dist-example"),
    emptyOutDir: true,
  },
});
