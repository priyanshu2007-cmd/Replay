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

function testSummary(result: unknown, label: string): string[] {
  if (result === null || result === undefined) return [`${label}: not run yet`];
  if (typeof result !== 'object') return [`${label}: ${String(result)}`];
  const lines: string[] = [];
  const r = result as Record<string, unknown>;
  for (const key of ['reproduced', 'test_name', 'assertion', 'failure_message', 'status', 'passed', 'exit_code', 'error']) {
    if (r[key] !== undefined && r[key] !== null) {
      const value = String(r[key]).slice(0, 300);
      lines.push(`${label} ${key}: ${value}`);
    }
  }
  if (lines.length === 0) {
    const summary = Object.entries(r)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? '(object)' : String(v).slice(0, 80)}`)
      .join(', ');
    lines.push(`${label}: ${summary || 'no details recorded'}`);
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

  const terminalLines = [
    ...testSummary(outputs.beforeTestResult, 'repro'),
    ...testSummary(outputs.afterTestResult, 'after fix'),
    ...testSummary(outputs.suiteResult, 'suite'),
  ];

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
