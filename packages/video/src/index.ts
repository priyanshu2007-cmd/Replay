import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

export interface FrameInfo {
  timestampS: number;
  filePath: string;
  filename: string;
}

export type FfmpegExec = (file: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;

export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv'] as const;
export type SupportedVideoExtension = typeof SUPPORTED_VIDEO_EXTENSIONS[number];

export const SUPPORTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;
export type SupportedVideoMimeType = typeof SUPPORTED_VIDEO_MIME_TYPES[number];

export const MAX_VIDEO_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB default limit

export function isSupportedVideoFormat(filenameOrMime: string): boolean {
  if (!filenameOrMime) return false;
  const lower = filenameOrMime.toLowerCase().trim();
  if (SUPPORTED_VIDEO_MIME_TYPES.some((m) => lower.startsWith(m))) return true;
  const ext = path.extname(lower);
  return SUPPORTED_VIDEO_EXTENSIONS.some((e) => e === ext || e === lower);
}

export interface VideoMetadata {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  sizeBytes: number;
  formatName: string;
}

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
  /** Maximum number of frames returned to bound token consumption. Default 40. */
  maxFrames?: number;
  /** Optional target timestamps (seconds) to preserve around key moments. */
  targetTimestampsS?: number[];
  /** Maximum video file size in bytes. Default 100MB. */
  maxSizeBytes?: number;
  /** Process execution timeout in milliseconds. Default 120_000ms. */
  timeoutMs?: number;
  /** Injectable process runner for deterministic offline tests. */
  exec?: FfmpegExec;
}

interface ResolvedOptions {
  fps: number;
  maxWidth: number;
  jpegQuality: number;
  sceneChange: boolean;
  sceneThreshold: number;
  maxFrames: number;
  targetTimestampsS?: number[];
  maxSizeBytes: number;
  timeoutMs: number;
}

