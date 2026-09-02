import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examples = [
  "all-in-one",
  "ethers",
  "wagmi",
  "private-key",
  "manual-payment",
];

for (const example of examples) {
  await build({
    configFile: resolve(repositoryRoot, "examples", example, "vite.config.ts"),
  });
}
