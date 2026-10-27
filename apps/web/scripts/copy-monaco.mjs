/**
 * Copy the local monaco-editor `min/vs` assets into public/ so the editor
 * loads same-origin (no CDN) and satisfies the CSP. Runs before every build.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
