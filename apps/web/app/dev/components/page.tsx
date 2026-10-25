import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, ModelBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/status-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RunState } from '@/lib/api';

/**
 * Component reference. Development only; in production this page says so.
 * The states below use fixed props, never live data.
 */
export default function ComponentsPage() {
  if (process.env.NODE_ENV === 'production') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-page text-primary">Component reference</h1>
        <p className="mt-2 text-[14px] text-secondary">This page is available in development builds only.</p>
      </div>
    );
  }

  const states: RunState[] = ['queued', 'running', 'reproduced_only', 'fixed', 'unreproduced', 'failed'];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-10">
      <header>
        <h1 className="text-page text-primary">Component reference</h1>
        <p className="mt-1 text-[14px] text-secondary">Every component, every state, current theme.</p>
      </header>

      <section aria-label="Buttons">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Buttons</h2>
        <div className="flex flex-wrap items-center gap-3 rounded-m border border-border-subtle bg-panel p-4">
          <Button variant="primary">Run sample</Button>
          <Button variant="secondary">Copy as GitHub issue</Button>
          <Button variant="ghost">Download test</Button>
          <Button variant="destructive">Delete run</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </section>

      <section aria-label="Status pills">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Status pills</h2>
        <div className="flex flex-wrap items-center gap-3 rounded-m border border-border-subtle bg-panel p-4">
          {states.map((s) => (
            <StatusPill key={s} state={s} />
          ))}
          <StatusPill state="fixed" large />
        </div>
      </section>

      <section aria-label="Badges">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Badges</h2>
        <div className="flex flex-wrap items-center gap-3 rounded-m border border-border-subtle bg-panel p-4">
          <Badge>src/App.tsx</Badge>
          <Badge>L84-L104</Badge>
          <ModelBadge model="nvidia/nemotron-3-ultra-550b-a55b" />
          <ModelBadge model="nvidia/nemotron-3.5-super-vl-120b-a12b" />
        </div>
      </section>

      <section aria-label="Inputs">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Inputs</h2>
        <div className="grid gap-6 rounded-m border border-border-subtle bg-panel p-4 sm:grid-cols-2">
          <Input label="Note for the reporter" placeholder="e.g. Happens after clearing the quantity field" hint="Optional, up to 1000 characters." />
          <Input label="Email" placeholder="dev@example.com" error="Please provide a valid email address." />
        </div>
      </section>

      <section aria-label="Tabs">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Tabs</h2>
        <Tabs defaultValue="test" className="rounded-m border border-border-subtle bg-panel">
          <TabsList>
            <TabsTrigger value="suspects">Suspects</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
          </TabsList>
          <TabsContent value="suspects" className="p-4 text-[13px] text-secondary">Suspects panel.</TabsContent>
          <TabsContent value="test" className="p-4 text-[13px] text-secondary">Test panel.</TabsContent>
          <TabsContent value="diff" className="p-4 text-[13px] text-secondary">Diff panel.</TabsContent>
        </Tabs>
      </section>

      <section aria-label="Skeletons">
        <h2 className="mb-3 text-[16px] font-semibold text-primary">Skeletons</h2>
        <div className="flex gap-3 rounded-m border border-border-subtle bg-panel p-4">
          <Skeleton className="aspect-video w-48" />
          <Skeleton className="h-40 w-48" />
        </div>
      </section>
    </div>
  );
}
