import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionIndex } from '@/lib/session';
import { Mark } from '@/components/ui';

// Welcome. A signed-in student goes straight to their station.
export default async function Home() {
  if (await getSessionIndex()) redirect('/dashboard');

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <section className="relative overflow-hidden bg-navy px-6 pb-14 pt-[calc(var(--safe-top)+28px)] text-white">
        {/* A still rain motif: decoration only, no movement */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.16]" aria-hidden="true">
          <defs>
            <pattern id="rain" width="38" height="46" patternUnits="userSpaceOnUse" patternTransform="rotate(14)">
              <line x1="6" y1="4" x2="6" y2="20" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="25" y1="26" x2="25" y2="38" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#rain)" />
        </svg>
        <div className="relative flex items-center gap-3">
          <Mark className="h-11 w-11" />
          <span className="text-lg font-bold tracking-[0.02em]">ASTRIX</span>
        </div>
        <h1 className="enter relative mt-16 font-display text-[2.75rem] font-semibold leading-[1.05] tracking-[-0.02em]">Ready for<br />the rain?</h1>
        <p className="enter enter-1 relative mt-4 max-w-[19rem] text-[1.0625rem] leading-relaxed text-white/85">
          Borrow a campus umbrella in seconds. Return it within 24 hours.
        </p>
      </section>

      <div className="-mt-6 flex flex-1 flex-col rounded-t-[28px] bg-paper px-6 pb-[calc(var(--safe-bottom)+24px)] pt-8">
        <ol className="enter enter-2 space-y-4">
          {[
            ['Scan your student ID', 'Register once with the barcode on your university ID.'],
            ['Tap Borrow at the station', 'The app tells you which slot opens.'],
            ['Return to the same slot', 'Tap Return and push the umbrella in.'],
          ].map(([title, body], k) => (
            <li key={title} className="flex gap-4">
              <span className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky text-[0.9375rem] font-bold text-blue">{k + 1}</span>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="text-[0.9375rem] text-ink-2">{body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-auto flex flex-col gap-2 pt-10">
          <Link href="/signup" className="btn btn-primary btn-lg w-full">Get started</Link>
          <Link href="/login" className="btn btn-secondary btn-lg w-full">I already have an account</Link>
          <p className="pt-2 text-center text-[0.8125rem] text-ink-2">For University of Moratuwa students.</p>
        </div>
      </div>
    </div>
  );
}
