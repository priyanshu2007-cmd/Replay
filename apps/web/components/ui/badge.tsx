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
  'nemotron-3.5-super-vl-120b-a12b': 'nemotron-3.5-super-vl',
  'nemotron-3.5-lightning-30b-a3b': 'nemotron-3.5-lightning',
  'nemotron-3-ultra-550b-a55b': 'nemotron-3-ultra',
  'nemotron-3-nano-omni-30b-a3b-reasoning': 'nemotron-3-nano',
};

/** Model badge: mono, shortened catalog id. Never invents a model name. */
export function ModelBadge({ model }: { model: string }) {
  const id = model.startsWith('nvidia/') ? model.slice('nvidia/'.length) : model;
  return <Badge>{MODEL_SHORT[id] ?? id}</Badge>;
}

export const STAGE_MODEL: Record<string, string> = {
  watch: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  verify: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  locate: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  reproduce: 'nvidia/nemotron-3-ultra-550b-a55b',
  fix: 'nvidia/nemotron-3-ultra-550b-a55b',
  report: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
};
