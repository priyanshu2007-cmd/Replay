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

  test('mascot renders on home, how, benchmark and stays off /dev/components', async ({ page }) => {
    const reel = page.getByRole('button', { name: /Reel, the Replay mascot/ });
    await page.goto('/');
    await expect(reel).toBeVisible({ timeout: 15000 });
    await page.goto('/how');
    await expect(reel).toBeVisible({ timeout: 15000 });
    await page.goto('/benchmark');
    await expect(reel).toBeVisible({ timeout: 15000 });
    await page.goto('/dev/components');
    await expect(reel).toHaveCount(0);
  });

  test('all five sample recordings serve real WebM and load metadata', async ({ page }) => {
    await page.goto('/');
    for (const id of ['cart-nan', 'double-discount', 'string-sort', 'empty-email', 'quantity-reset']) {
      const res = await page.request.get(`/samples/${id}.webm`);
      expect(res.status(), id).toBe(200);
      expect(res.headers()['content-type'], id).toContain('video/webm');
      const body = await res.body();
      expect(body.length, id).toBeGreaterThan(10_000);
      expect(body.subarray(0, 4).toString('hex'), id).toBe('1a45dfa3');
      const dims = await page.evaluate(
        (u) =>
          new Promise<{ w: number; h: number; d: number }>((resolve, reject) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
            v.onerror = () => reject(new Error('video error ' + u));
            v.src = u;
          }),
        `/samples/${id}.webm`,
      );
      expect(dims.w, id).toBeGreaterThan(0);
      expect(dims.h, id).toBeGreaterThan(0);
      expect(dims.d, id).toBeGreaterThan(0);
    }
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

  test('mascot playful reaction on click, interactive help popover, and minimize/restore pill', async ({ page }) => {
    await page.goto('/');
    const mascot = page.getByRole('button', { name: /Reel, the Replay mascot/ });
    await expect(mascot).toBeVisible({ timeout: 15000 });
    await mascot.click();

    // Clicking Reel opens the accessible help dialog
    const helpDialog = page.getByRole('dialog', { name: 'Reel companion help' });
    await expect(helpDialog).toBeVisible();
    await expect(helpDialog.getByRole('button', { name: 'Explain this stage' })).toBeVisible();
    await expect(helpDialog.getByRole('button', { name: 'Explain this failure' })).toBeVisible();
    await expect(helpDialog.getByRole('button', { name: 'What happens next?' })).toBeVisible();
    await expect(helpDialog.getByRole('button', { name: 'Open relevant evidence' })).toBeVisible();
    await expect(helpDialog.getByRole('button', { name: 'Replay the explanation' })).toBeVisible();

    await helpDialog.getByRole('button', { name: 'What happens next?' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/Select one of the five sample bugs|Next gate/i);

    await helpDialog.getByRole('button', { name: 'Replay the explanation' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/Pick a sample|red test/i);

    // Pressing Escape closes the help dialog
    await page.keyboard.press('Escape');
    await expect(helpDialog).toHaveCount(0);

    // Dedicated '?' help button also toggles help
    const openHelpBtn = page.getByRole('button', { name: 'Open Reel help' });
    await expect(openHelpBtn).toBeVisible();
    await openHelpBtn.click();
    await expect(helpDialog).toBeVisible();

    // Hide Reel minimizes into the persistent Restore Reel pill
    const hideButton = page.getByRole('button', { name: 'Hide Reel' });
    await expect(hideButton).toBeVisible();
    await hideButton.click();
    await expect(mascot).toHaveCount(0);

    const restoreButton = page.getByRole('button', { name: 'Restore Reel' });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();
    await expect(mascot).toBeVisible();
  });

  test('mascot enforces stage order, terminal state priority, and refuses false fix celebration', async ({ request, page }) => {
    const listRes = await request.get(`${API}/api/runs?limit=1`);
    const listData = (await listRes.json()) as { runs: Array<{ id: string }> };
    let runId = listData.runs[0]?.id;
    if (!runId) {
      const created = await request.post(`${API}/api/runs`, {
        data: { sampleId: 'cart-nan' },
        headers: { 'Content-Type': 'application/json' },
      });
      runId = ((await created.json()) as { id: string }).id;
    }

    await page.goto(`/runs/${runId}`);
    const mascot = page.getByRole('button', { name: /Reel, the Replay mascot/ });
    await expect(mascot).toBeVisible({ timeout: 15000 });

    // Dispatch out-of-order stage events and false-fix state event
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('replay:mascot', {
          detail: { kind: 'stage', stage: 'verify', runId: 'test-order-run' },
        }),
      );
    });
    await expect(mascot).toHaveAttribute('data-animation', 'curious');

    // Out-of-order earlier stage ('locate' < 'verify') must be ignored
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('replay:mascot', {
          detail: { kind: 'stage', stage: 'locate', runId: 'test-order-run' },
        }),
      );
    });
    await expect(mascot).toHaveAttribute('data-animation', 'curious');

    // False fix claim (state='fixed' with reproAfterFixPassed=false) must downgrade to 'confused', NEVER 'celebrate'
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('replay:mascot', {
          detail: {
            kind: 'state',
            state: 'fixed',
            runId: 'test-order-run',
            reproAfterFixPassed: false,
            baselineRegressionPassed: true,
          },
        }),
      );
    });
    await expect(mascot).toHaveAttribute('data-animation', 'confused');

    // Open Reel help on a run workspace and check Agent activity summary + Open relevant evidence
    await page.getByRole('button', { name: 'Open Reel help' }).click();
    const helpDialog = page.getByRole('dialog', { name: 'Reel companion help' });
    await expect(helpDialog).toContainText('Agent activity summary');
    await expect(helpDialog).toContainText('Watcher');
    await expect(helpDialog).toContainText('Fixer');
    await helpDialog.getByRole('button', { name: 'Open relevant evidence' }).click();
    await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('data-state', 'active');

    // Ask Reel natural questions on the run workspace
    const askInput = helpDialog.getByRole('textbox', { name: 'Ask Reel a question' });
    await expect(askInput).toBeVisible();
    await askInput.fill('What is the Fixer doing?');
    await helpDialog.getByRole('button', { name: 'Ask' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/Fixer|diff|sandbox/i);

    await askInput.fill('Did the fix pass the tests?');
    await helpDialog.getByRole('button', { name: 'Ask' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/reproduction test|baseline/i);
  });

  test('sample video assets, upload helper text, and Reel homepage/how guidance work end-to-end', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Recording not available')).toHaveCount(0);

    // Every sample card renders a <video> pointing to /samples/<id>.webm and an enabled Run sample button
    const videos = page.locator('article video');
    await expect(videos).toHaveCount(5);
    const runButtons = page.getByRole('button', { name: 'Run sample' });
    await expect(runButtons).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(runButtons.nth(i)).toBeEnabled();
    }

    // Upload dropzone explains why Run on this video is disabled before file selection
    const runUploadBtn = page.getByRole('button', { name: 'Run on this video' });
    await expect(runUploadBtn).toBeDisabled();
    await expect(page.getByText(/Choose a \.webm or \.mp4 bug recording above/i)).toBeVisible();

    // Open Reel on homepage and test interactive Q&A + guiding actions
    await page.getByRole('button', { name: 'Open Reel help' }).click();
    const helpDialog = page.getByRole('dialog', { name: 'Reel companion help' });
    const askInput = helpDialog.getByRole('textbox', { name: 'Ask Reel a question' });
    await askInput.fill('How do I upload my own video?');
    await helpDialog.getByRole('button', { name: 'Ask' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/50 MB|30s/i);

    await askInput.fill('Tell me about double-discount');
    await helpDialog.getByRole('button', { name: 'Ask' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/SAVE10/i);

    await helpDialog.getByRole('button', { name: 'Open upload guidance' }).click();
    await expect(helpDialog.getByRole('region')).toContainText(/Focused the upload dropzone/i);

    // Reel is also present and helpful on /how
    await page.goto('/how');
    await expect(page.getByRole('button', { name: /Reel, the Replay mascot/ })).toBeVisible();
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
