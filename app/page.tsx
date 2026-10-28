import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionIndex } from '@/lib/session';

// A few still raindrops around the hero umbrella (decoration only)
const DROPS = [
  [8, 6, 40, 0.8], [22, 30, 26, 0.6], [35, 2, 34, 0.7], [64, 10, 44, 0.9], [80, 34, 30, 0.6],
  [92, 4, 38, 0.8], [14, 58, 22, 0.5], [86, 62, 26, 0.5], [50, 72, 18, 0.4], [72, 52, 20, 0.5],
];

// Welcome. A signed-in student goes straight to their station.
export default async function Home() {
  if (await getSessionIndex()) redirect('/dashboard');

  return (
    <div className="flex min-h-[100dvh] flex-col px-5 pb-[calc(var(--safe-bottom)+24px)] pt-[calc(var(--safe-top)+16px)]">
      <header className="flex h-11 items-center justify-between">
        <span className="text-[0.8125rem] font-bold tracking-[0.16em]">ASTRIX</span>
        <span className="pill pill-quiet">University of Moratuwa</span>
      </header>

      <div className="relative grid min-h-[240px] flex-1 place-items-center" aria-hidden="true">
        <span className="halo bottom-6 left-1/2 h-28 w-64 -translate-x-1/2 bg-blue/35" />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {DROPS.map(([x, y, h, o], k) => (
            <i
              key={k}
              className="absolute w-[1.5px] rotate-[14deg] rounded-full bg-gradient-to-b from-white/0 to-white/95"
              style={{ left: `${x}%`, top: `${y}%`, height: h, opacity: o }}
            />
          ))}
        </div>
        <img
          src="/brand/umbrella-open.webp"
          alt=""
          draggable={false}
          className="asset enter w-[min(78%,300px)] -rotate-6 drop-shadow-[0_30px_40px_rgb(40_60_140/0.35)]"
        />
      </div>

      <h1 className="enter enter-1 text-[2.5rem] font-semibold leading-[1.04] tracking-[-0.04em]">
        Caught in the rain?<br />
        <span className="text-ink-3">Borrow an umbrella.</span>
      </h1>
      <p className="enter enter-2 mt-4 text-[1.0625rem] leading-relaxed text-ink-2">
        Free for University of Moratuwa students. Scan your student ID once, then borrow and return at the cabinet with your phone.
      </p>

      <div className="enter enter-3 mt-7 flex flex-col gap-2.5">
        <Link href="/signup" className="btn btn-primary btn-lg w-full">Create account</Link>
        <Link href="/login" className="btn btn-secondary btn-lg w-full">I already have an account</Link>
      </div>
    </div>
  );
}
