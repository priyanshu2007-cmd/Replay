import type { ReactNode } from 'react';

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-s border border-border-subtle bg-panel px-1.5 py-0.5 font-mono text-[12px] text-secondary ${className}`}
    >
      {children}
    </span>
  );
}

const MODEL_SHORT: Record<string, string> = {
  'Nemotron-3.5-Super-VL': 'Super VL',
  'Nemotron-3_5-Lightning': 'Lightning',
  'Nemotron-3-Ultra-550b-a55b': 'Ultra 550B',
  'NVIDIA-Nemotron-3-Nano-30B-A3B': 'Nano 30B',
};

/** Model badge: mono, shortened catalog id. Never invents a model name. */
export function ModelBadge({ model }: { model: string }) {
  const id = model.startsWith('nvidia/') ? model.slice('nvidia/'.length) : model;
  return <Badge>{MODEL_SHORT[id] ?? id}</Badge>;
}

export const STAGE_MODEL: Record<string, string> = {
  watch: 'nvidia/Nemotron-3.5-Super-VL',
  verify: 'nvidia/Nemotron-3.5-Super-VL',
  locate: 'nvidia/Nemotron-3_5-Lightning',
  reproduce: 'nvidia/Nemotron-3-Ultra-550b-a55b',
  fix: 'nvidia/Nemotron-3-Ultra-550b-a55b',
  report: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
};
