import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '@replay/shared';
import { BugReportSchema } from '@replay/shared';
import { SandboxUnavailableError } from '@replay/sandbox';
import { runFixAndVerifyPipeline, runPipeline } from './pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO_SHOP_DIR = path.join(ROOT, 'targets', 'demo-shop');

const CART_NAN_REPORT = BugReportSchema.parse({
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [{ timestamp_s: 2.5, description: 'Cleared quantity input' }],
  first_failure_timestamp_s: 2.5,
  expected_behavior: 'Cart total should recalculate or retain a valid number ($0.00)',
  actual_behavior: 'Cart total displays as $NaN',
  visible_text: ['Cart', '$NaN'],
  route: '/?bug=cart-nan',
  confidence: 0.95,
});

test('runFixAndVerifyPipeline stops early when reproduction fails verification', async () => {
  // Mock reproducer producing a passing test (so execution doesn't fail with defect)
  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'dummy pass',
          assertion: 'expect(true).toBe(true)',
          failure_message: 'none',
          test_code: `
            import { test, expect } from '@playwright/test';
            test('pass', async () => { expect(1).toBe(1); });
          `,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [
            {
              file: 'src/App.tsx',
              start_line: 84,
              end_line: 93,
              symbol: 'handleQuantityChange',
              confidence: 0.95,
              symptom_link: 'parseInt without fallback produces NaN',
              evidence: 'const qty = parseInt(rawValue, 10);',
            },
          ],
          suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const result = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
    }
  );

  // Verifier detects UNEXPECTED_PASS and aborts before fixer is ever called!
  assert.equal(result.status, 'unreproduced');
  assert.equal(result.verifierOutput?.same_defect, false);
  assert.equal(result.verifierOutput?.classification, 'UNEXPECTED_PASS');
  assert.equal(result.attempts, 0);
  assert.equal(result.fixerOutput, undefined);

});

test('runFixAndVerifyPipeline executes end-to-end and fixes cart-nan in isolated sandbox', async () => {
  // Provide mock clients for locator, reproducer, and fixer to test deterministic pipeline execution
  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [
            {
              file: 'src/App.tsx',
              start_line: 84,
              end_line: 93,
              symbol: 'handleQuantityChange',
              confidence: 0.95,
              symptom_link: 'parseInt without fallback produces NaN',
              evidence: 'const qty = parseInt(rawValue, 10);',
            },
          ],
          suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 50, model: 'test' },
      };
    },
  };

  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'cart total does not become NaN',
          assertion: "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
          failure_message: "Expected not '$NaN', received '$NaN'",
          test_code: `
import { test, expect } from '@playwright/test';

test.describe('Reproduction: Cart NaN', () => {
  test('cart total does not become NaN after clearing quantity', async ({ page }) => {
    await page.goto('/?bug=cart-nan');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('');
    await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
  });
});
          `,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 50, model: 'test' },
      };
    },
  };

  // The surgical fix: validates rawValue and falls back to 0
  const mockFixerClient = {
    async callJson<T>() {
      return {
        data: {
          fixed: true,
          target_file: 'src/App.tsx',
          explanation: 'Validate integer parsing and fallback to 0 when input is empty string.',
          original_snippet: `    if (activeBug === 'cart-nan') {
      // BUG 1: Unvalidated parseInt on empty string produces NaN in state
      const qty = parseInt(rawValue, 10);
      setCart((prev) =>
        prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
      );
      return;
    }`,
          replacement_snippet: `    if (activeBug === 'cart-nan') {
      let qty = parseInt(rawValue, 10);
      if (isNaN(qty) || qty < 0) qty = 0;
      setCart((prev) =>
        prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
      );
      return;
    }`,
          patch: '--- a/src/App.tsx\n+++ b/src/App.tsx',
          attempts: 1,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 200, completionTokens: 100, totalTokens: 300, durationMs: 100, model: 'test' },
      };
    },
  };

  const result = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
      maxFixAttempts: 1,
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
      fixerDeps: { client: mockFixerClient },
    }
  );

  // 1. Defect was verified before fix (failed with AssertionError)
  assert.equal(result.reproBeforeFixFailed, true);
  assert.equal(result.verifierOutput?.same_defect, true);

  // 2. Patch applied in sandbox made the repro test pass!
  assert.equal(result.reproAfterFixPassed, true);

  // 3. Baseline tests in sandbox remained green!
  assert.equal(result.baselineRegressionPassed, true);

  // 4. Overall status is 'fixed'
  assert.equal(result.status, 'fixed');
  assert.ok(result.summary.includes('successfully reproduced, verified, and fixed'));

  // 5. Reporter output is present and validated
  assert.ok(result.reporterOutput);
  assert.equal(result.reporterOutput.status, 'fixed');
  assert.equal(result.reporterOutput.verification.repro_after_fix_passed, true);
  assert.equal(result.reporterOutput.verification.baseline_regression_passed, true);
  assert.ok(result.reporterOutput.markdown_report.includes('Replay Run Report — FIXED'));
});

