'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, CheckCircle2, Flashlight, ImageUp, RotateCcw } from 'lucide-react';
import { Notice, Spinner, StepBar, StepHeading, TopBar } from '@/components/ui';
import { useBarcodeScanner, type ScannerError } from '@/lib/barcode/useBarcodeScanner';
import { clearSignup, writeSignup } from '@/lib/signupState';

// The UoM student ID barcode contains only the index number: 6 digits + a letter
const INDEX_PATTERN = /^[0-9]{6}[A-Z]$/;

// A live result is accepted only after the same index is read this many times in a
// row (one read per camera frame), so a misread can't create the wrong account
const CONFIRM_READS = 2;

// Developer shortcuts and the raw-scan readout only exist in local development builds
const IS_DEV_BUILD = process.env.NODE_ENV !== 'production';

// Strip Code 39 start/stop '*' and stray spaces/dashes, then require exactly an index number
const parseIndex = (rawText: string): string | null => {
  if (!rawText) return null;
  const cleaned = rawText.replace(/[\*\s\-\/]+/g, '').toUpperCase();
  return INDEX_PATTERN.test(cleaned) ? cleaned : null;
};

const CAMERA_ERRORS: Record<ScannerError, { title: string; body: string }> = {
  denied: { title: 'Camera access is off', body: 'Allow camera access for this site in your browser settings, or upload a photo of the barcode instead.' },
  'no-camera': { title: 'No camera found', body: 'Upload a photo of the barcode on your student ID instead.' },
  unsupported: { title: 'This browser can’t open the camera here', body: 'Upload a photo of the barcode on your student ID instead.' },
  failed: { title: 'The camera didn’t start', body: 'Try again, or upload a photo of the barcode instead.' },
};

type Read = { index: string; exists: boolean } | null;

