import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSamplingArgs,
  buildSceneArgs,
  parseSceneTimestamps,
  framesFromListing,
  mergeFrameSets,
  VideoProcessor,
} from './index.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

test('sampling args are an execFile-safe array with fps/scale/quality settings', () => {
  const args = buildSamplingArgs('/tmp/bug.mp4', '/tmp/out', {});
  assert.ok(Array.isArray(args));
  assert.deepEqual(args.slice(0, 3), ['-y', '-i', '/tmp/bug.mp4']);
  assert.ok(args.some(a => String(a).includes('fps=2')));
  assert.ok(args.some(a => String(a).includes('min(1280,iw)')));
  assert.ok(args.includes('2')); // -qscale:v value
  assert.ok(args.some(a => String(a).includes('f_%04d.jpg')));
});

test('scene args select on scene threshold and use vfr', () => {
  const args = buildSceneArgs('/tmp/bug.mp4', '/tmp/out', { sceneThreshold: 0.2 });
  const vf = String(args[args.indexOf('-vf') + 1]);
  assert.ok(vf.includes('gt(scene,0.2)'));
  assert.ok(vf.includes('showinfo'));
  assert.equal(String(args[args.indexOf('-vsync') + 1]), 'vfr');
});

test('scene timestamps parse from showinfo stderr in order', () => {
  const stderr = [
    '[Parsed_showinfo] n:   0 pts: 123 pts_time:8.016',
    '[Parsed_showinfo] n:   1 pts: 145 pts_time:9.5',
    'junk line without timestamps',
    '[Parsed_showinfo] n:   2 pts: 200 pts_time:12',
  ].join('\n');
  assert.deepEqual(parseSceneTimestamps(stderr), [8.016, 9.5, 12]);
  assert.deepEqual(parseSceneTimestamps('nothing here'), []);
});

test('frame listing maps filenames to 1/fps timestamps', () => {
  const frames = framesFromListing(['f_0001.jpg', 'f_0002.jpg', 'f_0003.jpg'], '/out', 2);
  assert.deepEqual(frames.map(f => f.timestampS), [0, 0.5, 1]);
  const [first, , third] = frames;
  assert.equal(first?.filename, 'f_0001.jpg');
  assert.equal(third?.filePath, path.join('/out', 'f_0003.jpg'));
  assert.deepEqual(framesFromListing([], '/out', 2), []);
});

test('merge keeps chronological order and drops near-duplicate scene frames', () => {
  const sample = framesFromListing(['f_0001.jpg', 'f_0002.jpg', 'f_0003.jpg'], '/out', 2); // 0, 0.5, 1
  const scene = [
    { timestampS: 0.48, filePath: '/out/s_1.jpg', filename: 's_1.jpg' }, // within 0.15 of 0.5 → dropped
    { timestampS: 3.2, filePath: '/out/s_2.jpg', filename: 's_2.jpg' },  // kept
  ];
  const merged = mergeFrameSets(sample, scene);
  assert.deepEqual(merged.map(f => f.timestampS), [0, 0.5, 1, 3.2]);
  assert.ok(merged.every(f => !f.filename.startsWith('s_1')));
});

test('extractFrames reports missing ffmpeg honestly (genuine environment check)', async () => {
  const ffmpegPresent = await VideoProcessor.checkFfmpeg();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-test-'));
  try {
    if (ffmpegPresent) {
      // Environment has ffmpeg: missing-file path exercises safe failure instead.
      await assert.rejects(
        VideoProcessor.extractFrames(path.join(tmp, 'does-not-exist.mp4'), tmp),
        /not found|ffmpeg/
      );
    } else {
      await assert.rejects(
        VideoProcessor.extractFrames(path.join(tmp, 'any.mp4'), tmp),
        /ffmpeg is not installed/
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractFrames rejects missing input video when ffmpeg is available', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-missing-'));
  try {
    await assert.rejects(
      VideoProcessor.extractFrames(path.join(tmp, 'missing.webm'), tmp, {
        exec: async () => ({ stdout: 'ffmpeg version mock', stderr: '' }),
      }),
      /Video file not found/
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractFrames cleans up partial f_* and s_* files on ffmpeg failure', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-fail-'));
  try {
    const vid = path.join(tmp, 'corrupt.webm');
    const out = path.join(tmp, 'out');
    await fs.writeFile(vid, 'not-a-valid-video');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'f_0001.jpg'), 'partial');
    await fs.writeFile(path.join(out, 's_0001.jpg'), 'partial');

    await assert.rejects(
      VideoProcessor.extractFrames(vid, out, {
        exec: async (_file, args) => {
          if (args[0] === '-version') return { stdout: 'ffmpeg version mock', stderr: '' };
          const err = Object.assign(new Error('decode error'), { stderr: 'Invalid data found when processing input' });
          throw err;
        },
      }),
      /ffmpeg failed.*Invalid data found/
    );

    const remaining = await fs.readdir(out);
    assert.deepEqual(remaining, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractFrames rejects empty output and cleans up stray scene files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-empty-'));
  try {
    const vid = path.join(tmp, 'empty.webm');
    const out = path.join(tmp, 'out');
    await fs.writeFile(vid, 'header');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 's_0001.jpg'), 'stray');

    await assert.rejects(
      VideoProcessor.extractFrames(vid, out, {
        exec: async () => ({ stdout: '', stderr: '' }),
      }),
      /No frames extracted/
    );

    const remaining = await fs.readdir(out);
    assert.deepEqual(remaining, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractFrames merges uniform + scene-change frames chronologically', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-ok-'));
  try {
    const vid = path.join(tmp, 'clip.webm');
    const out = path.join(tmp, 'out');
    await fs.writeFile(vid, 'webm-bytes');

    const frames = await VideoProcessor.extractFrames(vid, out, {
      exec: async (_file, args) => {
        if (args[0] === '-version') return { stdout: 'mock', stderr: '' };
        const pattern = String(args[args.length - 1]);
        if (pattern.endsWith('f_%04d.jpg')) {
          await fs.writeFile(path.join(out, 'f_0001.jpg'), 'jpg1');
          await fs.writeFile(path.join(out, 'f_0002.jpg'), 'jpg2');
          return { stdout: '', stderr: '' };
        }
        await fs.writeFile(path.join(out, 's_0001.jpg'), 'scene1');
        return { stdout: '', stderr: '[Parsed_showinfo] n: 0 pts: 100 pts_time:1.25\n' };
      },
    });

    assert.deepEqual(frames.map(f => f.timestampS), [0, 0.5, 1.25]);
    assert.deepEqual(frames.map(f => f.filename), ['f_0001.jpg', 'f_0002.jpg', 's_0001.jpg']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
