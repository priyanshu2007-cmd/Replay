export function ReplayBanner({ message }: { message?: string } = {}) {
  return (
    <aside role="status" aria-label="Demo replay mode notice" className="mb-4 rounded-s border border-border-subtle bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-progress animate-pulse" />
        <p className="text-[13px] text-secondary">
          {message ?? 'Recorded Demo Replay: Pre-verified Demo Shop reference execution in an isolated Playwright sandbox.'}
        </p>
      </div>
    </aside>
  );
}
