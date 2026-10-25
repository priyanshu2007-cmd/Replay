import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface FrameInfo {
  timestampS: number;
  filePath: string;
  filename: string;
}

export type FfmpegExec = (file: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;

export interface ExtractFramesOptions {
  /** Uniform sampling rate. Default 2 (plan: ~2 fps). */
  fps?: number;
  /** Max output width; aspect preserved. Default 1280. */
  maxWidth?: number;
  /** ffmpeg -qscale:v (2 = high quality JPEG). Default 2. */
  jpegQuality?: number;
  /** Add supplemental scene-change frames. Default true. */
  sceneChange?: boolean;
  /** Scene-change detection threshold. Default 0.3. */
  sceneThreshold?: number;
  /** Injectable process runner for deterministic offline tests. */
  exec?: FfmpegExec;
}

interface ResolvedOptions {
  fps: number;
  maxWidth: number;
  jpegQuality: number;
  sceneChange: boolean;
  sceneThreshold: number;
}

function resolveOptions(options: ExtractFramesOptions): ResolvedOptions {
  return {
    fps: options.fps ?? 2,
    maxWidth: options.maxWidth ?? 1280,
    jpegQuality: options.jpegQuality ?? 2,
    sceneChange: options.sceneChange ?? true,
    sceneThreshold: options.sceneThreshold ?? 0.3,
  };
}

/** Pure: uniform-sampling ffmpeg args. Array form for execFile — never a shell string. */
export function buildSamplingArgs(videoPath: string, outputDir: string, options: ExtractFramesOptions): string[] {
  const o = resolveOptions(options);
  return [
    '-y',
    '-i', videoPath,
    '-vf', `fps=${o.fps},scale='min(${o.maxWidth},iw)':-2`,
    '-qscale:v', String(o.jpegQuality),
    path.join(outputDir, 'f_%04d.jpg'),
  ];
}

/** Pure: scene-change pass. showinfo prints each selected frame's pts_time to stderr. */
export function buildSceneArgs(videoPath: string, outputDir: string, options: ExtractFramesOptions): string[] {
  const o = resolveOptions(options);
  return [
    '-y',
    '-i', videoPath,
    '-vf', `select='gt(scene,${o.sceneThreshold})',showinfo,scale='min(${o.maxWidth},iw)':-2`,
    '-vsync', 'vfr',
    '-qscale:v', String(o.jpegQuality),
    path.join(outputDir, 's_%04d.jpg'),
  ];
}

/** Pure: extract pts_time values from showinfo stderr, in order. */
export function parseSceneTimestamps(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (!Number.isNaN(t)) out.push(t);
  }
  return out;
}

/** Pure: map ordered sample-frame filenames to FrameInfo at 1/fps intervals. */
export function framesFromListing(fileNames: string[], outputDir: string, fps: number): FrameInfo[] {
  const interval = 1 / fps;
  return fileNames.map((filename, index) => ({
    timestampS: Number((index * interval).toFixed(2)),
    filePath: path.join(outputDir, filename),
    filename,
  }));
}

/** Pure: merge sample + scene frames chronologically, dropping scene frames within `dedupeS` of a neighbor. */
export function mergeFrameSets(sample: FrameInfo[], scene: FrameInfo[], dedupeS = 0.15): FrameInfo[] {
  const merged = [...sample];
  for (const s of scene) {
    const tooClose = merged.some(m => Math.abs(m.timestampS - s.timestampS) < dedupeS);
    if (!tooClose) merged.push(s);
  }
  return merged.sort((a, b) => a.timestampS - b.timestampS);
}

async function cleanupPartial(outputDir: string): Promise<void> {
  try {
    const files = await fs.readdir(outputDir);
    await Promise.all(
      files.filter(f => f.startsWith('f_') || f.startsWith('s_')).map(f => fs.rm(path.join(outputDir, f), { force: true }))
    );
  } catch {
    // best effort — the original error matters more
  }
}

function execError(err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const tail = String(e?.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  return new Error(`ffmpeg failed: ${e?.message ?? String(err)}${tail ? ` — stderr tail: ${tail}` : ''}`);
}

export class VideoProcessor {
  /** True when an ffmpeg binary is on PATH. */
  static async checkFfmpeg(exec?: FfmpegExec): Promise<boolean> {
    try {
      if (exec) await exec('ffmpeg', ['-version']);
      else await execFileAsync('ffmpeg', ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract timestamped frames from a video file.
   * Throws (and cleans partial output) when ffmpeg is missing, the video cannot
   * be decoded, or no frames are produced. Frame bytes stay on disk at
   * FrameInfo.filePath — storage upload belongs to the ingest stage, not here.
   */
  static async extractFrames(
    videoPath: string,
    outputDir: string,
    options: ExtractFramesOptions = {}
  ): Promise<FrameInfo[]> {
    const o = resolveOptions(options);
    const run: FfmpegExec =
      options.exec ??
      ((file, args) =>
        execFileAsync(file, args, {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        }));

    if (!(await this.checkFfmpeg(options.exec))) {
      throw new Error('ffmpeg is not installed or not available in PATH. Install ffmpeg (e.g. brew install ffmpeg) before extracting frames.');
    }

    const stat = await fs.stat(videoPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    await fs.mkdir(outputDir, { recursive: true });

    // Pass 1: uniform sampling — the core timeline.
    try {
      await run('ffmpeg', buildSamplingArgs(videoPath, outputDir, options));
    } catch (err) {
      await cleanupPartial(outputDir);
      throw execError(err);
    }

    const files = await fs.readdir(outputDir);
    const sampleFiles = files.filter(f => f.startsWith('f_') && f.endsWith('.jpg')).sort();
    if (sampleFiles.length === 0) {
      await cleanupPartial(outputDir);
      throw new Error('No frames extracted — the video may be undecodable, empty, or in an unsupported format.');
    }
    const sampleFrames = framesFromListing(sampleFiles, outputDir, o.fps);

    // Pass 2: supplemental scene-change frames. Failure here is non-fatal:
    // the sampled timeline is already complete.
    if (o.sceneChange) {
      try {
        const { stderr = '' } = await run('ffmpeg', buildSceneArgs(videoPath, outputDir, options));
        const sceneFiles = (await fs.readdir(outputDir))
          .filter(f => f.startsWith('s_') && f.endsWith('.jpg'))
          .sort();
        const sceneTimes = parseSceneTimestamps(stderr);
        const sceneFrames: FrameInfo[] = [];
        for (let i = 0; i < sceneFiles.length; i++) {
          const t = sceneTimes[i];
          if (t === undefined) break;
          sceneFrames.push({
            timestampS: Number(t.toFixed(2)),
            filePath: path.join(outputDir, sceneFiles[i] as string),
            filename: sceneFiles[i] as string,
          });
        }
        return mergeFrameSets(sampleFrames, sceneFrames);
      } catch {
        return sampleFrames;
      }
    }

    return sampleFrames;
  }
}
