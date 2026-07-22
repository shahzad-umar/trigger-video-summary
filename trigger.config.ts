import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_ygtkllhkrjezlbqczrrh",
  runtime: "node",
  maxDuration: 300,
  retryWithExponentialBackoff: {
    initialDelayInMs: 1000,
    maxDelayInMs: 60000,
    maxAttempts: 5,
  },
  dirs: ["./src/trigger"],
});
