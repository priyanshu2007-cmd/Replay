import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BugReport,
  BugReportSchema,
  FixerOutput,
  LocatorOutput,
  ReporterOutput,
  ReproducerOutput,
  RunEvent,
  RunEventSchema,
  RunStage,
  RunState,
  VerifierOutput,
} from '@replay/shared';
import { IsolatedWorkspaceSandbox, SandboxUnavailableError } from '@replay/sandbox';
import { packRepository, RepoBundle } from './packer.js';
import { fixtureToBugReport, locateSuspects, LocatorDeps, SampleFixtureSchema } from './locator.js';
import { allocateSandboxPort, executeReproductionTest, generateReproduction, ReproducerDeps } from './reproducer.js';
import { verifyReproduction, VerifierDeps } from './verifier.js';
import { redactSecretText, resolveApiKey, resolveModel, ModelMetrics, AgentRole } from './llm.js';
import { analyzeBugVideo } from './watcher.js';
import { VideoProcessor } from '@replay/video';
import { applyPatchToDirectory, FixerDeps, proposeFix } from './fixer.js';
import { generateReport, ReporterDeps } from './reporter.js';

/** Estimated cost from published Token Factory prices ($/1M tokens, in+out blended). Marked as estimate everywhere it is shown. */
const COST_PER_1M: Record<AgentRole, number> = {
  watcher: 0.60,
  verifier: 0.60,
  locator: 0.15,
  reproducer: 2.00,
  fixer: 2.00,
  reporter: 0.15,
};

export function estimateCostUsd(usage: Array<{ role: AgentRole; tokens: number }>): string {
  const dollars = usage.reduce((sum, u) => sum + (u.tokens / 1_000_000) * COST_PER_1M[u.role], 0);
  return dollars.toFixed(4);
}

/** Last N lines of process output for error events; secrets redacted. */
function outputTail(res: { stdout?: string; stderr?: string }, lines = 40): string {
  const text = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
  if (!text) return '';
  return redactSecretText(text.split('\n').slice(-lines).join('\n')).slice(0, 4000);
}


export interface PipelineOptions {
  targetRepoRoot: string;
  sampleId?: string;
  videoPath?: string;
  note?: string;
  bugReport?: BugReport;
  targetAppUrl?: string;
  maxFixAttempts?: number;
  runId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  artifactsDir?: string;
}

export interface PipelineDeps {
  watcherDeps?: import('./watcher.js').WatcherDeps;
  locatorDeps?: LocatorDeps;
  reproducerDeps?: ReproducerDeps;
  verifierDeps?: VerifierDeps;
  fixerDeps?: FixerDeps;
  reporterDeps?: ReporterDeps;
  videoDeps?: {
    checkFfmpeg?: () => Promise<boolean>;
    hasFfmpeg?: () => Promise<boolean>;
    extractFrames?: (videoPath: string, outputDir: string) => Promise<import('@replay/video').FrameInfo[]>;
    extractKeyframes?: (videoPath: string, outputDir: string) => Promise<import('@replay/video').FrameInfo[]>;
  };
  sandboxDeps?: {
    create?: typeof IsolatedWorkspaceSandbox.create;
    createSandbox?: typeof IsolatedWorkspaceSandbox.create;
  };
}

const KNOWN_SAMPLE_IDS_SET = new Set([
  'cart-nan',
  'double-discount',
  'string-sort',
  'empty-email',
  'quantity-reset',
]);

export interface PipelineRunResult {
  runId: string;
  status: RunState;
  totalTokens: number;
  estimatedCostUsd: string;
  sampleId?: string;
  videoAnalysis: 'live' | 'fixture_assisted' | 'none';
  bugReport: BugReport;
  bundle: RepoBundle;
  locatorOutput?: LocatorOutput;
  reproducerOutput?: ReproducerOutput;
  verifierOutput?: VerifierOutput;
  fixerOutput?: FixerOutput;
  reporterOutput: ReporterOutput;
  reproBeforeFixFailed: boolean;
  reproAfterFixPassed: boolean;
  baselineRegressionPassed: boolean;
  attempts: number;
  durationMs: number;
  events: RunEvent[];
  summary: string;
}

