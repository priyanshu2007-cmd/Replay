import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SandboxUnavailableError extends Error {
  readonly code = 'sandbox_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/**
 * Host execution of untrusted (model-generated) code is only allowed outside
 * production, or with an explicit REPLAY_ALLOW_HOST_SANDBOX=1 escape hatch.
 * Production without Docker fails the fix stage with sandbox_unavailable.
 */
function hostExecutionAllowed(): boolean {
  if (process.env.REPLAY_ALLOW_HOST_SANDBOX === '1') return true;
  if (process.env.REPLAY_ALLOW_HOST_SANDBOX === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

export interface IsolatedWorkspace {
  workDir: string;
  exec(command: string, args: string[], env?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  cleanup(): Promise<void>;
}

/**
 * Explicit environment allowlist for sandboxed processes. Untrusted code never
 * receives the host environment: no API keys, no database URLs, no tokens.
 */
const SANDBOX_ENV_ALLOWLIST: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  CI: '1',
};

export class IsolatedWorkspaceSandbox {
  static async create(sourceDir: string): Promise<IsolatedWorkspace> {
    if (!hostExecutionAllowed()) {
      throw new SandboxUnavailableError(
        'Host sandbox execution is disabled in production. Run the fix stage with Docker available, or set REPLAY_ALLOW_HOST_SANDBOX=1 explicitly for local development.',
      );
    }

    const absSourceDir = path.resolve(sourceDir);
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-workspace-'));
    const entries = await fs.promises.readdir(absSourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (['node_modules', '.playwright-results', 'test-results', 'dist'].includes(entry.name)) {
        continue;
      }
      const s = path.join(absSourceDir, entry.name);
      const d = path.join(tmp, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.cp(s, d, { recursive: true });
      } else {
        await fs.promises.copyFile(s, d);
      }
    }

    // Link node_modules so dependencies are available immediately
    const srcNodeModules = path.join(absSourceDir, 'node_modules');
    if (fs.existsSync(srcNodeModules)) {
      await fs.promises.symlink(srcNodeModules, path.join(tmp, 'node_modules'));
    }

    // Copy initial dist if present
    const srcDist = path.join(absSourceDir, 'dist');
    if (fs.existsSync(srcDist)) {
      await fs.promises.cp(srcDist, path.join(tmp, 'dist'), { recursive: true });
    }

    return {
      workDir: tmp,
      async exec(command, args, env = {}) {
        const start = Date.now();
        try {
          const res = await execFileAsync(command, args, {
            cwd: tmp,
            // Allowlist only: untrusted code must never see host secrets.
            env: { ...SANDBOX_ENV_ALLOWLIST, ...env },
            timeout: 60_000,
          });
          return { exitCode: 0, stdout: res.stdout, stderr: res.stderr, durationMs: Date.now() - start };
        } catch (err: any) {
          return {
            exitCode: typeof err.code === 'number' ? err.code : 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? (err.message || ''),
            durationMs: Date.now() - start,
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
  bindMounts?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  env?: Record<string, string>;
  networkMode?: 'none' | 'host' | 'bridge';
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class DockerSandbox {
  static async isDockerAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info']);
      return true;
    } catch {
      return false;
    }
  }

  static async run(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const networkMode = options.networkMode ?? 'none';

    const containerName = `replay-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      'run',
      '--name', containerName,
      '--rm',
      '--network', networkMode,
      '--memory', '2g',
      '--cpus', '2.0',
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
    ];

    if (options.bindMounts) {
      for (const mount of options.bindMounts) {
        const roFlag = mount.readOnly ? ':ro' : '';
        args.push('-v', `${mount.hostPath}:${mount.containerPath}${roFlag}`);
      }
    }

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    if (options.workDir) {
      args.push('-w', options.workDir);
    }

    args.push(options.image, ...options.command);

    let timedOut = false;
    try {
      const child = execFileAsync('docker', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      const { stdout, stderr } = await child;
      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    } catch (err: any) {
      if (err.killed && err.signal === 'SIGTERM') {
        timedOut = true;
      }
      return {
        exitCode: err.code ?? (timedOut ? 124 : 1),
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? (err.message || ''),
        durationMs: Date.now() - startTime,
        timedOut,
      };
    } finally {
      // Guaranteed cleanup: kill container if still running
      try {
        await execFileAsync('docker', ['rm', '-f', containerName]);
      } catch {
        // Ignore if already removed
      }
    }
  }
}
