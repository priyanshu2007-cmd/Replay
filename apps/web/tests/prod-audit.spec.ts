import { test, expect } from '@playwright/test';

test.describe('Production Website Live Audit (https://replay-blond-psi.vercel.app)', () => {
  test('1. Homepage loads, displays readiness banner and truthful mode', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop a bug video');
    await expect(page.getByText('Replay watches the recording')).toBeVisible();

    // Check readiness banner
    const readinessText = page.getByText('Serverless Demo Mode: Live model key / background Docker worker are not attached');
    await expect(readinessText).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Recheck readiness' })).toBeVisible();
  });

  test('2. All 5 sample cards show "verified replay" badge and valid WebM preview', async ({ page }) => {
    await page.goto('/');
    const sampleTitles = [
      'Cart total becomes NaN after clearing quantity field',
      'Double-clicking Apply applies the discount twice',
      'String-based sort places $100 before $20',
      'Checkout accepts an empty email address',
      'Quantity resets after page navigation',
    ];

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBe(5);

    // Assert "Recording not available" is NOT anywhere on the page
    await expect(page.getByText('Recording not available')).toHaveCount(0);

    for (let i = 0; i < 5; i++) {
      const card = cards.nth(i);
      const title = sampleTitles[i];
      if (title) {
        await expect(card.getByRole('heading', { level: 3 })).toContainText(title);
      }
      await expect(card.getByText('verified replay')).toBeVisible();

      // "Run sample" button must be enabled
      const runBtn = card.getByRole('button', { name: 'Run sample' });
      await expect(runBtn).toBeVisible();
      await expect(runBtn).toBeEnabled();

      // Check video loads metadata
      const video = card.locator('video');
      await expect(video).toBeVisible();
      const dims = await video.evaluate((v: HTMLVideoElement) => {
        return new Promise<{ w: number; h: number; d: number }>((resolve) => {
          if (v.readyState >= 1) {
            resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          } else {
            v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          }
        });
      });
      expect(dims.w).toBeGreaterThan(0);
      expect(dims.h).toBeGreaterThan(0);
      expect(dims.d).toBeGreaterThan(0);

      // Preview button exists and is visible
      const previewBtn = card.getByRole('button', { name: /^Play preview for/ }).or(card.getByRole('button', { name: 'Preview' }));
      await expect(previewBtn).toBeVisible();
    }
  });

  test('3. Upload Dropzone clearly indicates why "Run on this video" is disabled before selection', async ({ page }) => {
    await page.goto('/');
    const runOnVideoBtn = page.getByRole('button', { name: 'Run on this video' });
    await expect(runOnVideoBtn).toBeVisible();
    await expect(runOnVideoBtn).toBeDisabled();
    await expect(page.getByText('Choose a .webm or .mp4 bug recording above to enable Run on this video.')).toBeVisible();
  });

  test('4. Run sample navigates to run workspace and displays complete pipeline evidence', async ({ page }) => {
    await page.goto('/');
    const firstCard = page.locator('article').first();
    const runBtn = firstCard.getByRole('button', { name: 'Run sample' });
    await runBtn.click();

    // Navigates to /runs/d0000001-0000-4000-8000-000000000001
    await page.waitForURL(/\/runs\/d0000001-0000-4000-8000-000000000001/, { timeout: 15_000 });

    // Workspace elements
    await expect(page.getByRole('heading', { name: /d0000001/ })).toBeVisible();
    await expect(page.getByText('FIXED').first()).toBeVisible();

    // Check tabs
    const suspectsTab = page.getByRole('tab', { name: 'Suspects' });
    const testTab = page.getByRole('tab', { name: 'Test' });
    const diffTab = page.getByRole('tab', { name: 'Diff' });
    const terminalTab = page.getByRole('tab', { name: 'Terminal' });

    await expect(suspectsTab).toBeVisible();
    await expect(testTab).toBeVisible();
    await expect(diffTab).toBeVisible();
    await expect(terminalTab).toBeVisible();

    // Suspects tab contains src/App.tsx
    await suspectsTab.click();
    await expect(page.getByText('src/App.tsx').first()).toBeVisible();

    // Test tab contains Playwright test
    await testTab.click();
    await expect(page.getByText('test(').or(page.getByText('expect(')).first()).toBeVisible();

    // Diff tab contains unified diff
    await diffTab.click();
    await expect(page.getByText('diff --git').or(page.getByText('handleQuantityChange')).first()).toBeVisible();

    // Action buttons
    await expect(page.getByRole('button', { name: 'Copy patch' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy as GitHub issue' })).toBeVisible();
    await testTab.click();
    await expect(page.getByRole('button', { name: 'Download test' })).toBeVisible();
  });

  test('5. Reel assistant opens, provides natural Q&A, and executes guiding actions', async ({ page }) => {
    await page.goto('/');
    const openHelpBtn = page.getByRole('button', { name: 'Open Reel help' });
    await expect(openHelpBtn).toBeVisible({ timeout: 15_000 });
    await openHelpBtn.click();

    // Reel dialog opens
    const dialog = page.getByRole('dialog', { name: 'Reel companion help' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Reel').first()).toBeVisible();

    // Click quick suggestion action "Open sample section"
    const openSampleAction = dialog.getByRole('button', { name: 'Open sample section' });
    await expect(openSampleAction).toBeVisible();
    await openSampleAction.click();

    // Natural conversation input
    const questionInput = dialog.getByPlaceholder('Ask why, about Fixer, samples, or uploads...');
    await expect(questionInput).toBeVisible();
    await questionInput.fill('Why is recording not available?');
    await dialog.getByRole('button', { name: 'Ask' }).click();

    // Reel responds
    await expect(dialog.getByText(/All five Demo Shop sample WebM files are verified/)).toBeVisible({ timeout: 5000 });

    // Close button
    await dialog.getByRole('button', { name: 'Close Reel help' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('6. Benchmark and How routes load properly', async ({ page }) => {
    await page.goto('/benchmark');
    await expect(page.getByRole('heading', { name: 'Benchmark' })).toBeVisible();

    await page.goto('/how');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('How Replay Works')).toBeVisible();
  });

  test('7. Responsive viewports without horizontal overflow', async ({ page }) => {
    const viewports = [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `Overflow at ${vp.width}x${vp.height}`).toBeLessThanOrEqual(0);
    }
  });
});
