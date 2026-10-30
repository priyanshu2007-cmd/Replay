import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DockerExecFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

export class SandboxUnavailableError extends Error {
  readonly code = 'sandbox_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

function isServerlessHost(): boolean {
  return Boolean(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.FUNCTIONS_WORKER_RUNTIME
  );
}

/**
 * Host execution of untrusted (model-generated) code is only allowed outside
 * production, or with an explicit REPLAY_ALLOW_HOST_SANDBOX=1 escape hatch on
 * a non-serverless machine when REPLAY_SANDBOX_MODE !== 'docker'.
 * Deployed serverless hosts can never activate host execution.
 */
export function hostExecutionAllowed(): boolean {
  if (isServerlessHost()) return false;
  if (process.env.REPLAY_SANDBOX_MODE === 'docker') return false;
  if (process.env.REPLAY_ALLOW_HOST_SANDBOX === '0') return false;
  if (process.env.REPLAY_ALLOW_HOST_SANDBOX === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

export interface IsolatedWorkspace {
  workDir: string;
  backend?: 'docker' | 'host';
  exec(
    command: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut?: boolean }>;
  cleanup(): Promise<void>;
}

/**
 * Explicit environment allowlist for sandboxed processes. Untrusted code never
 * receives the host environment: no API keys, no database URLs, no tokens.
 */
function getBaseSandboxEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    CI: '1',
  };
}

// Exact string checks (no regex alternation): a name is forbidden if it starts with a secret-bearing
// prefix or contains a credential-like fragment anywhere.
const FORBIDDEN_ENV_PREFIXES = [
  'NEBIUS', 'NVIDIA', 'OPENAI', 'ANTHROPIC', 'SUPABASE', 'DATABASE', 'POSTGRES', 'PG_', 'AWS_',
  'VERCEL', 'GITHUB_', 'REDIS', 'PRIVATE', 'SECRET',
];
const FORBIDDEN_ENV_FRAGMENTS = [
  '_KEY', '_TOKEN', '_SECRET', '_PASSWORD', 'DATABASE_URL', 'SERVICE_ROLE', 'BEARER', 'CREDENTIAL',
];
const MAX_ENV_KEY_LENGTH = 128;

function isForbiddenEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return FORBIDDEN_ENV_PREFIXES.some((p) => k.startsWith(p)) || FORBIDDEN_ENV_FRAGMENTS.some((f) => k.includes(f));
}

const ALLOWED_EXTRA_ENV_KEY_PATTERN =
  /^(PLAYWRIGHT_[A-Z0-9_]+|DEMO_SHOP_[A-Z0-9_]+|SANDBOX_[A-Z0-9_]+|NODE_ENV|PORT|HOST|HOSTNAME|TZ|CI|NO_COLOR|FORCE_COLOR|DEBUG|HOME|TMPDIR|PATH|LANG)$/;

/**
 * Filter caller-supplied environment variables so secrets can never leak into
 * either host or Docker sandboxes.
 */