// Signup step 1: read the index number from the barcode on the student ID
export default function ScanPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const lastRead = useRef<{ index: string; count: number }>({ index: '', count: 0 });
  const badReads = useRef(0);

  const [read, setRead] = useState<Read>(null);
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [rawScan, setRawScan] = useState<string | null>(null); // dev builds only

  const onDecode = (text: string) => {
    if (busyRef.current) return;
    if (IS_DEV_BUILD) setRawScan(text);
    const index = parseIndex(text);
    if (!index) {
      lastRead.current = { index: '', count: 0 };
      if (++badReads.current >= 3) setHint('That barcode isn’t a student ID. Scan the barcode on your university ID card.');
      return;
    }
    lastRead.current = lastRead.current.index === index ? { index, count: lastRead.current.count + 1 } : { index, count: 1 };
    if (lastRead.current.count >= CONFIRM_READS) void accept(index);
  };

  const scanner = useBarcodeScanner(onDecode);

  const start = () => {
    busyRef.current = false;
    lastRead.current = { index: '', count: 0 };
    badReads.current = 0;
    setRead(null);
    setHint(null);
    void scanner.start();
  };

  // A barcode was read: stop the camera, show it, and check whether it already has an account
  const accept = async (index: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    scanner.stop();
    try {
      navigator.vibrate?.(30);
    } catch {}
    setChecking(true);
    setRead({ index, exists: false });
    try {
      const res = await fetch('/api/auth/check-index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index_no: index }) });
      const json = await res.json().catch(() => ({}));
      setRead({ index, exists: Boolean(json.exists) });
    } catch {
      setRead({ index, exists: false }); // signup checks again on the next step
    } finally {
      setChecking(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setHint(null);
    setChecking(true);
    try {
      const text = await scanner.decodeFile(file);
      const index = text ? parseIndex(text) : null;
      if (index) {
        setChecking(false);
        await accept(index);
        return;
      }
      setHint('We couldn’t read the barcode in that photo. Take it straight on and close up, with the whole barcode in the picture.');
    } catch {
      setHint('We couldn’t open that photo. Try another one.');
    }
    setChecking(false);
  };

  const proceed = () => {
    if (!read) return;
    clearSignup();
    writeSignup({ index_no: read.index });
    router.push('/signup/details');
  };

  // Start the camera on arrival; release it in the background, resume when back
  useEffect(() => {
    start();
    const onVisibility = () => {
      if (document.hidden) {
        pausedRef.current = true;
        scanner.stop();
      } else if (pausedRef.current && !busyRef.current) {
        pausedRef.current = false;
        void scanner.start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cameraError = scanner.error ? CAMERA_ERRORS[scanner.error] : null;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar title="Create account" back={{ href: '/login', label: 'Back to sign in' }} />
      <main className="flex flex-1 flex-col gap-5 px-6 pb-[calc(var(--safe-bottom)+24px)] pt-5">
        <StepBar step={1} of={4} />
        <StepHeading step={1} of={4} title="Scan your student ID">
          Place the barcode on your student ID inside the frame. It&apos;s read on your phone; nothing is uploaded.
        </StepHeading>

        {/* Camera */}
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-navy shadow-1">
          <video ref={scanner.videoRef} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${read ? 'opacity-30' : ''}`} playsInline muted aria-label="Camera view for scanning your student ID" />

          {!read && scanner.isScanning && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-5">
              {/* Wide frame for a linear barcode */}
              <div className="relative h-[34%] w-[88%] rounded-[14px] shadow-[0_0_0_9999px_rgb(10_25_50/0.45)]">
                <span className="absolute -left-0.5 -top-0.5 h-6 w-6 rounded-tl-[14px] border-l-[3px] border-t-[3px] border-white" />
                <span className="absolute -right-0.5 -top-0.5 h-6 w-6 rounded-tr-[14px] border-r-[3px] border-t-[3px] border-white" />
                <span className="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-[14px] border-b-[3px] border-l-[3px] border-white" />
                <span className="absolute -bottom-0.5 -right-0.5 h-6 w-6 rounded-br-[14px] border-b-[3px] border-r-[3px] border-white" />
              </div>
              <p className="glass-dark rounded-full px-3.5 py-1.5 text-[0.875rem] font-medium text-white">Hold steady, about a hand&apos;s length away</p>
            </div>
          )}

          {!read && !scanner.isScanning && !cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/90">
              <Spinner className="h-7 w-7" />
              <p className="text-[0.9375rem]">Starting the camera…</p>
            </div>
          )}

          {cameraError && !read && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white">
              <Camera className="h-8 w-8 opacity-80" strokeWidth={1.75} aria-hidden="true" />
              <p className="font-semibold">{cameraError.title}</p>
              <p className="text-[0.9375rem] text-white/80">{cameraError.body}</p>
            </div>
          )}

          {read && (
            <div className="enter absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white" role="status">
              {checking ? <Spinner className="h-8 w-8" /> : <CheckCircle2 className="h-10 w-10 text-[#7FE0A8]" strokeWidth={2} aria-hidden="true" />}
              <p className="text-[0.9375rem] font-medium text-white/85">Barcode read</p>
              <p className="num text-[2rem] font-bold tracking-[0.04em]">{read.index}</p>
            </div>
          )}

          {scanner.hasTorch && scanner.isScanning && !read && (
            <button type="button" onClick={scanner.toggleTorch} aria-pressed={scanner.torchOn} aria-label={scanner.torchOn ? 'Turn off the torch' : 'Turn on the torch'}
              className={`absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full ${scanner.torchOn ? 'bg-white text-navy' : 'glass-dark text-white'}`}>
              <Flashlight className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>

        {IS_DEV_BUILD && rawScan && <p className="num text-xs text-ink-3">Last raw scan: {rawScan}</p>}
        {hint && !read && <Notice tone="caution" title={hint} />}
        {read?.exists && (
          <Notice tone="info" title={`There’s already an account for ${read.index}`} action={<Link href={`/login?index_no=${encodeURIComponent(read.index)}`} className="btn btn-primary">Sign in instead</Link>}>
            Forgot the password? You can reset it from the sign-in screen.
          </Notice>
        )}

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

        <div className="mt-auto flex flex-col gap-2">
          {read && !read.exists && !checking ? (
            <>
              <button type="button" className="btn btn-primary btn-lg w-full" onClick={proceed}>Continue</button>
              <button type="button" className="btn btn-plain w-full" onClick={start}><RotateCcw className="h-[18px] w-[18px]" aria-hidden="true" /> Scan again</button>
            </>
          ) : read ? (
            <button type="button" className="btn btn-secondary btn-lg w-full" onClick={start} disabled={checking}><RotateCcw className="h-5 w-5" aria-hidden="true" /> Scan a different ID</button>
          ) : (
            <>
              {cameraError && <button type="button" className="btn btn-primary btn-lg w-full" onClick={start}><Camera className="h-5 w-5" aria-hidden="true" /> Try the camera again</button>}
              <button type="button" className={`btn ${cameraError ? 'btn-secondary btn-lg' : 'btn-plain'} w-full`} onClick={() => fileRef.current?.click()} disabled={checking}>
                {checking ? <Spinner className="h-5 w-5" /> : <ImageUp className="h-5 w-5" strokeWidth={2} aria-hidden="true" />} Upload a photo of the barcode
              </button>
            </>
          )}
          {IS_DEV_BUILD && !read && (
            <button type="button" className="btn btn-plain w-full text-xs text-ink-3" onClick={() => void accept('250373T')}>Scan 250373T</button>
          )}
          <p className="pt-2 text-center text-[0.9375rem] text-ink-2">
            Already registered? <Link href="/login" className="font-semibold text-blue">Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
