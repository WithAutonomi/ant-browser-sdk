import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type UserConfig } from "vite";

export function exampleConfig(
  configUrl: string,
  name: string,
  port: number,
): UserConfig {
  const exampleRoot = fileURLToPath(new URL(".", configUrl));
  return defineConfig({
    root: exampleRoot,
    publicDir: resolve(exampleRoot, "../../public"),
    server: {
      host: "127.0.0.1",
      port,
    },
    build: {
      outDir: resolve(exampleRoot, `../../dist-examples/${name}`),
      emptyOutDir: true,
    },
  });
}
