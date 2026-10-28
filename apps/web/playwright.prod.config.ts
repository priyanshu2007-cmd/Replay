import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'prod-audit.spec.ts',
  retries: 0,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'https://replay-blond-psi.vercel.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
