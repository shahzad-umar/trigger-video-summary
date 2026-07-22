import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_ygtkllhkrjezlbqczrrh",
  runtime: "node",
  retryWithExponentialBackoff: {
    initialDelayInMs: 1000,
    maxDelayInMs: 60000,
    maxAttempts: 5,
  },
  triggerDirectories: ["./src/trigger"],
});
