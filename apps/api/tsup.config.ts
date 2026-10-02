import { defineConfig } from "tsup";

export default defineConfig({
  entry: { ingress: "src/ingress.ts", "ingress-worker": "src/ingress-worker.ts", "ingress-recover": "src/ingress-recover.ts", "repair-waha-notices": "src/repair-waha-notices.ts", server: "src/server.ts", "evaluate-inbox-triage": "scripts/evaluate-inbox-triage.ts", "sync-villefer-agents": "scripts/sync-villefer-agents.ts" },
  tsconfig: "tsconfig.production.json",
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@prymeira-talk/shared"]
});