export function sanitizeSandboxEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  const sanitized: Record<string, string> = { ...getBaseSandboxEnv() };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string') continue;
    if (key.length > MAX_ENV_KEY_LENGTH || isForbiddenEnvKey(key)) continue;
    if (!ALLOWED_EXTRA_ENV_KEY_PATTERN.test(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export interface SandboxCreateOptions {
  mode?: 'auto' | 'docker' | 'host';
  image?: string;
  user?: string;
  timeoutMs?: number;
  networkMode?: 'none' | 'bridge';
  dockerExec?: DockerExecFn;
  signal?: AbortSignal;
}

const SKIPPED_SOURCE_ENTRIES = new Set([
  'node_modules',
  '.playwright-results',
  '.playwright-results-repro',
  '.playwright-results-sandbox-repro',
  '.playwright-results-sandbox-baseline',
  'test-results',
  'playwright-report',
  'dist',
  '.git',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
]);

export class IsolatedWorkspaceSandbox {
  static async create(sourceDir: string, options: SandboxCreateOptions = {}): Promise<IsolatedWorkspace> {
    const mode = options.mode ?? (process.env.REPLAY_SANDBOX_MODE as 'auto' | 'docker' | 'host' | undefined) ?? 'auto';
    const isProd = process.env.NODE_ENV === 'production';
    const dockerRequired = mode === 'docker' || isServerlessHost() || (isProd && !hostExecutionAllowed());

    let useDocker = false;
    if (mode === 'docker') {
      const available = await DockerSandbox.isDockerAvailable(options.dockerExec);
      if (!available) {
        throw new SandboxUnavailableError(
          'Docker sandbox is required (mode=docker), but the Docker daemon is unavailable. Refusing to fall back to host execution.'
        );
      }
      useDocker = true;
    } else if (mode === 'host') {
      if (!hostExecutionAllowed()) {
        throw new SandboxUnavailableError(
          'Host sandbox execution is disabled in production and on serverless hosts. Configure Docker or set REPLAY_ALLOW_HOST_SANDBOX=1 in local development.'
        );
      }
      useDocker = false;
    } else {
      // mode === 'auto': in production (or when REPLAY_SANDBOX_IMAGE is set), prefer Docker if available
      if (isProd || process.env.REPLAY_SANDBOX_IMAGE) {
        const available = await DockerSandbox.isDockerAvailable(options.dockerExec);
        if (available) {
          useDocker = true;
        } else if (dockerRequired || !hostExecutionAllowed()) {
          throw new SandboxUnavailableError(
            'Host sandbox execution is disabled in production and Docker is unavailable. Run with Docker enabled, or set REPLAY_ALLOW_HOST_SANDBOX=1 explicitly for local development.'
          );
        }
      } else if (!hostExecutionAllowed()) {
        throw new SandboxUnavailableError(
          'Host sandbox execution is disabled. Enable Docker or set REPLAY_ALLOW_HOST_SANDBOX=1 for local development.'
        );
      }
    }

    const absSourceDir = path.resolve(sourceDir);
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-workspace-'));

    try {
      const entries = await fs.promises.readdir(absSourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIPPED_SOURCE_ENTRIES.has(entry.name) || entry.name.startsWith('.env')) {
          continue;
        }
        const s = path.join(absSourceDir, entry.name);
        const d = path.join(tmp, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        } else if (entry.isDirectory()) {
          await fs.promises.cp(s, d, { recursive: true });
        } else if (entry.isFile()) {
          await fs.promises.copyFile(s, d);
        }
      }

      // Copy initial dist if present
      const srcDist = path.join(absSourceDir, 'dist');
      if (fs.existsSync(srcDist)) {
        await fs.promises.cp(srcDist, path.join(tmp, 'dist'), { recursive: true });
      }

      const srcNodeModules = path.join(absSourceDir, 'node_modules');
      if (!useDocker && fs.existsSync(srcNodeModules)) {
        await fs.promises.symlink(srcNodeModules, path.join(tmp, 'node_modules'));
      }
    } catch (err) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const timeoutMs = options.timeoutMs ?? 60_000;

    if (useDocker) {
      const image = options.image ?? process.env.REPLAY_SANDBOX_IMAGE ?? 'mcr.microsoft.com/playwright:v1.50.1-noble';
      const srcNodeModules = path.join(absSourceDir, 'node_modules');
      const bindMounts: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> = [
        { hostPath: tmp, containerPath: '/workspace', readOnly: false },
      ];
      if (fs.existsSync(srcNodeModules)) {
        bindMounts.push({ hostPath: srcNodeModules, containerPath: '/workspace/node_modules', readOnly: true });
      }

      return {
        workDir: tmp,
        backend: 'docker',
        async exec(command, args, env = {}) {
          // Never fall back to host execution if DockerSandbox.run fails or times out.
          const res = await DockerSandbox.run({
            image,
            command: [command, ...args],
            workDir: '/workspace',
            timeoutMs,
            networkMode: options.networkMode ?? 'none',
            user: options.user ?? process.env.REPLAY_SANDBOX_USER ?? 'pwuser',
            bindMounts,
            env: sanitizeSandboxEnv({
              ...env,
              HOME: '/tmp',
              TMPDIR: '/tmp',
            }),
            execFn: options.dockerExec,
            signal: options.signal,
          });
          return {
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            durationMs: res.durationMs,
            timedOut: res.timedOut,
          };
        },
        async cleanup() {
          await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
        },
      };
    }

    return {
      workDir: tmp,
      backend: 'host',
      async exec(command, args, env = {}) {
        const start = Date.now();
        const safeEnv = sanitizeSandboxEnv(env);
        try {
          const res = await execFileAsync(command, args, {
            cwd: tmp,
            env: safeEnv,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            signal: options.signal,
          });
          return {
            exitCode: 0,
            stdout: res.stdout,
            stderr: res.stderr,
            durationMs: Date.now() - start,
            timedOut: false,
          };
        } catch (err: any) {
          const timedOut = Boolean(err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT');
          return {
            exitCode: typeof err.code === 'number' ? err.code : timedOut ? 124 : 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? (err.message || ''),
            durationMs: Date.now() - start,
            timedOut,
          };
        }
      },
      async cleanup() {
        await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      },
    };
  }
}

export interface SandboxExecutionOptions {
  image: string;
  command: string[];
  workDir?: string;
  timeoutMs?: number;
  user?: string;
  bindMounts?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  env?: Record<string, string>;
  networkMode?: 'none' | 'bridge';
  execFn?: DockerExecFn;
  signal?: AbortSignal;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const FORBIDDEN_MOUNT_ROOTS = ['etc', 'root', 'proc', 'sys', 'dev', 'var/run'];
const MAX_MOUNT_PATH_LENGTH = 4096;

/** Linear-time check (no backtracking regex) for host/container paths a sandbox must never mount. */
export function isForbiddenMountPath(p: string): boolean {
  if (p.length > MAX_MOUNT_PATH_LENGTH) return true;
  const lower = p.toLowerCase();
  if (lower.includes('docker.sock')) return true;
  const segments = lower.split('/');
  const last = segments[segments.length - 1] ?? '';
  if (last === '.env' || (last.startsWith('.env.') && last.length > 5)) return true;
  if (segments.some((seg) => seg === '.ssh' || seg === '.aws' || seg === '.git')) return true;
  return FORBIDDEN_MOUNT_ROOTS.some((root) => p === `/${root}` || p.startsWith(`/${root}/`));
}

function validateBindMount(mount: { hostPath: string; containerPath: string; readOnly?: boolean }): void {
  if (!mount.hostPath || !path.isAbsolute(mount.hostPath) || mount.hostPath === '/') {
    throw new SandboxUnavailableError(`Rejected unsafe bind mount hostPath: ${mount.hostPath}`);
  }
  if (!mount.containerPath || !mount.containerPath.startsWith('/') || mount.containerPath === '/') {
    throw new SandboxUnavailableError(`Rejected unsafe bind mount containerPath: ${mount.containerPath}`);
  }
  if (mount.hostPath.includes('\0') || mount.containerPath.includes('\0') || mount.hostPath.includes(':')) {
    throw new SandboxUnavailableError(`Rejected malformed bind mount path: ${mount.hostPath}`);
  }
  if (isForbiddenMountPath(mount.hostPath) || isForbiddenMountPath(mount.containerPath)) {
    throw new SandboxUnavailableError(`Rejected forbidden bind mount target: ${mount.hostPath}`);
  }
}

export class DockerSandbox {
  static async isDockerAvailable(execFn: DockerExecFn = execFileAsync): Promise<boolean> {
    try {
      await execFn('docker', ['info'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  static async run(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const runExec: DockerExecFn = options.execFn ?? execFileAsync;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const networkMode = options.networkMode ?? 'none';
    const user = options.user ?? 'pwuser';

    if ((networkMode as string) === 'host') {
      throw new SandboxUnavailableError('Host network mode is prohibited for untrusted sandbox containers.');
    }
    if (user === 'root' || user === '0' || user.startsWith('0:')) {
      throw new SandboxUnavailableError('Root execution is prohibited inside untrusted sandbox containers.');
    }

    const containerName = `replay-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      'run',
      '--name', containerName,
      '--rm',
      '--user', user,
      '--network', networkMode,
      '--memory', '2g',
      '--cpus', '2.0',
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    ];

    if (options.bindMounts) {
      for (const mount of options.bindMounts) {
        validateBindMount(mount);
        const roFlag = mount.readOnly ? ':ro' : '';
        args.push('-v', `${mount.hostPath}:${mount.containerPath}${roFlag}`);
      }
    }

    const safeEnv = sanitizeSandboxEnv(options.env ?? {});
    for (const [k, v] of Object.entries(safeEnv)) {
      args.push('-e', `${k}=${v}`);
    }

    if (options.workDir) {
      args.push('-w', options.workDir);
    }

    args.push(options.image, ...options.command);

    let timedOut = false;
    try {
      const { stdout, stderr } = await runExec('docker', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
      });
      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    } catch (err: any) {
      if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') {
        timedOut = true;
      }
      return {
        exitCode: typeof err?.code === 'number' ? err.code : timedOut ? 124 : 1,
        stdout: err?.stdout ?? '',
        stderr: err?.stderr ?? (err?.message || ''),
        durationMs: Date.now() - startTime,
        timedOut,
      };
    } finally {
      // Guaranteed cleanup: force-remove container if still running
      try {
        await runExec('docker', ['rm', '-f', containerName], { timeout: 5_000 });
      } catch {
        // Ignore if already removed
      }
    }
  }
}