test('runPipeline emits chronological RunEvents across stages and validates sequence', async () => {
  const events: any[] = [];
  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [{ file: 'src/App.tsx', start_line: 84, end_line: 93, symbol: 'handleQuantityChange', confidence: 0.95, symptom_link: 'link' }],
          suggested_test_selectors: [],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'test pass',
          assertion: 'expect(1).toBe(1)',
          failure_message: '',
          test_code: "import { test, expect } from '@playwright/test'; test('t', async () => { expect(1).toBe(1); });",
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const res = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
      onEvent: (e) => {
        events.push(e);
      },
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
    }
  );

  assert.ok(events.length >= 5);
  // Verify sequential ordering
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1);
    assert.equal(events[i].run_id, res.runId);
  }
  const stages = events.map(e => e.stage);
  assert.ok(stages.includes('ingest'));
  assert.ok(stages.includes('watch'));
  assert.ok(stages.includes('locate'));
  assert.ok(stages.includes('reproduce'));
  assert.ok(stages.includes('verify'));
  assert.ok(stages.includes('report'));
  assert.equal(res.status, 'unreproduced');
});

test('runPipeline executes live Watcher frame extraction and passes base64 frames + note to vision model', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-watch-test-'));
  try {
    const fakeVideoPath = path.join(tmpDir, 'recording.webm');
    await fs.promises.writeFile(fakeVideoPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]));

    let capturedMessages: any[] = [];
    const mockWatcherClient = {
      async callJson<T>(_model: string, messages: any[]) {
        capturedMessages = messages;
        return {
          data: CART_NAN_REPORT as unknown as T,
          rawText: JSON.stringify(CART_NAN_REPORT),
          metrics: { promptTokens: 40, completionTokens: 20, totalTokens: 60, durationMs: 15, model: 'test-vlm' },
        };
      },
    };
    const mockLocatorClient = {
      async callJson<T>() {
        return {
          data: {
            suspects: [{ file: 'src/App.tsx', start_line: 84, end_line: 93, symbol: 'handleQuantityChange', confidence: 0.95, symptom_link: 'link' }],
            suggested_test_selectors: [],
            route: '/?bug=cart-nan',
          } as unknown as T,
          rawText: '{}',
          metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
        };
      },
    };
    const mockReproClient = {
      async callJson<T>() {
        return {
          data: {
            reproduced: true,
            test_name: 'test pass',
            assertion: 'expect(1).toBe(1)',
            failure_message: '',
            test_code: "import { test, expect } from '@playwright/test'; test('t', async () => { expect(1).toBe(1); });",
          } as unknown as T,
          rawText: '{}',
          metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
        };
      },
    };

    const events: any[] = [];
    const res = await runPipeline(
      {
        targetRepoRoot: DEMO_SHOP_DIR,
        sampleId: 'cart-nan',
        videoPath: fakeVideoPath,
        note: 'User cleared quantity and saw $NaN',
        artifactsDir: tmpDir,
        onEvent: (e: RunEvent) => { events.push(e); },
      },
      {
        videoDeps: {
          hasFfmpeg: async () => true,
          extractKeyframes: async (_vp: string, outDir: string) => {
            await fs.promises.mkdir(outDir, { recursive: true });
            const frameFile = path.join(outDir, 'frame_0001.jpg');
            await fs.promises.writeFile(frameFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            return [{ index: 1, timestampS: 2.5, filename: 'frame_0001.jpg', filePath: frameFile }];
          },
        },
        watcherDeps: { client: mockWatcherClient },
        locatorDeps: { client: mockLocatorClient },
        reproducerDeps: { client: mockReproClient },
        sandboxDeps: {
          createSandbox: async () => ({
            workDir: tmpDir,
            mode: 'host',
            exec: async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', durationMs: 5, timedOut: false }),
            cleanup: async () => {},
          }) as any,
        },
      }
    );

    assert.equal(res.videoAnalysis, 'live');
    assert.equal(res.totalTokens, 100);
    assert.ok(events.some((e) => e.event_type === 'watch_fixture_comparison'));
    assert.ok(!events.some((e) => e.event_type === 'watch_fixture_fallback'));

    const userParts = capturedMessages[1]?.content;
    assert.ok(Array.isArray(userParts));
    assert.ok(userParts.some((p: any) => p.type === 'text' && p.text.includes('User cleared quantity and saw $NaN')));
    assert.ok(userParts.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')));
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPipeline handles frame extraction failure with explicit fixture_assisted fallback on sample and cleans up framesDir', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-extract-fail-'));
  const extractFailRunId = '00000000-0000-4000-8000-000000000042';
  try {
    const fakeVideoPath = path.join(tmpDir, 'corrupt.webm');
    await fs.promises.writeFile(fakeVideoPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

    const events: any[] = [];
    const res = await runPipeline(
      {
        runId: extractFailRunId,
        targetRepoRoot: DEMO_SHOP_DIR,
        sampleId: 'cart-nan',
        videoPath: fakeVideoPath,
        artifactsDir: tmpDir,
        onEvent: (e: RunEvent) => { events.push(e); },
      },
      {
        videoDeps: {
          hasFfmpeg: async () => true,
          extractKeyframes: async (_vp: string, outDir: string) => {
            await fs.promises.mkdir(outDir, { recursive: true });
            await fs.promises.writeFile(path.join(outDir, 'partial.jpg'), 'partial');
            throw new Error('FFmpeg exited with code 1: corrupt stream');
          },
        },
        watcherDeps: {
          client: {
            async callJson() {
              throw new Error('Should not call watcher when extraction fails');
            },
          },
        },
        locatorDeps: {
          client: {
            async callJson<T>() {
              return {
                data: {
                  suspects: [{ file: 'src/App.tsx', start_line: 84, end_line: 93, symbol: 'handleQuantityChange', confidence: 0.95, symptom_link: 'link' }],
                  suggested_test_selectors: [],
                  route: '/?bug=cart-nan',
                } as unknown as T,
                rawText: '{}',
                metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
              };
            },
          },
        },
        reproducerDeps: {
          client: {
            async callJson<T>() {
              return {
                data: {
                  reproduced: true,
                  test_name: 'test pass',
                  assertion: 'expect(1).toBe(1)',
                  failure_message: '',
                  test_code: "import { test, expect } from '@playwright/test'; test('t', async () => { expect(1).toBe(1); });",
                } as unknown as T,
                rawText: '{}',
                metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
              };
            },
          },
        },
        sandboxDeps: {
          createSandbox: async () => ({
            workDir: tmpDir,
            mode: 'host',
            exec: async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', durationMs: 5, timedOut: false }),
            cleanup: async () => {},
          }) as any,
        },
      }
    );

    assert.equal(res.videoAnalysis, 'fixture_assisted');
    assert.ok(events.some((e) => e.event_type === 'watch_extraction_error'));
    assert.ok(events.some((e) => e.event_type === 'watch_fixture_fallback'));
    // Partial frames directory must be cleaned up on failure
    assert.equal(fs.existsSync(path.join(tmpDir, 'frames', extractFailRunId)), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPipeline rejects uploaded video when Watcher or FFmpeg fails and never fabricates sample fixture from uploads path', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-upload-fail-'));
  try {
    // Even if an upload path contains "samples/cart-nan", uploads/ must never get sample fixture fallback
    const spoofedUploadDir = path.join(tmpDir, 'uploads', 'samples');
    await fs.promises.mkdir(spoofedUploadDir, { recursive: true });
    const uploadedVideoPath = path.join(spoofedUploadDir, 'cart-nan.webm');
    await fs.promises.writeFile(uploadedVideoPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

    const events: any[] = [];
    await assert.rejects(
      () =>
        runPipeline(
          {
            targetRepoRoot: DEMO_SHOP_DIR,
            videoPath: uploadedVideoPath,
            artifactsDir: tmpDir,
            onEvent: (e: RunEvent) => { events.push(e); },
          },
          {
            videoDeps: {
              hasFfmpeg: async () => false,
            },
          }
        ),
      /Cannot analyze the uploaded video: ffmpeg is not installed/
    );

    assert.ok(events.some((e) => e.event_type === 'watch_failed'));
    assert.ok(!events.some((e) => e.event_type === 'watch_fixture_fallback'));
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPipeline fails closed when sandbox is unavailable and never claims reproduction test ran', async () => {
  const events: any[] = [];
  const res = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
      onEvent: (e: RunEvent) => { events.push(e); },
    },
    {
      locatorDeps: {
        client: {
          async callJson<T>() {
            return {
              data: {
                suspects: [{ file: 'src/App.tsx', start_line: 84, end_line: 93, symbol: 'handleQuantityChange', confidence: 0.95, symptom_link: 'link' }],
                suggested_test_selectors: [],
                route: '/?bug=cart-nan',
              } as unknown as T,
              rawText: '{}',
              metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
            };
          },
        },
      },
      reproducerDeps: {
        client: {
          async callJson<T>() {
            return {
              data: {
                reproduced: true,
                test_name: 'repro',
                assertion: 'expect(1).toBe(2)',
                failure_message: '1 !== 2',
                test_code: "import { test, expect } from '@playwright/test'; test('t', async () => { expect(1).toBe(2); });",
              } as unknown as T,
              rawText: '{}',
              metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 5, model: 'test' },
            };
          },
        },
      },
      sandboxDeps: {
        createSandbox: async () => {
          throw new SandboxUnavailableError('Docker daemon is unreachable in production');
        },
      },
    }
  );

  assert.equal(res.status, 'failed');
  assert.equal(res.reproBeforeFixFailed, false);
  assert.equal(res.reproAfterFixPassed, false);
  assert.equal(res.baselineRegressionPassed, false);
  assert.ok(res.summary.includes('Execution blocked'));
  const verifyCompleted = events.find((e) => e.event_type === 'verify_completed');
  assert.ok(verifyCompleted);
  assert.equal(verifyCompleted.payload.sandbox_blocked, true);
  assert.equal(verifyCompleted.payload.same_defect, false);
});


