import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  tsconfig: "tsconfig.production.json",
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@prymeira-talk/shared"]
});
