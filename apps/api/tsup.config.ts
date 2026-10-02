import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts", "evaluate-inbox-triage": "scripts/evaluate-inbox-triage.ts", "sync-villefer-agents": "scripts/sync-villefer-agents.ts" },
  tsconfig: "tsconfig.production.json",
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@prymeira-talk/shared"]
});
