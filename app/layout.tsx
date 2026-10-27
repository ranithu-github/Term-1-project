import type { Metadata, Viewport } from 'next';
import { Fraunces, DM_Sans } from 'next/font/google';
import './globals.css';

// Fraunces only for the welcome headline; DM Sans for everything a student reads or taps
const display = Fraunces({ subsets: ['latin'], variable: '--font-display', weight: ['600'] });
const body = DM_Sans({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'ASTRIX Umbrellas',
  description: 'Borrow a campus umbrella at the University of Moratuwa. Return it within 24 hours.',
  appleWebApp: { capable: true, title: 'ASTRIX', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#F5F8FC',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        {/* A phone-width column; on a laptop it sits centered on the page */}
        <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col bg-paper sm:my-6 sm:min-h-[calc(100dvh-3rem)] sm:overflow-hidden sm:rounded-[36px] sm:shadow-2">
          {children}
        </div>
      </body>
    </html>
  );
}
