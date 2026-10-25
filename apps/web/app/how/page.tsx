import Link from 'next/link';
import { STAGE_MODEL } from '@/components/ui/badge';

const STAGES = [
  { stage: 'Ingest', model: null as string | null, job: 'FFmpeg pulls timestamped frames from the recording.' },
  { stage: 'Watch', model: STAGE_MODEL.watch, job: 'Reads the frames, describes the user steps, finds the first frame where the defect is visible.' },
  { stage: 'Locate', model: STAGE_MODEL.locate, job: 'Reads the packed repository and ranks the source files most likely responsible.' },
  { stage: 'Reproduce', model: STAGE_MODEL.reproduce, job: 'Writes a Playwright test that fails for the same reason the video shows.' },
  { stage: 'Verify', model: STAGE_MODEL.verify, job: 'Compares the recording failure frame with the test screenshot: same defect or not.' },
  { stage: 'Fix', model: STAGE_MODEL.fix, job: 'Patches the code, then reruns the reproduction test and the existing suite.' },
  { stage: 'Report', model: STAGE_MODEL.report, job: 'Writes the bug report from recorded evidence only.' },
];

export default function HowPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-page text-primary">How Replay works</h1>
      <p className="mt-3 max-w-[65ch] text-[16px] leading-relaxed text-secondary">
        A bug recording goes in one end. A failing test, a patch, and proof come out the other. Every stage either
        passes a deterministic gate or the run ends with an honest status. Nothing is claimed that a test did not
        prove.
      </p>

      <section aria-labelledby="pipeline-heading" className="mt-10">
        <h2 id="pipeline-heading" className="text-[20px] font-semibold text-primary">
          The pipeline
        </h2>
        <ol className="mt-4 flex list-none flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-0">
          {STAGES.map((s, i) => (
            <li key={s.stage} className="flex items-center">
              <div className="rounded-s border border-border-subtle bg-panel px-3 py-2">
                <p className="font-mono text-[13px] text-primary">{s.stage}</p>
                <p className="font-mono text-[11px] text-muted">{i === 0 ? 'ffmpeg' : 'gate checked'}</p>
              </div>
              {i < STAGES.length - 1 && (
                <span aria-hidden className="px-1.5 text-muted">
                  {'->'}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="models-heading" className="mt-10">
        <h2 id="models-heading" className="text-[20px] font-semibold text-primary">
          One model per job
        </h2>
        <div className="mt-4 overflow-x-auto rounded-m border border-border-subtle">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border-subtle bg-panel">
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">stage</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">model</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">job</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.filter((s) => s.model).map((s) => (
                <tr key={s.stage} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-3 py-2 font-mono text-[13px] text-primary">{s.stage}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">{s.model}</td>
                  <td className="px-3 py-2 text-[13px] text-secondary">{s.job}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[13px] text-muted">
          Models run on NVIDIA Build. A reproduction only counts when the test fails with the right assertion, and a
          fix only counts when the reproduction test and the existing suite both pass.
        </p>
      </section>

      <section aria-labelledby="stack-heading" className="mt-10">
        <h2 id="stack-heading" className="text-[20px] font-semibold text-primary">
          The stack
        </h2>
        <ul className="mt-4 flex flex-col gap-1.5 text-[14px] text-secondary">
          <li>Next.js frontend, Hono API and worker, one TypeScript monorepo.</li>
          <li>Playwright runs the tests inside a Docker sandbox, one container per run.</li>
          <li>FFmpeg extracts the frames, ripgrep searches the code, Zod validates every model output.</li>
        </ul>
        <p className="mt-6 text-[14px] text-secondary">
          <Link href="https://github.com" className="text-accent underline">
            Source repository
          </Link>
          . The demo video is recorded when the benchmark run finishes.
        </p>
      </section>
    </div>
  );
}
