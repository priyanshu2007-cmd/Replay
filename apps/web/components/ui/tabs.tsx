'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ children }: { children: React.ReactNode }) {
  return (
    <TabsPrimitive.List
      aria-label="Run artifacts"
      className="flex h-9 w-full items-center gap-1 overflow-x-auto border-b border-border-subtle px-2"
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="h-9 min-w-[44px] whitespace-nowrap border-b-2 border-transparent px-2 text-[13px] text-secondary transition-colors duration-150 ease-out hover:text-primary data-[state=active]:border-accent data-[state=active]:text-primary"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  value,
  className = '',
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TabsPrimitive.TabsContent value={value} className={`focus-visible:outline-none ${className}`}>
      {children}
    </TabsPrimitive.TabsContent>
  );
}
