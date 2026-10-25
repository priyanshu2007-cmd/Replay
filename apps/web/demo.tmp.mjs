import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: '/tmp/replay-demo', size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
// Click the cart-nan sample (proven green in the benchmark)
await page.locator('article').filter({ hasText: 'cart-nan' }).getByRole('button', { name: 'Run sample' }).click();
await page.waitForURL(/\/runs\//, { timeout: 20000 });
console.log('run page:', page.url());
// Wait for the terminal verdict (live pipeline takes ~50-70s)
await page.getByText('PASSING').waitFor({ timeout: 240000 });
console.log('verdict reached');
await page.waitForTimeout(4000);
await page.screenshot({ path: '../docs/demo/demo-final-state.png' });
await context.close();
await browser.close();
console.log('video captured');
