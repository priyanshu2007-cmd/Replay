import { defineConfig, devices } from '@playwright/test';

const port = process.env.DEMO_SHOP_PORT || '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: process.env.PLAYWRIGHT_TEST_MATCH ? process.env.PLAYWRIGHT_TEST_MATCH : ['**/baseline.spec.ts', '**/bugs.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  outputDir: './.playwright-results',
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.SANDBOX_TEST,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
