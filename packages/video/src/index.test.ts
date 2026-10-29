import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSamplingArgs,
  buildSceneArgs,
  parseSceneTimestamps,
  framesFromListing,
  mergeFrameSets,
  downsampleFrames,
  isSupportedVideoFormat,
  VideoProcessor,
  SUPPORTED_VIDEO_EXTENSIONS,
  type FrameInfo,
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

test('downsampleFrames preserves boundaries and targets within maxFrames', () => {
  const frames: FrameInfo[] = Array.from({ length: 50 }, (_, i) => ({
    timestampS: i * 0.5,
    filePath: `/tmp/f_${i}.jpg`,
    filename: `f_${i}.jpg`,
  }));

  const downsampled = downsampleFrames(frames, 10, [12.0]);
  assert.equal(downsampled.length, 10);
  // Boundaries preserved
  assert.equal(downsampled[0]?.timestampS, 0);
  assert.equal(downsampled[downsampled.length - 1]?.timestampS, 24.5);
  // Target 12.0 preserved
  assert.ok(downsampled.some(f => f.timestampS === 12.0));
  // In ascending chronological order
  for (let i = 1; i < downsampled.length; i++) {
    assert.ok(downsampled[i]!.timestampS > downsampled[i - 1]!.timestampS);
  }
});

test('isSupportedVideoFormat recognizes valid extensions and MIME types', () => {
  assert.ok(SUPPORTED_VIDEO_EXTENSIONS.includes('.mp4'));
  assert.ok(isSupportedVideoFormat('bug.mp4'));
  assert.ok(isSupportedVideoFormat('capture.webm'));
  assert.ok(isSupportedVideoFormat('recording.mov'));
  assert.ok(isSupportedVideoFormat('screen.mkv'));
  assert.ok(isSupportedVideoFormat('video/mp4'));
  assert.ok(isSupportedVideoFormat('video/webm; codecs="vp9"'));

  assert.ok(!isSupportedVideoFormat('image.png'));
  assert.ok(!isSupportedVideoFormat('archive.zip'));
  assert.ok(!isSupportedVideoFormat('script.js'));
  assert.ok(!isSupportedVideoFormat(''));
});

test('validateVideo rejects missing, zero-byte, oversized, and unsupported formats', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-validate-test-'));
  try {
    // Missing
    await assert.rejects(
      VideoProcessor.validateVideo(path.join(tmp, 'missing.mp4')),
      /Video file not found/
    );

    // Zero-byte
    const zeroPath = path.join(tmp, 'zero.mp4');
    await fs.writeFile(zeroPath, '');
    await assert.rejects(
      VideoProcessor.validateVideo(zeroPath),
      /Video file is empty \(zero bytes\)/
    );

    // Unsupported format
    const badExt = path.join(tmp, 'test.avi');
    await fs.writeFile(badExt, 'avi content');
    await assert.rejects(
      VideoProcessor.validateVideo(badExt),
      /Unsupported video format "\.avi"/
    );

    // Oversized
    const validMp4 = path.join(tmp, 'big.mp4');
    await fs.writeFile(validMp4, 'x'.repeat(1024));
    await assert.rejects(
      VideoProcessor.validateVideo(validMp4, 500),
      /Video file exceeds maximum size limit/
    );

    // Valid
    await VideoProcessor.validateVideo(validMp4, 2048);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractMetadata parses ffprobe JSON stream and format data correctly', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-metadata-test-'));
  try {
    const fakeVideo = path.join(tmp, 'fake.webm');
    await fs.writeFile(fakeVideo, 'webm-header');

    const mockOutput = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30/1',
          duration: '14.500',
        },
      ],
      format: {
        format_name: 'matroska,webm',
        duration: '14.500',
        size: '1234567',
      },
    });

    const meta = await VideoProcessor.extractMetadata(fakeVideo, {
      exec: async (file, args) => {
        if (args[0] === '-version') return { stdout: 'ffprobe version 9.0' };
        assert.equal(file, 'ffprobe');
        assert.ok(args.includes('-show_streams'));
        return { stdout: mockOutput };
      },
    });

    assert.equal(meta.codec, 'vp9');
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
    assert.equal(meta.fps, 30);
    assert.equal(meta.durationS, 14.5);
    assert.equal(meta.sizeBytes, 1234567);
    assert.equal(meta.formatName, 'matroska,webm');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createRunTempDir isolates run directories with sanitized names and cleans up', async () => {
  const runId = 'run:123/evil..attempt';
  const tmpDir = await VideoProcessor.createRunTempDir(runId);
  try {
    assert.ok(tmpDir.includes('replay-run-run_123_evil__attempt-frames'));
    const stat = await fs.stat(tmpDir);
    assert.ok(stat.isDirectory());
  } finally {
    await VideoProcessor.cleanupRunTempDir(tmpDir);
    const exists = await fs.stat(tmpDir).catch(() => null);
    assert.equal(exists, null);
  }
});

test('checkTools reports availability for both ffmpeg and ffprobe', async () => {
  const tools = await VideoProcessor.checkTools();
  assert.equal(typeof tools.ffmpeg, 'boolean');
  assert.equal(typeof tools.ffprobe, 'boolean');
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

test('extractFrames merges uniform + scene-change frames chronologically and caps to maxFrames', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-video-ok-'));
  try {
    const vid = path.join(tmp, 'clip.webm');
    const out = path.join(tmp, 'out');
    await fs.writeFile(vid, 'webm-bytes');

    const frames = await VideoProcessor.extractFrames(vid, out, {
      maxFrames: 2,
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

    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map(f => f.filename), ['f_0001.jpg', 's_0001.jpg']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
