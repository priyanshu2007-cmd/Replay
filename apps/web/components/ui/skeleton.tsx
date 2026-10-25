export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-s bg-raised motion-reduce:animate-none ${className}`}
    />
  );
}
