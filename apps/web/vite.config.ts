import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** Writes version.json next to the build: the name of the entry script, which changes with every release. An open
 * page compares it with the script it is running to tell the user that a new version is out. */
function buildVersion(): Plugin {
  return {
    name: "talk-build-version",
    apply: "build",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(file => file.type === "chunk" && file.isEntry);
      if (entry) this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: entry.fileName }) });
    }
  };
}

export default defineConfig({
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react(), buildVersion()],
  server: {
    port: 5176
  }
});
