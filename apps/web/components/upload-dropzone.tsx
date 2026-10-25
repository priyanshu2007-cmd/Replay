'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { uploadVideo } from '@/lib/api';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_DURATION_S = 30;
const ACCEPTED = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];

/** Read the real duration from media metadata where the browser supports it. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : null);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    v.src = url;
  });
}

export function UploadDropzone({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) {
      setError(`"${f.type || 'unknown'}" is not a supported video type. Use WebM, MP4, MOV or MKV.`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`The file is ${(f.size / (1024 * 1024)).toFixed(0)} MB. The limit is 50 MB.`);
      return;
    }
    const duration = await probeDuration(f);
    if (duration !== null && duration > MAX_DURATION_S) {
      setError(`The recording is ${Math.round(duration)} seconds. Keep it to ${MAX_DURATION_S} seconds or less.`);
      return;
    }
    setFile(f);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    pick(e.dataTransfer.files.item(0) ?? undefined);
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await uploadVideo(file, note.trim() || undefined);
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message || 'Upload failed.');
      setBusy(false);
    }
  }

  return (
    <section aria-label="Upload a bug recording" className="flex flex-col gap-4 rounded-m border border-border-subtle bg-panel p-4">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Choose a video file"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-s border border-dashed px-4 py-6 text-center transition-colors duration-150 ease-out ${
          dragOver ? 'border-accent' : 'border-border-strong'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <Upload size={16} aria-hidden className="text-secondary" />
        {disabled ? (
          <p className="text-[13px] text-secondary">{disabledReason ?? 'Uploads are unavailable right now.'}</p>
        ) : file ? (
          <>
            <p className="font-mono text-[12px] text-primary">{file.name}</p>
            <p className="text-[12px] text-muted">{(file.size / (1024 * 1024)).toFixed(1)} MB. Click to replace.</p>
          </>
        ) : (
          <>
            <p className="text-[13px] text-primary">Drop a bug recording here, or click to choose a file.</p>
            <p className="text-[12px] text-muted">WebM, MP4, MOV or MKV, up to 50 MB. Short clips of 30 seconds or less work best.</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          className="sr-only"
          onChange={(e) => pick(e.target.files?.item(0) ?? undefined)}
        />
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-fail-text">
          {error}
        </p>
      )}
      <Input
        label="Note for the reporter (optional)"
        placeholder="e.g. Happens after clearing the quantity field"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
      />
      <Button variant="primary" disabled={!file || busy || disabled} onClick={submit}>
        {busy ? 'Uploading' : 'Run on this video'}
      </Button>
    </section>
  );
}
