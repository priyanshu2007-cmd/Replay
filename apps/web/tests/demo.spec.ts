import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'docs/demo');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function displayCaption(page: any, text: string, subtitle?: string): Promise<void> {
  await page.evaluate(
    ({ msg, sub }: { msg: string; sub?: string }) => {
      let el = document.getElementById('replay-demo-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'replay-demo-caption';
        el.style.position = 'fixed';
        el.style.bottom = '28px';
        el.style.left = '50%';
        el.style.transform = 'translateX(-50%)';
        el.style.backgroundColor = 'rgba(10, 15, 29, 0.94)';
        el.style.border = '1px solid rgba(59, 130, 246, 0.4)';
        el.style.borderRadius = '10px';
        el.style.padding = '12px 24px';
        el.style.color = '#ffffff';
        el.style.zIndex = '999999';
        el.style.boxShadow = '0 20px 40px rgba(0,0,0,0.6), 0 0 15px rgba(59,130,246,0.2)';
        el.style.backdropFilter = 'blur(12px)';
        el.style.pointerEvents = 'none';
        el.style.maxWidth = '850px';
        el.style.textAlign = 'center';
        el.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
        document.body.appendChild(el);
      }
      el.innerHTML = `
        <div style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 15px; font-weight: 600; color: #f8fafc; letter-spacing: -0.01em;">
          ${msg}
        </div>
        ${
          sub
            ? `<div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: #94a3b8; margin-top: 4px;">${sub}</div>`
            : ''
        }
      `;
      el.style.opacity = '1';
    },
    { msg: text, sub: subtitle },
  );
}

test.use({
  viewport: { width: 1280, height: 720 },
  video: {
    mode: 'on',
    size: { width: 1280, height: 720 },
  },
});

test('record comprehensive Replay demo video', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 1. Create a demo run via API so data is immediately available
  const createRes = await request.post('http://localhost:3001/api/runs', {
    data: { sampleId: 'cart-nan' },
    headers: { 'Content-Type': 'application/json' },
  });
  const createdRun = (await createRes.json()) as { id: string };
  expect(createdRun.id).toBeTruthy();

  // 2. Open Home Page
  console.log('[demo] 1. Loading Home Page...');
  await page.goto('/', { waitUntil: 'networkidle' });
  await wait(1000);

  await displayCaption(
    page,
    'Replay: AI-Powered Video-to-Bug-Fix Agent',
    'Drop a recorded bug video. Get a failing reproduction test, verified patch, and proof.',
  );
  await wait(3500);

  // 3. Showcase Sample Bugs & Preview
  console.log('[demo] 2. Previewing bug recording...');
  await page.evaluate(() => window.scrollBy({ top: 380, behavior: 'smooth' }));
  await wait(1000);

  await displayCaption(
    page,
    'Step 1: Video Preview & Selection',
    'Hovering on Cart NaN sample plays original recording (Subtotal shows $NaN when quantity is cleared).',
  );

  const sampleCard = page.locator('article').first();
  await sampleCard.hover();
  await wait(3500);

  // 4. Launch Run Workspace
  console.log('[demo] 3. Opening Run Workspace...');
  await displayCaption(
    page,
    'Launching Pipeline Workspace',
    'Replay inspects video frames, locates culprit lines, writes a Playwright test, and patches the code.',
  );
  await wait(2000);

  await page.goto(`/runs/${createdRun.id}`, { waitUntil: 'networkidle' });
  await wait(1500);

  // 5. Watcher Stage
  console.log('[demo] 4. Highlighting Watcher Stage...');
  await displayCaption(
    page,
    'Step 2: Watcher Agent (NVIDIA Nemotron-3.5-VL)',
    'Vision model analyzes chronological video frames; pinpoints first visible defect at t=8.0s.',
  );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(3500);

  // 6. Locator Stage (Suspect Code)
  console.log('[demo] 5. Highlighting Locator Stage...');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('replay:focus-panel', { detail: { tab: 'suspects' } })),
  );
  await displayCaption(
    page,
    'Step 3: Locator Agent (Nemotron-3.5-Lightning)',
    'Pinpoints guilty symbol in src/App.tsx:84-105 (handleQuantityChange) with 95% confidence.',
  );
  await wait(3500);

  // 7. Reproducer Stage (Playwright Test)
  console.log('[demo] 6. Highlighting Reproducer Stage...');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('replay:focus-panel', { detail: { tab: 'test' } })),
  );
  await wait(1000);
  await displayCaption(
    page,
    'Step 4: Reproducer Agent (Nemotron-3-Ultra-550B)',
    'Writes automated Playwright reproduction test verifying cart total is not $NaN.',
  );
  await wait(3500);

  // 8. Verifier Stage (Execution Evidence)
  console.log('[demo] 7. Highlighting Verifier Stage...');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('replay:focus-panel', { detail: { tab: 'terminal' } })),
  );
  await wait(1000);
  await displayCaption(
    page,
    'Step 5: Verifier Agent (Evidence-Grounded Gate)',
    'Executes test in isolated sandbox; proves genuine defect reproduction (same symptom confirmed).',
  );
  await wait(3500);

  // 9. Fixer Stage (Surgical Patch)
  console.log('[demo] 8. Highlighting Fixer Stage...');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('replay:focus-panel', { detail: { tab: 'diff' } })),
  );
  await wait(1000);
  await displayCaption(
    page,
    'Step 6: Fixer Agent (Nemotron-3.5-Lightning)',
    'Generates minimal, surgical code patch: guards against NaN quantity in src/App.tsx.',
  );
  await wait(3500);

  // 10. Verification & Report
  console.log('[demo] 9. Highlighting Verification & Report...');
  await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
  await wait(1000);
  await displayCaption(
    page,
    'Step 7: Verification & Final Report (Nemotron-Nano-Omni)',
    'Sandbox re-run verifies reproduction test PASSES and baseline test suite stays 100% green.',
  );
  await wait(4000);

  // 11. Reel Assistant Companion
  console.log('[demo] 10. Highlighting Reel Mascot Assistant...');
  const mascotBtn = page.getByRole('button', { name: /Reel/i }).first();
  if (await mascotBtn.isVisible()) {
    await mascotBtn.click();
    await wait(1500);
    await displayCaption(
      page,
      'Reel Companion Assistant',
      'Interactive AI mascot explains each stage, answers questions, and guides navigation.',
    );
    await wait(3000);
    await page.keyboard.press('Escape');
  }

  // 12. Benchmark View
  console.log('[demo] 11. Navigating to Benchmark...');
  await page.goto('/benchmark', { waitUntil: 'networkidle' });
  await wait(1000);
  await displayCaption(
    page,
    'Benchmark Performance',
    'Evaluated across 5 benchmark bugs: 100% Top-3 Locator accuracy, verified end-to-end.',
  );
  await wait(3500);

  // 13. How It Works View
  console.log('[demo] 12. Navigating to Architecture...');
  await page.goto('/how', { waitUntil: 'networkidle' });
  await wait(1000);
  await displayCaption(
    page,
    'Multi-Agent Architecture & NVIDIA Models',
    'Orchestrated multi-agent pipeline hosted on Nebius Token Factory with strict sandbox boundaries.',
  );
  await wait(3500);

  await displayCaption(
    page,
    'Replay: Verified Bug Fixing From Video',
    'Zero hallucinations. Evidence-backed verification in isolated sandboxes.',
  );
  await wait(2500);

  // Finalize video
  await page.close();

  const video = page.video();
  if (video) {
    const rawPath = await video.path();
    const finalWebm = path.join(OUT_DIR, 'replay-demo.webm');
    const finalMp4 = path.join(OUT_DIR, 'replay-demo.mp4');

    await fs.copyFile(rawPath, finalWebm);
    console.log(`[demo] Saved WebM video to: ${finalWebm}`);

    try {
      console.log('[demo] Transcoding WebM to MP4 with FFmpeg...');
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        finalWebm,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '22',
        finalMp4,
      ]);
      console.log(`[demo] Saved MP4 video to: ${finalMp4}`);
    } catch (err) {
      console.warn('[demo] FFmpeg transcoding to MP4 skipped or failed:', err);
    }
  }
});
