'use client';

import ReactMarkdown from 'react-markdown';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RunDetail } from '@/lib/api';

/** Final report: rendered Markdown from the Reporter, plus real actions. */
export function ReportView({ run }: { run: RunDetail }) {
  if (!run.outputs.reportMarkdown) {
    return (
      <section aria-label="Report" className="rounded-m border border-border-subtle bg-panel p-4">
        <h2 className="mb-2 text-[16px] font-semibold text-primary">Report</h2>
        <p className="text-[13px] text-muted">
          {run.state === 'fixed' || run.state === 'reproduced_only' || run.state === 'failed'
            ? 'No report was recorded for this run.'
            : 'The report is written once the run finishes.'}
        </p>
      </section>
    );
  }

  function copyIssue() {
    const bug = run.outputs.bugReport;
    const title = bug?.summary ?? `Bug report for run ${run.id}`;
    const issue = [
      `## ${title}`,
      '',
      run.outputs.reportMarkdown ?? '',
      '',
      '---',
      `Run: ${run.id}`,
      `Sample: ${run.videoKey}`,
      run.metrics.totalTokens !== null ? `Tokens: ${run.metrics.totalTokens}` : null,
      run.metrics.estimatedCostUsd !== null ? `Estimated cost: $${run.metrics.estimatedCostUsd}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
    void navigator.clipboard.writeText(issue).catch(() => {});
  }

  return (
    <section aria-label="Report" className="rounded-m border border-border-subtle bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-primary">Report</h2>
        <Button variant="secondary" onClick={copyIssue}>
          <Copy size={14} aria-hidden /> Copy as GitHub issue
        </Button>
      </div>
      <div className="max-w-none text-[14px] leading-relaxed text-secondary [&_a]:text-accent [&_a]:underline [&_code]:rounded-s [&_code]:bg-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-primary [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-[14px] [&_h3]:font-medium [&_h3]:text-primary [&_li]:my-1 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-s [&_pre]:bg-canvas [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_strong]:text-primary">
        <ReactMarkdown skipHtml>{run.outputs.reportMarkdown}</ReactMarkdown>
      </div>
    </section>
  );
}
