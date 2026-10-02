import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The PostgreSQL/RabbitMQ suites run in parallel with the rest; 5 s is too tight under that load.
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
