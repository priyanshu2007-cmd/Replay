'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Check, Copy, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import type { RunDetail, Suspect } from '@/lib/api';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <div className="h-full min-h-[200px] animate-pulse rounded-s bg-raised motion-reduce:animate-none" aria-hidden />,
});

// Load monaco same-origin from public/monaco/vs (copied at build time), never
// from a CDN: the demo works offline and the CSP stays strict.
import { loader } from '@monaco-editor/react';
loader.config({ paths: { vs: '/monaco/vs' } });

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none' as const,
  automaticLayout: true,
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[160px] items-center justify-center p-4 text-[13px] text-muted">{children}</div>;
}

function formatTerminalReport(run: RunDetail): string[] {
  const { outputs, state } = run;
  const lines: string[] = [];

  lines.push('=== Verification Gates ===');

  // 1. Pre-fix reproduction gate
  const before = outputs.beforeTestResult as Record<string, unknown> | null | string;
  if (before !== null && before !== undefined) {
    if (typeof before === 'string') {
      lines.push('Pre-fix reproduction:     FAILED — expected, defect reproduced');
      lines.push(`  Message: ${before.split('\n')[0]?.slice(0, 240) || before.slice(0, 240)}`);
    } else {
      const passed = before.passed === true;
      if (!passed) {
        lines.push('Pre-fix reproduction:     FAILED — expected, defect reproduced');
        if (before.assertion) {
          lines.push(`  Assertion: ${String(before.assertion).slice(0, 240)}`);
        }
        if (before.failure_message || before.stderr) {
          const firstLine = String(before.failure_message || before.stderr).split('\n')[0] || '';
          lines.push(`  Failure: ${firstLine.slice(0, 240)}`);
        }
      } else {
        lines.push('Pre-fix reproduction:     PASSED — unexpected pass (defect not reproduced)');
      }
    }
  } else if (state === 'unreproduced') {
    lines.push('Pre-fix reproduction:     FAILED — could not reproduce defect');
  } else if (outputs.generatedTest) {
    lines.push('Pre-fix reproduction:     FAILED — expected, defect reproduced');
  } else {
    lines.push('Pre-fix reproduction:     NOT RUN');
  }

  // 2. Same-defect verification gate
  const verifier = outputs.sameSymptomVerdict;
  if (verifier !== null && verifier !== undefined) {
    if (verifier.same_defect === true) {
      const conf =
        typeof verifier.confidence === 'number'
          ? ` (${Math.round(verifier.confidence * 100)}% confidence)`
          : '';
      lines.push(`Same-defect verification: PASSED — symptom confirmed${conf}`);
      if (verifier.reason) {
        lines.push(`  Reason: ${verifier.reason.slice(0, 240)}`);
      }
    } else {
      lines.push('Same-defect verification: FAILED — does not match observed symptom');
      if (verifier.reason) {
        lines.push(`  Reason: ${verifier.reason.slice(0, 240)}`);
      }
    }
  } else {
    lines.push('Same-defect verification: NOT RUN');
  }

  // 3. Post-fix reproduction gate
  const after = outputs.afterTestResult as { passed?: boolean; [k: string]: unknown } | null;
  if (after !== null && after !== undefined) {
    if (after.passed === true) {
      lines.push('Post-fix reproduction:    PASSED — defect resolved');
    } else {
      lines.push('Post-fix reproduction:    FAILED — defect still present after patch');
    }
  } else if (state === 'fixed') {
    lines.push('Post-fix reproduction:    PASSED — defect resolved');
  } else {
    lines.push('Post-fix reproduction:    NOT RUN');
  }

  // 4. Regression suite gate
  const suite = outputs.suiteResult as {
    passed?: boolean;
    total?: number;
    passedCount?: number;
    [k: string]: unknown;
  } | null;
  if (suite !== null && suite !== undefined) {
    if (suite.passed === true) {
      lines.push('Regression suite:         PASSED — no regressions detected');
    } else {
      lines.push('Regression suite:         FAILED — regressions detected in test suite');
    }
  } else if (state === 'fixed') {
    lines.push('Regression suite:         PASSED — no regressions detected');
  } else {
    lines.push('Regression suite:         NOT RUN');
  }

  // 5. Final Result
  const finalLabelMap: Record<string, string> = {
    fixed: 'FIXED',
    reproduced_only: 'REPRODUCED, NOT FIXED',
    unreproduced: 'COULD NOT REPRODUCE',
    failed: 'FAILED',
    running: 'RUNNING',
    queued: 'QUEUED',
  };
  const finalLabel = finalLabelMap[state] || state.toUpperCase();
  lines.push(`Final result:             ${finalLabel}`);
  lines.push('');

  // Detailed Execution Output
  lines.push('=== Execution Details ===');
  if (before && typeof before === 'object' && (before.stdout || before.stderr)) {
    lines.push('--- Pre-Fix Test Output ---');
    if (before.stdout) lines.push(String(before.stdout).trim());
    if (before.stderr) lines.push(String(before.stderr).trim());
    lines.push('');
  }
  if (outputs.diff) {
    lines.push('--- Applied Patch ---');
    const diffSummary = outputs.diff
      .split('\n')
      .filter((l: string) => l.startsWith('---') || l.startsWith('+++') || l.startsWith('@@'))
      .join('\n');
    lines.push(diffSummary || 'Unified diff applied to target');
    lines.push('');
  }

  return lines;
}

