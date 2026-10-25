export function ReplayBanner() {
  return (
    <div role="status" className="border-b border-border-subtle bg-panel">
      <p className="mx-auto max-w-6xl px-4 py-2 text-[13px] text-secondary">
        Live runs are paused. You are watching a recorded run.
      </p>
    </div>
  );
}
