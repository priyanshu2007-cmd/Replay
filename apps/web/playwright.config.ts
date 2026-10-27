import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

const apiEntry = path.join(__dirname, '../../apps/api/dist/server.js');

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['github']],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm run build && pnpm run start',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: { ...process.env, REPLAY_RATE_LIMIT_MAX: '50' },
    },
    {
      command: `node ${apiEntry}`,
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...process.env, REPLAY_RATE_LIMIT_MAX: '50' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