export function CodeTabs({
  run,
  activeTab,
  onTabChange,
}: {
  run: RunDetail;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const { outputs } = run;
  const suspects: Suspect[] = outputs.suspects ?? [];
  const [internalTab, setInternalTab] = useState('suspects');
  const [copiedPatch, setCopiedPatch] = useState(false);

  const currentTab = activeTab ?? internalTab;
  const handleTabChange = (next: string) => {
    setInternalTab(next);
    onTabChange?.(next);
  };

  function copyText(text: string) {
    void navigator.clipboard.writeText(text).catch(() => {});
    setCopiedPatch(true);
    setTimeout(() => setCopiedPatch(false), 2000);
  }

  function downloadTest() {
    if (!outputs.generatedTest) return;
    const blob = new Blob([outputs.generatedTest], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'replay-test.spec.ts';
    a.click();
    URL.revokeObjectURL(url);
  }

  const terminalLines = formatTerminalReport(run);

  return (
    <Tabs
      value={currentTab}
      onValueChange={handleTabChange}
      className="flex h-full flex-col overflow-hidden rounded-m border border-border-subtle bg-panel"
    >
      <TabsList>
        <TabsTrigger value="suspects">Suspects</TabsTrigger>
        <TabsTrigger value="test">Test</TabsTrigger>
        <TabsTrigger value="diff">Diff</TabsTrigger>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
      </TabsList>

      <TabsContent value="suspects" className="min-h-[240px] flex-1 overflow-auto p-3">
        {suspects.length === 0 ? (
          <Empty>Suspects appear here once the Locator finishes.</Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {suspects.map((s, i) => (
              <li key={`${s.file}-${s.start_line}`} className="rounded-s border border-border-subtle bg-canvas p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] text-muted">#{i + 1}</span>
                  <span className="font-mono text-[13px] text-primary">{s.file}</span>
                  <Badge>
                    L{s.start_line}
                    {s.end_line > s.start_line ? `-${s.end_line}` : ''}
                  </Badge>
                  <Badge>{s.symbol}</Badge>
                  <span className="ml-auto font-mono text-[12px] text-secondary">
                    {Math.round(s.confidence * 100)}%
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] text-secondary">{s.symptom_link}</p>
              </li>
            ))}
          </ol>
        )}
      </TabsContent>

      <TabsContent value="test" className="min-h-[240px] flex-1">
        {outputs.generatedTest ? (
          <div className="flex h-full flex-col">
            <div className="flex justify-end p-2">
              <Button variant="ghost" onClick={downloadTest}>
                <Download size={14} aria-hidden /> Download test
              </Button>
            </div>
            <div className="min-h-[240px] flex-1">
              <MonacoEditor
                language="typescript"
                value={outputs.generatedTest}
                options={EDITOR_OPTIONS}
                theme="vs-dark"
              />
            </div>
          </div>
        ) : (
          <Empty>The generated test appears here once the Reproducer finishes.</Empty>
        )}
      </TabsContent>

      <TabsContent value="diff" className="min-h-[240px] flex-1">
        {outputs.diff ? (
          <div className="flex h-full flex-col">
            <div className="flex justify-end p-2">
              <Button variant="ghost" onClick={() => copyText(outputs.diff ?? '')}>
                {copiedPatch ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{' '}
                {copiedPatch ? 'Copied' : 'Copy patch'}
              </Button>
            </div>
            <div className="min-h-[240px] flex-1">
              <MonacoEditor language="diff" value={outputs.diff} options={EDITOR_OPTIONS} theme="vs-dark" />
            </div>
          </div>
        ) : (
          <Empty>The patch appears here once the Fixer finishes.</Empty>
        )}
      </TabsContent>

      <TabsContent value="terminal" className="min-h-[240px] flex-1">
        <pre className="h-full overflow-auto p-3 font-mono text-[12px] leading-relaxed text-secondary">
          {terminalLines.join('\n')}
        </pre>
        {outputs.diff && (
          <div className="flex justify-end p-2">
            <Button variant="ghost" onClick={() => copyText(outputs.diff ?? '')}>
              {copiedPatch ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{' '}
              {copiedPatch ? 'Copied' : 'Copy patch'}
            </Button>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
