import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./frontend/test/browser",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:18192",
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node frontend/test/serve.cjs",
    url: "http://127.0.0.1:18192",
    reuseExistingServer: false,
  },
});