function resolveOptions(options: ExtractFramesOptions): ResolvedOptions {
  return {
    fps: options.fps ?? 2,
    maxWidth: options.maxWidth ?? 1280,
    jpegQuality: options.jpegQuality ?? 2,
    sceneChange: options.sceneChange ?? true,
    sceneThreshold: options.sceneThreshold ?? 0.3,
    maxFrames: options.maxFrames ?? 40,
    targetTimestampsS: options.targetTimestampsS,
    maxSizeBytes: options.maxSizeBytes ?? MAX_VIDEO_FILE_SIZE_BYTES,
    timeoutMs: options.timeoutMs ?? 120_000,
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

/** Pure: downsample frame set to maxFrames while prioritizing target timestamps and boundary frames. */
export function downsampleFrames(
  frames: FrameInfo[],
  maxFrames: number,
  targetTimestampsS: number[] = []
): FrameInfo[] {
  if (frames.length <= maxFrames) return frames;

  const targetSet = new Set<FrameInfo>();

  // Always keep first and last frame
  if (frames[0]) targetSet.add(frames[0]);
  if (frames[frames.length - 1]) targetSet.add(frames[frames.length - 1]!);

  // For each target timestamp, find closest frame
  for (const target of targetTimestampsS) {
    let closest: FrameInfo | null = null;
    let minDiff = Infinity;
    for (const f of frames) {
      const diff = Math.abs(f.timestampS - target);
      if (diff < minDiff) {
        minDiff = diff;
        closest = f;
      }
    }
    if (closest) targetSet.add(closest);
  }

  // If targets alone exceed maxFrames, take subset of targets
  if (targetSet.size >= maxFrames) {
    return Array.from(targetSet)
      .sort((a, b) => a.timestampS - b.timestampS)
      .slice(0, maxFrames);
  }

  // Uniformly fill remaining budget from unselected frames
  const remainingBudget = maxFrames - targetSet.size;
  const unselected = frames.filter(f => !targetSet.has(f));
  const step = unselected.length / remainingBudget;
  const picked: FrameInfo[] = [];

  for (let i = 0; i < remainingBudget; i++) {
    const idx = Math.min(Math.floor(i * step), unselected.length - 1);
    if (unselected[idx]) picked.push(unselected[idx]!);
  }

  return [...Array.from(targetSet), ...picked].sort((a, b) => a.timestampS - b.timestampS);
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

function sanitizeErrorMessage(msg: string): string {
  // Strip absolute user paths from diagnostic messages
  return msg.replace(/\/(?:[a-zA-Z0-9._-]+\/)+/g, '[path]/');
}

function execError(err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const raw = String(e?.stderr || e?.message || err);
  const sanitized = sanitizeErrorMessage(raw);
  const tail = sanitized.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  return new Error(`ffmpeg failed: ${tail}`);
}

function parseFpsString(rateStr?: string): number {
  if (!rateStr) return 0;
  const parts = rateStr.split('/').map(Number);
  const num = parts[0];
  const den = parts[1];
  if (num !== undefined && den !== undefined && den > 0 && !Number.isNaN(num) && !Number.isNaN(den)) {
    return Number((num / den).toFixed(2));
  }
  const n = Number(rateStr);
  return Number.isNaN(n) ? 0 : n;
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

  /** True when an ffprobe binary is on PATH. */
  static async checkFfprobe(exec?: FfmpegExec): Promise<boolean> {
    try {
      if (exec) await exec('ffprobe', ['-version']);
      else await execFileAsync('ffprobe', ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  /** Check both ffmpeg and ffprobe availability. */
  static async checkTools(exec?: FfmpegExec): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
    const [ffmpeg, ffprobe] = await Promise.all([
      this.checkFfmpeg(exec),
      this.checkFfprobe(exec),
    ]);
    return { ffmpeg, ffprobe };
  }

  /**
   * Validate that the video exists, is non-empty, within size limits, and has a supported format.
   * Throws actionable, privacy-safe errors on failure.
   */
  static async validateVideo(videoPath: string, maxSizeBytes = MAX_VIDEO_FILE_SIZE_BYTES): Promise<fs.FileHandle | void> {
    const stat = await fs.stat(videoPath).catch(() => null);
    const safeName = path.basename(videoPath);

    if (!stat || !stat.isFile()) {
      throw new Error(`Video file not found: ${safeName}`);
    }

    if (stat.size === 0) {
      throw new Error(`Video file is empty (zero bytes): ${safeName}`);
    }

    if (stat.size > maxSizeBytes) {
      const maxMb = Math.round(maxSizeBytes / (1024 * 1024));
      throw new Error(`Video file exceeds maximum size limit of ${maxMb}MB (${stat.size} bytes): ${safeName}`);
    }

    const ext = path.extname(videoPath).toLowerCase();
    if (ext && !SUPPORTED_VIDEO_EXTENSIONS.includes(ext as SupportedVideoExtension)) {
      throw new Error(
        `Unsupported video format "${ext}" for ${safeName}. Supported formats: ${SUPPORTED_VIDEO_EXTENSIONS.join(', ')}`
      );
    }
  }

  /**
   * Extract video stream metadata (duration, width, height, fps, codec, size) using ffprobe.
   */
  static async extractMetadata(
    videoPath: string,
    options: { exec?: FfmpegExec; maxSizeBytes?: number } = {}
  ): Promise<VideoMetadata> {
    await this.validateVideo(videoPath, options.maxSizeBytes);

    const run: FfmpegExec =
      options.exec ??
      ((file, args) =>
        execFileAsync(file, args, {
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
        }));

    if (!(await this.checkFfprobe(options.exec))) {
      throw new Error('ffprobe is not installed or not available in PATH. Install ffprobe (e.g. brew install ffmpeg) to inspect video metadata.');
    }

    const probeArgs = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ];

    try {
      const { stdout = '' } = await run('ffprobe', probeArgs);
      const parsed = JSON.parse(stdout);
      const streams: any[] = Array.isArray(parsed.streams) ? parsed.streams : [];
      const videoStream = streams.find(s => s.codec_type === 'video') || streams[0] || {};
      const format = parsed.format || {};

      const durationS = Number(videoStream.duration || format.duration || 0);
      const width = Number(videoStream.width || 0);
      const height = Number(videoStream.height || 0);
      const fps = parseFpsString(videoStream.avg_frame_rate || videoStream.r_frame_rate);
      const codec = String(videoStream.codec_name || 'unknown');
      const sizeBytes = Number(format.size || 0);
      const formatName = String(format.format_name || '');

      return {
        durationS: Number(durationS.toFixed(2)),
        width,
        height,
        fps,
        codec,
        sizeBytes,
        formatName,
      };
    } catch (err) {
      throw new Error(`Failed to extract video metadata: ${sanitizeErrorMessage(String((err as Error).message || err))}`);
    }
  }

  /**
   * Helper: create a distinct, isolated temporary directory for a specific run.
   */
  static async createRunTempDir(runId: string, baseDir?: string): Promise<string> {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
    const parent = baseDir ?? os.tmpdir();
    const dir = path.join(parent, `replay-run-${safeRunId}-frames`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Helper: safely remove a run's temporary directory.
   */
  static async cleanupRunTempDir(dir: string): Promise<void> {
    if (!dir) return;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Extract timestamped frames from a video file.
   * Throws (and cleans partial output) when ffmpeg is missing, the video cannot
   * be decoded, or no frames are produced. Frame bytes stay on disk at
   * FrameInfo.filePath.
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
          timeout: o.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        }));

    if (!(await this.checkFfmpeg(options.exec))) {
      throw new Error('ffmpeg is not installed or not available in PATH. Install ffmpeg (e.g. brew install ffmpeg) before extracting frames.');
    }

    await this.validateVideo(videoPath, o.maxSizeBytes);
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

    let allFrames = sampleFrames;

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
        allFrames = mergeFrameSets(sampleFrames, sceneFrames);
      } catch {
        // Fall back to sample frames if scene detection fails
        allFrames = sampleFrames;
      }
    }

    // Downsample to maxFrames to respect token budgets while prioritizing key timestamps
    return downsampleFrames(allFrames, o.maxFrames, o.targetTimestampsS);
  }
}
