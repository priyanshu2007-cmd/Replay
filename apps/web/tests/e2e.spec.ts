import { test, expect } from '@playwright/test';

// The API runs on its own port; the page under test is the web server.
const API = 'http://localhost:3001';

test.describe('Replay web', () => {
  test('home loads with sample cards and the promise line', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop a bug video');
    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(3);
  });

  test('run view shows video panel, timeline and code tabs', async ({ request, page }) => {
    const created = await request.post(`${API}/api/runs`, {
      data: { sampleId: 'cart-nan' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(created.ok()).toBeTruthy();
    const run = (await created.json()) as { id: string };

    await page.goto(`/runs/${run.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel('Bug recording')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Agent timeline' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Run artifacts' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Evidence' })).toBeVisible();
  });

  test('unknown run id renders the honest error state', async ({ page }) => {
    await page.goto('/runs/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Run not found' })).toBeVisible({ timeout: 15000 });
  });

  test('no horizontal scroll at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(1000);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('reduced motion is respected', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Skeletons stop pulsing under reduced motion.
    const pulsing = await page.locator('.animate-pulse:not(.motion-reduce\\:animate-none)').count();
    expect(pulsing).toBe(0);
  });

  test('mascot renders on home and stays off the how page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Reel, the Replay mascot/ })).toBeVisible({ timeout: 15000 });
    await page.goto('/how');
    await expect(page.getByRole('button', { name: /Reel, the Replay mascot/ })).toHaveCount(0);
  });

  test('benchmark shows the runs table or its empty state', async ({ page }) => {
    await page.goto('/benchmark');
    await expect(
      page.getByRole('heading', { name: 'Benchmark' }),
    ).toBeVisible();
    await expect(page.getByRole('table').or(page.getByText('No runs yet'))).toBeVisible({ timeout: 15000 });
  });

  test('upload rejects an unsupported file type with a clear message', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose a video file' }).click();
    const fc = await chooser;
    await fc.setFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a video'),
    });
    const uploadSection = page.getByRole('region', { name: 'Upload a bug recording' });
    await expect(uploadSection.getByRole('alert')).toContainText('not a supported video type');
  });

  test('theme toggle switches to light and back', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Switch to light theme' });
    await toggle.click();
    await expect(page.locator('html.light')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html.light')).toHaveCount(0);
  });

  test('keyboard shortcuts work on the video panel without touching text fields', async ({ request, page }) => {
    const created = await request.post(`${API}/api/runs`, {
      data: { sampleId: 'string-sort' },
      headers: { 'Content-Type': 'application/json' },
    });
    const run = (await created.json()) as { id: string };
    await page.goto(`/runs/${run.id}`);
    const panel = page.getByLabel('Bug recording');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await panel.focus();
    // Space on the focused panel toggles playback without a mouse.
    await panel.press(' ');
    const playing = await page.locator('video[controls]').evaluate((v) => !(v as HTMLVideoElement).paused);
    expect(playing).toBe(true);
  });

  test('clicking Run sample button starts a run and navigates to the run workspace', async ({ page }) => {
    await page.goto('/');
    const firstRunButton = page.getByRole('button', { name: 'Run sample' }).first();
    await expect(firstRunButton).toBeVisible({ timeout: 15000 });
    await expect(firstRunButton).toBeEnabled();
    await firstRunButton.click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+/, { timeout: 15000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByLabel('Bug recording')).toBeVisible();
  });

  test('header navigation links between home, how it works, and benchmark', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'How it works' }).click();
    await expect(page).toHaveURL(/\/how$/);
    await expect(page.getByRole('heading', { name: 'How Replay works' })).toBeVisible();

    await page.getByRole('link', { name: 'Benchmark' }).click();
    await expect(page).toHaveURL(/\/benchmark$/);
    await expect(page.getByRole('heading', { name: 'Benchmark' })).toBeVisible();

    await page.getByRole('link', { name: 'replay', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('code tabs can be switched between suspects, test, diff, and terminal', async ({ request, page }) => {
    const created = await request.post(`${API}/api/runs`, {
      data: { sampleId: 'cart-nan' },
      headers: { 'Content-Type': 'application/json' },
    });
    const run = (await created.json()) as { id: string };
    await page.goto(`/runs/${run.id}`);

    const tablist = page.getByRole('tablist', { name: 'Run artifacts' });
    await expect(tablist).toBeVisible({ timeout: 15000 });

    // Test tab
    await page.getByRole('tab', { name: 'Test' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();

    // Diff tab
    await page.getByRole('tab', { name: 'Diff' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();

    // Terminal tab
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();

    // Back to Suspects
    await page.getByRole('tab', { name: 'Suspects' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  });

  test('mascot playful reaction on click and minimize button hide', async ({ page }) => {
    await page.goto('/');
    const mascot = page.getByRole('button', { name: /Reel, the Replay mascot/ });
    await expect(mascot).toBeVisible({ timeout: 15000 });
    await mascot.click();

    const hideButton = page.getByRole('button', { name: 'Hide Reel' });
    await expect(hideButton).toBeVisible();
    await hideButton.click();
    await expect(mascot).toHaveCount(0);
  });

  test('responsive layout verification across 1440, 1280, 768, 390, and 320 viewports', async ({ page }) => {
    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `Overflow detected at ${width}px`).toBeLessThanOrEqual(0);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });
});
