'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

const NAV = [
  { href: '/how', label: 'How it works' },
  { href: '/benchmark', label: 'Benchmark' },
];

export function Header() {
  const pathname = usePathname();
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.classList.contains('light'));
  }, []);

  function toggleTheme() {
    const next = !document.documentElement.classList.contains('light');
    document.documentElement.classList.toggle('light', next);
    try {
      localStorage.setItem('replay-theme', next ? 'light' : 'dark');
    } catch {
      // storage unavailable, theme applies for this page only
    }
    setLight(next);
  }

  return (
    <header className="border-b border-border-subtle">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-mono text-[15px] font-semibold tracking-tight text-primary">
            replay
          </Link>
          <nav aria-label="Main" className="flex items-center gap-4">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-[13px] transition-colors duration-150 ease-out ${
                  pathname === item.href ? 'text-primary' : 'text-secondary hover:text-primary'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'}
          className="flex h-8 w-8 items-center justify-center rounded-s text-secondary transition-colors duration-150 ease-out hover:text-primary"
        >
          {light ? <Moon size={15} aria-hidden /> : <Sun size={15} aria-hidden />}
        </button>
      </div>
    </header>
  );
}
