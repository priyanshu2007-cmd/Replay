/**
 * Records genuine Demo Shop bug videos with Playwright against the real app.
 * Each clip triggers one planted bug via the existing ?bug= mechanism and is
 * saved as samples/videos/<fixture-id>.webm — one video per expected fixture.
 * Existing recordings are never overwritten (idempotent: skip when present).
 *
 * Run: pnpm --filter @replay/demo-shop record:samples
 */
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SHOP_DIR = path.resolve(moduleDir, '..');
const ROOT = path.resolve(SHOP_DIR, '../..');
const OUT_DIR = path.join(ROOT, 'samples', 'videos');
const BASE = 'http://localhost:5173';
const VIEWPORT = { width: 1280, height: 800 };

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startPreview(): Promise<ChildProcess | null> {
  if (await isServerUp()) {
    console.log(`[rec] ${BASE} already serving — reusing`);
    return null;
  }
  const viteBin = path.join(SHOP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', '5173', '--strictPort'], {
    cwd: SHOP_DIR,
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    if (await isServerUp()) return child;
    await wait(500);
  }
  child.kill('SIGTERM');
  throw new Error('preview server did not come up on :5173 within 30s');
}

interface Scenario {
  id: string;
  bug: string;
  title: string;
  run: (page: Page) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    id: 'cart-nan',
    bug: 'cart-nan',
    title: 'Cart total becomes NaN after clearing quantity',
    run: async page => {
      await page.goto(`${BASE}/?bug=cart-nan`);
      await wait(2500);
      await page.getByTestId('add-to-cart-prod-mouse').click();
      await wait(1800);
      await page.getByTestId('nav-cart').click();
      await wait(2500);
      await page.getByTestId('cart-item-qty-prod-mouse').fill('');
      await wait(3500); // $NaN total stays visible
    },
  },
  {
    id: 'double-discount',
    bug: 'double-discount',
    title: 'Coupon discount applied twice',
    run: async page => {
      await page.goto(`${BASE}/?bug=double-discount`);
      await wait(2500);
      await page.getByTestId('add-to-cart-prod-keyboard').click();
      await wait(1800);
      await page.getByTestId('nav-cart').click();
      await wait(2200);
      await page.getByTestId('coupon-input').fill('SAVE10');
      await wait(1200);
      await page.getByTestId('apply-coupon-btn').click();
      await wait(1800); // 10% applied — $90
      await page.getByTestId('apply-coupon-btn').click();
      await wait(3500); // second click — $80 with $20 discount visible
    },
  },
  {
    id: 'string-sort',
    bug: 'string-sort',
    title: 'Price sorting compares strings',
    run: async page => {
      await page.goto(`${BASE}/?bug=string-sort`);
      await wait(2500);
      await page.getByTestId('sort-select').selectOption('price-asc');
      await wait(4000); // $100 keyboard listed first, before $15 and $20
    },
  },
  {
    id: 'empty-email',
    bug: 'empty-email',
    title: 'Checkout accepts blank email',
    run: async page => {
      await page.goto(`${BASE}/?bug=empty-email`);
      await wait(2200);
      await page.getByTestId('add-to-cart-prod-mouse').click();
      await wait(1500);
      await page.getByTestId('nav-cart').click();
      await wait(2000);
      await page.getByTestId('proceed-to-checkout-btn').click();
      await wait(2000);
      await page.getByTestId('checkout-btn').click();
      await wait(3500); // order confirmed with no email
    },
  },
  {
    id: 'quantity-reset',
    bug: 'quantity-reset',
    title: 'Cart quantity resets after navigation',
    run: async page => {
      await page.goto(`${BASE}/?bug=quantity-reset`);
      await wait(2500);
      await page.getByTestId('add-to-cart-prod-mouse').click();
      await wait(1500);
      await page.getByTestId('nav-cart').click();
      await wait(2000);
      await page.getByTestId('cart-item-qty-prod-mouse').fill('5');
      await wait(2000); // $100 total
      await page.getByTestId('nav-shop').click();
      await wait(1800);
      await page.getByTestId('nav-cart').click();
      await wait(3500); // quantity back to 1, $20 total
    },
  },
];

async function recordOne(browser: Browser, scenario: Scenario): Promise<void> {
  const dest = path.join(OUT_DIR, `${scenario.id}.webm`);
  if (await fs.stat(dest).then(() => true, () => false)) {
    console.log(`[rec] ${scenario.id}: already exists — skipping (never overwrite)`);
    return;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `replay-rec-${scenario.id}-`));
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: tmpDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  const started = Date.now();
  try {
    await scenario.run(page);
    const video = page.video();
    await context.close();
    if (!video) throw new Error('no video track recorded');
    const tmpVideo = await video.path();
    await fs.copyFile(tmpVideo, dest);
    console.log(`[rec] ${scenario.id}: recorded ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path.relative(ROOT, dest)}`);
  } catch (err) {
    await context.close().catch(() => {});
    console.error(`[rec] ${scenario.id}: FAILED — ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const only = process.argv[2];
  const selected = only ? scenarios.filter(s => s.id === only) : scenarios;
  if (selected.length === 0) {
    console.error(`no scenario named '${only}' (ids: ${scenarios.map(s => s.id).join(', ')})`);
    process.exit(1);
  }
  const server = await startPreview();
  const browser = await chromium.launch();
  try {
    for (const s of selected) {
      await recordOne(browser, s);
    }
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
      console.log('[rec] preview server stopped');
    }
  }
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
