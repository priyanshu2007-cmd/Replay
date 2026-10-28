/**
 * Copy the local monaco-editor `min/vs` assets into public/ so the editor
 * loads same-origin (no CDN) and satisfies the CSP. Runs before every build.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(root, '..', '..');
const apiDistServer = path.resolve(root, '..', 'api', 'dist', 'server.js');

if (!existsSync(apiDistServer)) {
  console.log('[copy-monaco] @replay/api dist missing; building @replay/api... first');
  execSync('pnpm --filter "@replay/api..." build', { cwd: repoRoot, stdio: 'inherit' });
}

const sampleIds = ['cart-nan', 'double-discount', 'string-sort', 'empty-email', 'quantity-reset'];
const publicSamplesDir = path.join(root, 'public', 'samples');
await fs.mkdir(publicSamplesDir, { recursive: true });
for (const id of sampleIds) {
  const pubFile = path.join(publicSamplesDir, `${id}.webm`);
  const repoFile = path.join(repoRoot, 'samples', 'videos', `${id}.webm`);
  if (!existsSync(pubFile) && existsSync(repoFile)) {
    await fs.copyFile(repoFile, pubFile);
  }
  const stat = await fs.stat(pubFile).catch(() => null);
  if (!stat || stat.size < 10_000) {
    throw new Error(`[copy-monaco] Missing or invalid sample recording: ${pubFile}`);
  }
}
console.log(`[copy-monaco] verified ${sampleIds.length} sample recordings in public/samples`);

const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(root, 'public', 'monaco', 'vs');

try {
  await fs.rm(path.join(root, 'public', 'monaco'), { recursive: true, force: true });
} catch {
  // Ignore permissions error if directory cannot be removed
}

try {
  await fs.cp(src, dest, { recursive: true });
} catch (err) {
  const existing = await fs.readdir(dest).catch(() => []);
  if (existing.length === 0) {
    throw err;
  }
}

const count = (await fs.readdir(dest)).length;
console.log(`[copy-monaco] ${count} entries -> public/monaco/vs`);
