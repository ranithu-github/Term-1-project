import type { Metadata, Viewport } from 'next';
import { Fraunces, DM_Sans } from 'next/font/google';
import './globals.css';
import { ViewModeProvider } from '@/components/ViewModeContext';

// Fonts for the redesign; pages opt in with font-display / font-body
const display = Fraunces({ subsets: ['latin'], variable: '--font-display', weight: ['600', '700'] });
const body = DM_Sans({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'Astrix - Smart Umbrella System',
  description: 'IoT Smart Umbrella Borrowing System - University of Moratuwa',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="bg-slate-100 text-slate-800 antialiased min-h-screen selection:bg-sky-500 selection:text-white flex justify-center">
        <ViewModeProvider>
          {/* Native Edge-to-Edge Mobile Viewport */}
          <main className="w-full max-w-md min-h-screen bg-white shadow-sm flex flex-col relative overflow-x-hidden">
            {children}
          </main>
        </ViewModeProvider>
      </body>
    </html>
  );
}
