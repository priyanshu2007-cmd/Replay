import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { Header } from '@/components/header';
import { MascotLoader } from '@/components/mascot/MascotLoader';

export const metadata: Metadata = {
  title: 'Replay',
  description: 'Drop a bug video. Get a failing test and a verified fix.',
};

// Apply the stored theme before first paint. Dark is the default.
const themeScript = `(function(){try{var t=localStorage.getItem("replay-theme");if(t==="light"){document.documentElement.classList.add("light")}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Header />
        <main className="min-h-[calc(100vh-49px)]">{children}</main>
        <MascotLoader />
      </body>
    </html>
  );
}
