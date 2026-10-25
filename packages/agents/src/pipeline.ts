import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BugReport,
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
import { IsolatedWorkspaceSandbox } from '@replay/sandbox';
import { packRepository, RepoBundle } from './packer.js';
import { fixtureToBugReport, locateSuspects, LocatorDeps, SampleFixtureSchema } from './locator.js';
import { executeReproductionTest, generateReproduction, ReproducerDeps } from './reproducer.js';
import { verifyReproduction, VerifierDeps } from './verifier.js';
import { applyPatchToDirectory, FixerDeps, proposeFix } from './fixer.js';
import { generateReport, ReporterDeps } from './reporter.js';

export interface PipelineOptions {
  targetRepoRoot: string;
  sampleId?: string;
  videoPath?: string;
  bugReport?: BugReport;
  targetAppUrl?: string;
  maxFixAttempts?: number;
  runId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  artifactsDir?: string;
}

export interface PipelineDeps {
  locatorDeps?: LocatorDeps;
  reproducerDeps?: ReproducerDeps;
  verifierDeps?: VerifierDeps;
  fixerDeps?: FixerDeps;
  reporterDeps?: ReporterDeps;
}

export interface PipelineRunResult {
  runId: string;
  status: RunState;
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

  // If sampleId not provided but videoPath contains a known sample folder
  if (!sampleId && options.videoPath) {
    const match = options.videoPath.match(/samples\/([^/]+)/);
    if (match) sampleId = match[1];
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
  let videoAnalysis: 'live' | 'fixture_assisted' | 'none' = 'none';
  const blockedStages: string[] = [];

  await collector.emit('watch', 'watch_started', 'watcher', {
    sample_id: sampleId,
    video_path: options.videoPath,
  });

  if (options.bugReport) {
    bugReport = options.bugReport;
    videoAnalysis = 'none';
  } else if (sampleId) {
    // Check if sample expected.json exists
    const candidatePaths = [
      path.resolve(`samples/${sampleId}/expected.json`),
      path.resolve(targetRepoRoot, `../../samples/${sampleId}/expected.json`),
    ];
    let fixtureJson: string | undefined;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        fixtureJson = await fs.promises.readFile(p, 'utf8');
        break;
      }
    }

    if (fixtureJson) {
      const parsedFixture = SampleFixtureSchema.parse(JSON.parse(fixtureJson));
      bugReport = fixtureToBugReport(parsedFixture);
      videoAnalysis = 'fixture_assisted';
      blockedStages.push('Live Watcher omitted: using fixture-assisted metadata clip');
      await collector.emit('watch', 'watch_fixture_fallback', 'watcher', {
        reason: 'Using verified fixture clip metadata',
        sample_id: sampleId,
      });
    } else {
      throw new Error(`Sample fixture not found for ID: ${sampleId}`);
    }
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
  });

  // --- STAGE 5: VERIFY (Reproduction Gate) ---
  await collector.emit('verify', 'verify_started', 'verifier');

  const initialExec = await executeReproductionTest(reproducerOutput.test_code, {
    demoShopRoot: targetRepoRoot,
    testTimeoutMs: 30_000,
  });

  const verifierRes = await verifyReproduction(
    {
      bugReport,
      reproducerOutput,
      executionResult: initialExec,
    },
    deps.verifierDeps
  );
  const verifierOutput = verifierRes.output;

  await collector.emit('verify', 'verify_completed', 'verifier', {
    classification: verifierOutput.classification,
    same_defect: verifierOutput.same_defect,
    reason: verifierOutput.reason,
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

    await collector.emit('report', 'report_completed', 'reporter', {
      status: 'unreproduced',
      summary: reporterRes.output.executive_summary,
    });

    return {
      runId,
      status: 'unreproduced',
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

    if (!lastFixerOutput.fixed) {
      await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
        attempt,
        reason: 'Fixer model indicated no patch was proposed',
      });
      continue;
    }

    const sandbox = await IsolatedWorkspaceSandbox.create(targetRepoRoot);

    try {
      await applyPatchToDirectory(sandbox.workDir, lastFixerOutput);

      const buildRes = await sandbox.exec('npx', ['vite', 'build']);
      if (buildRes.exitCode !== 0) {
        await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
          attempt,
          reason: 'Vite build failed after patch',
        });
        continue;
      }

      const sandboxPort = '5179';
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
        });
        continue;
      }
      reproAfterFixPassed = true;

      // Run baseline regression suite in sandbox (MUST REMAIN GREEN)
      const baselineRes = await sandbox.exec(
        'npx',
        ['playwright', 'test', 'tests/baseline.spec.ts', '--output=.playwright-results-sandbox-baseline'],
        {
          DEMO_SHOP_PORT: sandboxPort,
          SANDBOX_TEST: '1',
          PLAYWRIGHT_TEST_MATCH: '**/tests/baseline.spec.ts',
        }
      );

      if (baselineRes.exitCode !== 0) {
        reproAfterFixPassed = false;
        await collector.emit('fix', 'fix_attempt_failed', 'fixer', {
          attempt,
          reason: 'Baseline regression suite broke after patch',
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
      await collector.emit('fix', 'fix_attempt_error', 'fixer', {
        attempt,
        error: err?.message || String(err),
      });
    } finally {
      await sandbox.cleanup();
    }
  }

  const isFixed = reproAfterFixPassed && baselineRegressionPassed;
  const finalStatus: RunState = isFixed ? 'fixed' : 'reproduced_only';

  await collector.emit('fix', 'fix_completed', 'fixer', {
    status: finalStatus,
    attempts: attempt,
    is_fixed: isFixed,
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

  await collector.emit('report', 'report_completed', 'reporter', {
    status: finalStatus,
    title: reporterRes.output.title,
    summary: reporterRes.output.executive_summary,
  });

  return {
    runId,
    status: finalStatus,
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