class EventCollector {
  private seq = 0;
  public events: RunEvent[] = [];

  constructor(
    private runId: string,
    private onEvent?: (event: RunEvent) => void | Promise<void>
  ) {}

  async emit(stage: RunStage, eventType: string, agent: string, payload: Record<string, unknown> = {}): Promise<RunEvent> {
    this.seq++;
    const event: RunEvent = RunEventSchema.parse({
      run_id: this.runId,
      seq: this.seq,
      stage,
      event_type: eventType,
      agent,
      payload,
      timestamp: new Date().toISOString(),
    });
    this.events.push(event);
    if (this.onEvent) {
      try {
        await this.onEvent(event);
      } catch {
        // Consumer callback errors should not derail pipeline execution
      }
    }
    return event;
  }
}

/**
 * Execute the bounded Replay end-to-end bug reproduction and fixing pipeline.
 */
export async function runPipeline(
  options: PipelineOptions,
  deps: PipelineDeps = {}
): Promise<PipelineRunResult> {
  const startTime = Date.now();
  const runId = options.runId ?? randomUUID();
  const {
    targetRepoRoot,
    targetAppUrl = 'http://localhost:5173',
    maxFixAttempts = 2,
    artifactsDir = path.resolve('artifacts'),
  } = options;

  let sampleId = options.sampleId;
  const collector = new EventCollector(runId, options.onEvent);

  if (sampleId && !KNOWN_SAMPLE_IDS_SET.has(sampleId)) {
    throw new Error(`Unknown sampleId "${sampleId}". Must be one of: ${Array.from(KNOWN_SAMPLE_IDS_SET).join(', ')}`);
  }

  // Only infer sampleId if videoPath points to the canonical samples/ directory (never for uploaded videos)
  if (!sampleId && options.videoPath && !/(^|[\\/])uploads([\\/]|$)/.test(options.videoPath)) {
    const match = options.videoPath.match(/(?:^|[\\/])samples[\\/](?:videos[\\/])?([a-z0-9-]+?)(?:\.webm|[\\/]|$)/i);
    if (match && match[1] && KNOWN_SAMPLE_IDS_SET.has(match[1])) {
      sampleId = match[1];
    }
  }

  // --- STAGE 1: INGEST ---
  await collector.emit('ingest', 'ingest_started', 'orchestrator', {
    target_repo: targetRepoRoot,
    sample_id: sampleId,
    video_path: options.videoPath,
  });

  if (!fs.existsSync(targetRepoRoot)) {
    throw new Error(`Target repository root does not exist: ${targetRepoRoot}`);
  }

  await collector.emit('ingest', 'ingest_completed', 'orchestrator', {
    status: 'ok',
  });

  // --- STAGE 2: WATCH ---
  let bugReport: BugReport;
  let watcherMetrics: ModelMetrics | undefined;
  let videoAnalysis: 'live' | 'fixture_assisted' | 'none' = 'none';
  const blockedStages: string[] = [];

  await collector.emit('watch', 'watch_started', 'watcher', {
    sample_id: sampleId,
    video_path: options.videoPath,
  });

  // Load the sample fixture ONLY for known validated samples: never for uploaded videos.
  let fixtureJson: string | undefined;
  if (sampleId && KNOWN_SAMPLE_IDS_SET.has(sampleId)) {
    const candidatePaths = [
      path.resolve(`samples/${sampleId}/expected.json`),
      path.resolve(targetRepoRoot, `../../samples/${sampleId}/expected.json`),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        fixtureJson = await fs.promises.readFile(p, 'utf8');
        break;
      }
    }
  }

  const checkFfmpegFn =
    deps.videoDeps?.checkFfmpeg ??
    deps.videoDeps?.hasFfmpeg ??
    (() => VideoProcessor.checkFfmpeg());
  const extractFramesFn =
    deps.videoDeps?.extractFrames ??
    deps.videoDeps?.extractKeyframes ??
    ((vp: string, outDir: string) => VideoProcessor.extractFrames(vp, outDir));
  const createSandboxFn =
    deps.sandboxDeps?.create ??
    deps.sandboxDeps?.createSandbox ??
    ((srcDir: string) => IsolatedWorkspaceSandbox.create(srcDir));

  const videoStat = options.videoPath ? await fs.promises.stat(options.videoPath).catch(() => null) : null;
  const videoReadable = Boolean(videoStat && videoStat.isFile() && videoStat.size > 0);
  const ffmpegAvailable = videoReadable ? await checkFfmpegFn() : false;
  const hasWatcherCredential = Boolean(deps.watcherDeps?.client || resolveApiKey('watcher'));
  const liveWatcherPossible = videoReadable && ffmpegAvailable && hasWatcherCredential;

  if (liveWatcherPossible) {
    // Live vision: extract frames and send them to the Watcher model.
    const framesDir = path.join(artifactsDir, 'frames', runId);
    let extracted: import('@replay/video').FrameInfo[] = [];
    let extractionError: Error | null = null;

    try {
      extracted = await extractFramesFn(options.videoPath!, framesDir);
      if (!Array.isArray(extracted) || extracted.length === 0) {
        throw new Error('No frames extracted — the video may be undecodable, empty, or in an unsupported format.');
      }
    } catch (err: any) {
      extractionError = err instanceof Error ? err : new Error(String(err));
      await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }

    if (extractionError) {
      const msg = redactSecretText(extractionError.message);
      await collector.emit('watch', 'watch_extraction_error', 'watcher', {
        code: 'frame_extraction_failed',
        message: msg,
      });
      await collector.emit('watch', 'watch_model_error', 'watcher', {
        code: 'frame_extraction_failed',
        model: resolveModel('watcher'),
        message: msg,
      });

      if (sampleId && fixtureJson) {
        const parsedFixture = SampleFixtureSchema.parse(JSON.parse(fixtureJson));
        bugReport = fixtureToBugReport(parsedFixture);
        videoAnalysis = 'fixture_assisted';
        blockedStages.push(`Frame extraction failed: using fixture metadata (${msg})`);
        await collector.emit('watch', 'watch_fixture_fallback', 'watcher', {
          reason: `Frame extraction failed: ${msg}`,
          sample_id: sampleId,
        });
      } else {
        await collector.emit('watch', 'watch_failed', 'watcher', {
          reason: `Frame extraction failed: ${msg}`,
        });
        const fatal: any = new Error(`Cannot analyze uploaded video: ${msg}`);
        fatal.code = 'frame_extraction_failed';
        throw fatal;
      }
    } else {
      try {
        const stride = Math.ceil(extracted.length / 40) || 1;
        const selected = extracted.filter((_, i) => i % stride === 0).slice(0, 40);
        const watcherFrames = await Promise.all(
          selected.map(async (f) => ({
            timestampS: f.timestampS,
            jpegBase64: (await fs.promises.readFile(f.filePath)).toString('base64'),
          })),
        );
        const watcherRes = await analyzeBugVideo(
          {
            frames: watcherFrames,
            note: options.note,
            route: sampleId ? `/?bug=${sampleId}` : undefined,
          },
          deps.watcherDeps,
        );
        bugReport = BugReportSchema.parse(watcherRes.report);
        videoAnalysis = 'live';
        watcherMetrics = watcherRes.metrics;
        if (sampleId && fixtureJson) {
          const expected = SampleFixtureSchema.parse(JSON.parse(fixtureJson));
          const matches = Math.abs(expected.failure_timestamp_s - bugReport.first_failure_timestamp_s) <= 2;
          await collector.emit('watch', 'watch_fixture_comparison', 'watcher', {
            matches_fixture: matches,
            expected_failure_timestamp_s: expected.failure_timestamp_s,
            live_failure_timestamp_s: bugReport.first_failure_timestamp_s,
          });
        }
      } catch (err: any) {
        const safeMsg = redactSecretText(err?.message ?? String(err));
        await collector.emit('watch', 'watch_model_error', 'watcher', {
          code: err?.code ?? 'watcher_failed',
          model: err?.model ?? resolveModel('watcher'),
          message: safeMsg,
        });
        if (!sampleId || !fixtureJson) {
          await collector.emit('watch', 'watch_failed', 'watcher', {
            reason: `Live Watcher analysis failed: ${safeMsg}`,
          });
          throw err;
        }
        const parsedFixture = SampleFixtureSchema.parse(JSON.parse(fixtureJson));
        bugReport = fixtureToBugReport(parsedFixture);
        videoAnalysis = 'fixture_assisted';
        blockedStages.push(`Live Watcher failed (${err?.code ?? 'unknown'}): using fixture metadata`);
        await collector.emit('watch', 'watch_fixture_fallback', 'watcher', {
          reason: `Live Watcher failed: ${err?.code ?? 'unknown'}`,
          sample_id: sampleId,
        });
      }
    }
  } else if (options.bugReport && !options.videoPath) {
    bugReport = BugReportSchema.parse(options.bugReport);
    videoAnalysis = 'none';
  } else if (sampleId && fixtureJson) {
    const parsedFixture = SampleFixtureSchema.parse(JSON.parse(fixtureJson));
    bugReport = fixtureToBugReport(parsedFixture);
    videoAnalysis = 'fixture_assisted';
    const reason = !videoReadable
      ? 'video file missing'
      : !ffmpegAvailable
        ? 'ffmpeg not installed'
        : 'no watcher API key configured';
    blockedStages.push(`Live Watcher unavailable: ${reason}`);
    await collector.emit('watch', 'watch_fixture_fallback', 'watcher', {
      reason: `Using verified fixture clip metadata (${reason})`,
      sample_id: sampleId,
    });
  } else if (options.videoPath) {
    const reason = !videoReadable
      ? 'the video file is missing or unreadable'
      : !ffmpegAvailable
        ? 'ffmpeg is not installed on the worker'
        : 'no watcher API key configured';
    const errCode = !videoReadable ? 'video_missing' : !ffmpegAvailable ? 'ffmpeg_missing' : 'missing_key';
    await collector.emit('watch', 'watch_model_error', 'watcher', {
      code: errCode,
      model: resolveModel('watcher'),
      message: `Cannot analyze the uploaded video: ${reason}.`,
    });
    await collector.emit('watch', 'watch_failed', 'watcher', {
      code: errCode,
      reason: `Cannot analyze the uploaded video: ${reason}.`,
    });
    const fatal: any = new Error(`Cannot analyze the uploaded video: ${reason}.`);
    fatal.code = errCode;
    throw fatal;
  } else if (options.bugReport) {
    bugReport = BugReportSchema.parse(options.bugReport);
    videoAnalysis = 'none';
  } else {
    throw new Error('Pipeline requires either bugReport, sampleId, or valid videoPath input.');
  }

  await collector.emit('watch', 'watch_completed', 'watcher', {
    video_analysis: videoAnalysis,
    summary: bugReport.summary,
    expected_behavior: bugReport.expected_behavior,
    actual_behavior: bugReport.actual_behavior,
  });

  // --- STAGE 3: LOCATE ---
  await collector.emit('locate', 'locate_started', 'locator', {
    target_repo: targetRepoRoot,
  });

  const bundle = await packRepository(targetRepoRoot);
  const locatorRes = await locateSuspects({ bugReport, bundle }, deps.locatorDeps);
  const locatorOutput = locatorRes.output;

  await collector.emit('locate', 'locate_completed', 'locator', {
    suspects_count: locatorOutput.suspects.length,
    top_suspect: locatorOutput.suspects[0] ?? null,
    tokens: locatorRes.metrics.totalTokens,
    duration_ms: locatorRes.metrics.durationMs,
    model: locatorRes.model,
  });

  // --- STAGE 4: REPRODUCE ---
  await collector.emit('reproduce', 'reproduce_started', 'reproducer', {
    route: bugReport.route,
  });

  let effectiveRoute = bugReport.route ?? '/';
  if (sampleId && !effectiveRoute.includes(`bug=${sampleId}`)) {
    if (effectiveRoute.includes('?')) {
      effectiveRoute = effectiveRoute.replace('?', `?bug=${sampleId}&`);
    } else if (effectiveRoute.includes('#')) {
      effectiveRoute = effectiveRoute.replace('#', `?bug=${sampleId}#`);
    } else {
      effectiveRoute = `${effectiveRoute}?bug=${sampleId}`;
    }
  }

  const reproRes = await generateReproduction(
    {
      bugReport,
      locatorOutput,
      sampleId,
      targetAppUrl,
      route: effectiveRoute,
    },
    deps.reproducerDeps
  );

  const rawTestCode = reproRes.output.test_code;
  const reproducerTestCode = sampleId
    ? rawTestCode.replace(/page\.goto\((['"`])([^'"`]+)\1\)/g, (_match, quote, url) => {
        if (url.includes(`bug=${sampleId}`)) return `page.goto(${quote}${url}${quote})`;
        const [pathAndQuery, hash] = url.split('#');
        const separator = pathAndQuery.includes('?') ? '&' : '?';
        const newUrl = `${pathAndQuery}${separator}bug=${sampleId}${hash ? '#' + hash : ''}`;
        return `page.goto(${quote}${newUrl}${quote})`;
      })
    : rawTestCode;

  const reproducerOutput = {
    ...reproRes.output,
    test_code: reproducerTestCode,
  };

  await collector.emit('reproduce', 'reproduce_completed', 'reproducer', {
    test_name: reproducerOutput.test_name,
    assertion: reproducerOutput.assertion,
    tokens: reproRes.metrics.totalTokens,
    duration_ms: reproRes.metrics.durationMs,
    model: reproRes.model,
  });

  // --- STAGE 5: VERIFY (Reproduction Gate) ---
  await collector.emit('verify', 'verify_started', 'verifier');

  let initialExec: Awaited<ReturnType<typeof executeReproductionTest>>;
  try {
    initialExec = await executeReproductionTest(reproducerOutput.test_code, {
      demoShopRoot: targetRepoRoot,
      testTimeoutMs: 30_000,
      createSandbox: createSandboxFn,
    });
  } catch (err: any) {
    if (err instanceof SandboxUnavailableError || err?.code === 'SANDBOX_UNAVAILABLE') {
      const safeReason = `Sandbox unavailable for reproduction execution: ${redactSecretText(err.message)}`;
      blockedStages.push(safeReason);
      const blockedVerifierOutput: VerifierOutput = {
        same_defect: false,
        classification: 'INFRASTRUCTURE_FAILURE',
        reason: safeReason,
        confidence: 1,
      };
      await collector.emit('verify', 'verify_completed', 'verifier', {
        classification: blockedVerifierOutput.classification,
        same_defect: false,
        reason: safeReason,
        sandbox_blocked: true,
        tokens: 0,
        duration_ms: 0,
        model: 'sandbox-gate',
      });
      const reportData = {
        runId,
        status: 'failed' as RunState,
        videoAnalysis,
        bugReport,
        locatorOutput,
        reproducerOutput,
        verifierOutput: blockedVerifierOutput,
        reproBeforeFixFailed: false,
        reproAfterFixPassed: false,
        baselineRegressionPassed: false,
        attempts: 0,
        durationMs: Date.now() - startTime,
        blockedStages,
        errors: [safeReason],
      };
      const reporterRes = await generateReport(reportData, deps.reporterDeps);
      await persistReportArtifacts(runId, reporterRes.output, artifactsDir);
      await collector.emit('report', 'report_completed', 'reporter', {
        status: 'failed',
        summary: reporterRes.output.executive_summary,
      });
      const totalTokens = [watcherMetrics, locatorRes?.metrics, reproRes?.metrics]
        .map((m) => m?.totalTokens ?? 0)
        .reduce((a, b) => a + b, 0);
      return {
        runId,
        status: 'failed',
        totalTokens,
        estimatedCostUsd: estimateCostUsd([
          { role: 'watcher', tokens: watcherMetrics?.totalTokens ?? 0 },
          { role: 'locator', tokens: locatorRes.metrics.totalTokens },
          { role: 'reproducer', tokens: reproRes.metrics.totalTokens },
        ]),
        sampleId,
        videoAnalysis,
        bugReport,
        bundle,
        locatorOutput,
        reproducerOutput,
        verifierOutput: blockedVerifierOutput,
        reporterOutput: reporterRes.output,
        reproBeforeFixFailed: false,
        reproAfterFixPassed: false,
        baselineRegressionPassed: false,
        attempts: 0,
        durationMs: Date.now() - startTime,
        events: collector.events,
        summary: `Execution blocked: ${safeReason}`,
      };
    }
    throw err;
  }

  const verifierRes = await verifyReproduction(
    {
      bugReport,
      reproducerOutput,
      executionResult: initialExec,
    },
    deps.verifierDeps
  );
  const verifierOutput = verifierRes.output;

  if (verifierRes.modelError) {
    await collector.emit('verify', 'verify_model_error', 'verifier', {
      code: verifierRes.modelError.code,
      model: verifierRes.modelError.model,
      status: verifierRes.modelError.status ?? null,
      message: verifierRes.modelError.message,
    });
  }

  await collector.emit('verify', 'verify_completed', 'verifier', {
    classification: verifierOutput.classification,
    same_defect: verifierOutput.same_defect,
    reason: verifierOutput.reason,
    tokens: verifierRes.metrics.totalTokens,
    duration_ms: verifierRes.metrics.durationMs,
    model: verifierRes.modelError ? 'deterministic-fallback' : verifierRes.model,
  });

  // If reproduction is not genuine, stop immediately: NEVER fix an unverified bug
  if (!verifierOutput.same_defect) {
    const reportData = {
      runId,
      status: 'unreproduced' as RunState,
      videoAnalysis,
      bugReport,
      locatorOutput,
      reproducerOutput,
      verifierOutput,
      reproBeforeFixFailed: initialExec.exitCode !== 0,
      reproAfterFixPassed: false,
      baselineRegressionPassed: false,
      attempts: 0,
      durationMs: Date.now() - startTime,
      blockedStages,
      errors: [verifierOutput.reason],
    };

    const reporterRes = await generateReport(reportData, deps.reporterDeps);
    await persistReportArtifacts(runId, reporterRes.output, artifactsDir);

    if (reporterRes.modelError) {
      await collector.emit('report', 'report_model_error', 'reporter', {
        code: reporterRes.modelError.code,
        model: reporterRes.modelError.model,
        status: reporterRes.modelError.status ?? null,
        message: reporterRes.modelError.message,
      });
    }

    await collector.emit('report', 'report_completed', 'reporter', {
      status: 'unreproduced',
      summary: reporterRes.output.executive_summary,
    });

    const totalTokens = [watcherMetrics, locatorRes?.metrics, reproRes?.metrics, verifierRes?.metrics]
      .map((m) => m?.totalTokens ?? 0)
      .reduce((a, b) => a + b, 0);
    return {
      runId,
      status: 'unreproduced',
      totalTokens,
      estimatedCostUsd: estimateCostUsd([
        { role: 'watcher', tokens: watcherMetrics?.totalTokens ?? 0 },
        { role: 'locator', tokens: locatorRes.metrics.totalTokens },
        { role: 'reproducer', tokens: reproRes.metrics.totalTokens },
        { role: 'verifier', tokens: verifierRes.metrics.totalTokens },
      ]),
      sampleId,
      videoAnalysis,
      bugReport,
      bundle,
      locatorOutput,
      reproducerOutput,
      verifierOutput,
      reporterOutput: reporterRes.output,
      reproBeforeFixFailed: initialExec.exitCode !== 0,
      reproAfterFixPassed: false,
      baselineRegressionPassed: false,
      attempts: 0,
      durationMs: Date.now() - startTime,
      events: collector.events,
      summary: `Reproduction gate failed: ${verifierOutput.reason} (${verifierOutput.classification})`,
    };
  }

  // --- STAGE 6: FIX ---
  await collector.emit('fix', 'fix_started', 'fixer');

  let lastFixerOutput: FixerOutput | undefined;
  let fixerMetrics: { totalTokens: number } | undefined;
  let reproAfterFixPassed = false;
  let baselineRegressionPassed = false;
  let attempt = 0;

  while (attempt < maxFixAttempts) {
    attempt++;
    await collector.emit('fix', 'fix_attempt_started', 'fixer', { attempt });

    const fixRes = await proposeFix(
      {
        bugReport,
        locatorOutput,
        reproducerOutput,
        bundle,
        attempts: attempt,
      },
      deps.fixerDeps
    );
    lastFixerOutput = fixRes.output;
    fixerMetrics = fixRes.metrics;

    if (!lastFixerOutput.fixed) {
      await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
        attempt,
        reason: 'Fixer model indicated no patch was proposed',
      });
      continue;
    }

    let sandbox: Awaited<ReturnType<typeof IsolatedWorkspaceSandbox.create>> | undefined;
    try {
      sandbox = await createSandboxFn(targetRepoRoot);
      await applyPatchToDirectory(sandbox.workDir, lastFixerOutput);

      const buildRes = await sandbox.exec('npx', ['vite', 'build']);
      if (buildRes.exitCode !== 0) {
        await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
          attempt,
          reason: 'Vite build failed after patch',
          output_tail: outputTail(buildRes),
        });
        continue;
      }

      const sandboxPort = allocateSandboxPort();
      let sandboxTestCode = reproducerOutput.test_code.replace(
        /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g,
        `http://127.0.0.1:${sandboxPort}`
      );

      const sandboxReproDir = path.join(sandbox.workDir, 'tests', 'repro');
      await fs.promises.mkdir(sandboxReproDir, { recursive: true });
      await fs.promises.writeFile(path.join(sandboxReproDir, 'generated.spec.ts'), sandboxTestCode, 'utf8');

      // Run reproduction test post-fix in sandbox (MUST PASS)
      const postFixRepro = await sandbox.exec(
        'npx',
        ['playwright', 'test', 'tests/repro/generated.spec.ts', '--output=.playwright-results-sandbox-repro'],
        {
          PLAYWRIGHT_TEST_MATCH: '**/tests/repro/**',
          DEMO_SHOP_PORT: sandboxPort,
          SANDBOX_TEST: '1',
        }
      );

      if (postFixRepro.exitCode !== 0) {
        await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
          attempt,
          reason: 'Reproduction test still failed after patch',
          output_tail: outputTail(postFixRepro),
        });
        continue;
      }
      reproAfterFixPassed = true;

      // Run baseline regression suite in sandbox (MUST REMAIN GREEN)
      const baselinePort = allocateSandboxPort();
      const baselineRes = await sandbox.exec(
        'npx',
        ['playwright', 'test', 'tests/baseline.spec.ts', '--output=.playwright-results-sandbox-baseline'],
        {
          DEMO_SHOP_PORT: baselinePort,
          SANDBOX_TEST: '1',
          PLAYWRIGHT_TEST_MATCH: '**/tests/baseline.spec.ts',
        }
      );

      if (baselineRes.exitCode !== 0) {
        reproAfterFixPassed = false;
        await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
          attempt,
          reason: 'Baseline regression suite broke after patch',
          output_tail: outputTail(baselineRes),
        });
        continue;
      }
      baselineRegressionPassed = true;

      await collector.emit('fix', 'fix_attempt_succeeded', 'fixer', {
        attempt,
        target_file: lastFixerOutput.target_file,
      });
      break;
    } catch (err: any) {
      reproAfterFixPassed = false;
      baselineRegressionPassed = false;
      const safeError = redactSecretText(err?.message || String(err));
      await collector.emit('fix', 'fix_attempt_error', 'fixer', {
        attempt,
        code: err instanceof SandboxUnavailableError ? err.code : (err?.code ?? 'fix_error'),
        error: safeError,
      });
      if (err instanceof SandboxUnavailableError) {
        blockedStages.push(`Fix verification blocked: ${safeError}`);
        break;
      }
    } finally {
      await sandbox?.cleanup().catch(() => {});
    }
  }

  const isFixed = reproAfterFixPassed && baselineRegressionPassed;
  const finalStatus: RunState = isFixed ? 'fixed' : 'reproduced_only';

  await collector.emit('fix', 'fix_completed', 'fixer', {
    status: finalStatus,
    attempts: attempt,
    is_fixed: isFixed,
    tokens: fixerMetrics?.totalTokens ?? 0,
  });

  // --- STAGE 7: REPORT ---
  await collector.emit('report', 'report_started', 'reporter');

  const reportData = {
    runId,
    status: finalStatus,
    videoAnalysis,
    bugReport,
    locatorOutput,
    reproducerOutput,
    verifierOutput,
    fixerOutput: lastFixerOutput,
    reproBeforeFixFailed: true,
    reproAfterFixPassed,
    baselineRegressionPassed,
    attempts: attempt,
    durationMs: Date.now() - startTime,
    blockedStages,
  };

  const reporterRes = await generateReport(reportData, deps.reporterDeps);
  await persistReportArtifacts(runId, reporterRes.output, artifactsDir);

  if (reporterRes.modelError) {
    await collector.emit('report', 'report_model_error', 'reporter', {
      code: reporterRes.modelError.code,
      model: reporterRes.modelError.model,
      status: reporterRes.modelError.status ?? null,
      message: reporterRes.modelError.message,
    });
  }

  await collector.emit('report', 'report_completed', 'reporter', {
    status: finalStatus,
    title: reporterRes.output.title,
    summary: reporterRes.output.executive_summary,
  });

  const totalTokens =
    (locatorRes?.metrics?.totalTokens ?? 0) +
    (reproRes?.metrics?.totalTokens ?? 0) +
    (verifierRes?.metrics?.totalTokens ?? 0) +
    (fixerMetrics?.totalTokens ?? 0) +
    (watcherMetrics?.totalTokens ?? 0);
  return {
    runId,
    status: finalStatus,
    totalTokens,
    estimatedCostUsd: estimateCostUsd([
      { role: 'watcher', tokens: watcherMetrics?.totalTokens ?? 0 },
      { role: 'locator', tokens: locatorRes?.metrics?.totalTokens ?? 0 },
      { role: 'reproducer', tokens: reproRes?.metrics?.totalTokens ?? 0 },
      { role: 'verifier', tokens: verifierRes?.metrics?.totalTokens ?? 0 },
      { role: 'fixer', tokens: fixerMetrics?.totalTokens ?? 0 },
    ]),
    sampleId,
    videoAnalysis,
    bugReport,
    bundle,
    locatorOutput,
    reproducerOutput,
    verifierOutput,
    fixerOutput: lastFixerOutput,
    reporterOutput: reporterRes.output,
    reproBeforeFixFailed: true,
    reproAfterFixPassed,
    baselineRegressionPassed,
    attempts: attempt,
    durationMs: Date.now() - startTime,
    events: collector.events,
    summary: isFixed
      ? `Defect successfully reproduced, verified, and fixed in ${attempt} attempt(s). Reproduction test passed and baseline suite is green.`
      : `Defect reproduced and verified, but fix could not be confirmed green within ${attempt} attempt(s).`,
  };
}

/**
 * Persist report artifacts to the local artifacts directory.
 */
async function persistReportArtifacts(runId: string, output: ReporterOutput, artifactsDir: string): Promise<void> {
  try {
    const reportsDir = path.join(artifactsDir, 'reports');
    await fs.promises.mkdir(reportsDir, { recursive: true });

    const mdPath = path.join(reportsDir, `${runId}.md`);
    const jsonPath = path.join(reportsDir, `${runId}.json`);

    await fs.promises.writeFile(mdPath, output.markdown_report, 'utf8');
    await fs.promises.writeFile(jsonPath, JSON.stringify(output, null, 2), 'utf8');
  } catch {
    // Artifact persistence is best-effort in offline/local modes
  }
}

/**
 * Backward compatibility alias for earlier Phase D caller signatures.
 */
export async function runFixAndVerifyPipeline(
  bugReport: BugReport,
  options: PipelineOptions,
  deps: PipelineDeps = {}
): Promise<PipelineRunResult> {
  return runPipeline({ ...options, bugReport }, deps);
}
