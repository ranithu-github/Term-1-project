import type { Metadata, Viewport } from 'next';
import { Inter_Tight } from 'next/font/google';
import './globals.css';

// One family: Inter Tight, tight tracking, numerals as hero objects
const body = Inter_Tight({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'ASTRIX Umbrellas',
  description: 'Borrow a campus umbrella at the University of Moratuwa. Return it within 24 hours.',
  appleWebApp: { capable: true, title: 'ASTRIX', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#E9EEF8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={body.variable}>
      <body>
        {/* A phone-width column; on a laptop it sits centered on the page */}
        <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col sky sm:my-6 sm:min-h-[calc(100dvh-3rem)] sm:overflow-hidden sm:rounded-[36px] sm:shadow-2">
          {children}
        </div>
      </body>
    </html>
  );
}
