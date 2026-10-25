'use client';

import dynamic from 'next/dynamic';

// Client boundary for the mascot: lazy, never server-rendered, never
// blocking the page content.
const Mascot = dynamic(() => import('./Mascot'), { ssr: false });

export function MascotLoader() {
  return <Mascot />;
}
