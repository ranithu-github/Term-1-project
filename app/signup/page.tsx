'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Barcode,
  AlertTriangle,
  RefreshCw,
  Flashlight,
  Upload,
  ArrowRight,
  UserCheck,
} from 'lucide-react';
import { AuthHeader } from '@/components/AuthMarks';

// The UoM student ID barcode contains only the index number: 6 digits + a letter
const INDEX_PATTERN = /^[0-9]{6}[A-Z]$/;

// A live result is accepted only after the same index is read this many times in a
// row, so a one-character misread of a 1D barcode can't create the wrong account
const CONFIRM_READS = 2;

// Developer shortcuts and the raw-scan readout only exist in local development builds
const IS_DEV_BUILD = process.env.NODE_ENV !== 'production';

// Strip Code 39 start/stop '*' and stray spaces/dashes, then require exactly an index number
const parseIndex = (rawText: string): string | null => {
  if (!rawText) return null;
  const cleaned = rawText.replace(/[\*\s\-\/]+/g, '').toUpperCase();
  return INDEX_PATTERN.test(cleaned) ? cleaned : null;
};

export default function BarcodeScanPage() {
  const router = useRouter();
  const scannerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Guards that must not wait for a re-render (the decode callback runs many times a second)
  const busyRef = useRef(false);                                // an index is being checked
  const startingRef = useRef(false);                            // the camera is starting
  const unmountedRef = useRef(false);
  const pausedForBackgroundRef = useRef(false);
  const lastReadRef = useRef<{ index: string; count: number }>({ index: '', count: 0 });

  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [existingUserError, setExistingUserError] = useState<{
    index_no: string;
    message: string;
  } | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [lastRawScan, setLastRawScan] = useState<string | null>(null); // dev builds only

  // Stop the camera if it is running (safe to call at any time)
  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
    } catch (e) {
      console.warn('Scanner stop warning:', e);
    }
    setIsScanning(false);
    setIsTorchOn(false);
  }, []);

  // An index number was read from the ID: check it and continue to step 2
  const acceptIndex = async (index_no: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setValidationError(null);
    setExistingUserError(null);

    await stopScanner();

    // Haptic feedback
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(150);
    }

    setIsChecking(true);

    try {
      // Check if an account already exists for this index
      const res = await fetch('/api/auth/check-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no }),
      });

      const json = await res.json();

      if (json.exists) {
        setExistingUserError({
          index_no,
          message:
            json.message ||
            `An account already exists for Index Number ${index_no}. Please sign in to your account.`,
        });
        setIsChecking(false);
        busyRef.current = false;
        return;
      }

      // Valid and new: save the index for step 2 (the server checks again at signup)
      sessionStorage.setItem('astrix_verified_index', index_no);
      router.push('/signup/details');
    } catch (err: any) {
      console.error('Verification check error:', err);
      // The signup API refuses existing accounts anyway, so continue
      sessionStorage.setItem('astrix_verified_index', index_no);
      router.push('/signup/details');
    } finally {
      setIsChecking(false);
    }
  };

  // Called for every frame the camera decodes a barcode
  const handleLiveDecode = (decodedText: string, decodedResult?: any) => {
    if (busyRef.current) return;

    if (IS_DEV_BUILD) {
      const format = decodedResult?.result?.format?.formatName;
      setLastRawScan(`${decodedText}${format ? ` (${format})` : ''}`);
    }

    const index_no = parseIndex(decodedText);
    if (!index_no) {
      lastReadRef.current = { index: '', count: 0 };
      setValidationError(
        'Incorrect barcode. Please scan the front side of your University ID card.'
      );
      return;
    }

    // Accept only after the same index is read CONFIRM_READS times in a row
    if (lastReadRef.current.index === index_no) {
      lastReadRef.current.count += 1;
    } else {
      lastReadRef.current = { index: index_no, count: 1 };
    }

    if (lastReadRef.current.count >= CONFIRM_READS) {
      acceptIndex(index_no);
    }
  };

  // Start the live camera scanner
  const startScanner = useCallback(async () => {
    if (startingRef.current || busyRef.current || unmountedRef.current) return;
    startingRef.current = true;
    setCameraError(null);
    setValidationError(null);
    setExistingUserError(null);
    lastReadRef.current = { index: '', count: 0 };

    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
      if (unmountedRef.current) return;

      const element = document.getElementById('astrix-barcode-reader');
      if (!element) {
        startingRef.current = false;
        return;
      }

      // Stop any previous instance before creating a new one
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) await scannerRef.current.stop();
          scannerRef.current.clear();
        } catch {}
      }

      // Read Code 39 (UoM ID standard) and 128; fall back to all formats on error
      let formatsToSupport: any[] = [
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.CODE_128,
      ];

      let scanner: any;
      try {
        scanner = new Html5Qrcode('astrix-barcode-reader', {
          formatsToSupport,
          verbose: false,
        });
      } catch {
        scanner = new Html5Qrcode('astrix-barcode-reader', { verbose: false });
      }

      scannerRef.current = scanner;

      // Scan the full camera picture (scanning the whole frame is faster and more forgiving)
      const config = {
        fps: 20,
        videoConstraints: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };

      await scanner.start({ facingMode: 'environment' }, config, handleLiveDecode, () => {});

      if (unmountedRef.current) {
        try {
          await scanner.stop();
        } catch {}
        return;
      }

      setIsScanning(true);

      // Check if torch/flashlight is supported
      try {
        const capabilities = scanner.getRunningTrackCapabilities();
        setHasTorch(Boolean(capabilities?.torch));
      } catch {
        setHasTorch(false);
      }
    } catch (err: any) {
      console.warn('Camera start error:', err);
      const msg = String(err?.message || err);
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setCameraError(
          'Camera permission denied. Please allow camera access in your browser settings to scan your ID.'
        );
      } else if (msg.includes('NotFoundError') || msg.includes('DevicesNotFoundError')) {
        setCameraError('No camera detected on this device. You can upload a photo of your ID barcode below.');
      } else {
        setCameraError('Could not start camera. Please refresh or upload a photo of your ID barcode below.');
      }
    } finally {
      startingRef.current = false;
    }
  }, [stopScanner]);

  // Flashlight toggle
  const toggleTorch = async () => {
    const scanner = scannerRef.current;
    if (!scanner || !hasTorch) return;
    try {
      const nextState = !isTorchOn;
      await scanner.applyVideoConstraints({ advanced: [{ torch: nextState }] });
      setIsTorchOn(nextState);
    } catch (e) {
      console.warn('Torch toggle warning:', e);
    }
  };

  // Photo upload fallback
  const handleFileScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsChecking(true);
      setValidationError(null);
      setExistingUserError(null);

      const { Html5Qrcode } = await import('html5-qrcode');
      const fileScanner = new Html5Qrcode('astrix-file-scanner');
      const decodedText = await fileScanner.scanFile(file, false);
      fileScanner.clear();

      const index_no = parseIndex(decodedText);
      if (!index_no) {
        setValidationError(
          'Incorrect barcode. Please scan the front side of your University ID card.'
        );
        return;
      }
      setIsChecking(false);
      await acceptIndex(index_no);
    } catch (err) {
      setValidationError(
        'Incorrect barcode. Please scan the front side of your University ID card.'
      );
    } finally {
      setIsChecking(false);
      e.target.value = '';
    }
  };

  // Mount/unmount: start the camera once, release it cleanly when leaving
  useEffect(() => {
    unmountedRef.current = false;
    startScanner();

    // Release camera when tab is switched or phone goes to sleep; restart when returning
    const handleVisibility = () => {
      if (document.hidden) {
        if (scannerRef.current?.isScanning) {
          pausedForBackgroundRef.current = true;
          stopScanner();
        }
      } else if (pausedForBackgroundRef.current && !busyRef.current) {
        pausedForBackgroundRef.current = false;
        startScanner();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unmountedRef.current = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      const scanner = scannerRef.current;
      if (scanner) {
        try {
          if (scanner.isScanning) scanner.stop().catch(() => {});
          scanner.clear();
        } catch {}
      }
    };
  }, [startScanner, stopScanner]);


  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none">
      <AuthHeader step={1} lines={['Scan your', 'student ID.']} />

      {/* White sheet */}
      <div className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-9 pb-8 space-y-4">
        {/* Error: Non-UoM Barcode Error */}
        {validationError && (
          <p className="px-4 py-3 rounded-xl bg-amber-50 text-amber-900 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>Wrong barcode. Use the front of your ID.</span>
          </p>
        )}

        {/* Error: User Already Exists in Database */}
        {existingUserError && (
          <div className="p-4 rounded-xl bg-rose-50 text-rose-900 text-sm space-y-3">
            <p className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-rose-600 shrink-0" />
              <span>This ID already has an account.</span>
            </p>
            <div className="flex items-center gap-2">
              <Link
                href={`/login?index_no=${encodeURIComponent(existingUserError.index_no)}`}
                className="flex-1 py-2.5 px-3 bg-brand-600 hover:bg-brand-700 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-1.5 transition"
              >
                <span>Sign in</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <button
                type="button"
                onClick={startScanner}
                className="py-2.5 px-3 text-brand-900 hover:bg-white rounded-xl font-semibold text-sm transition"
              >
                Scan again
              </button>
            </div>
          </div>
        )}

        {/* Camera Permission Error */}
        {cameraError && (
          <div className="px-4 py-3 rounded-xl bg-rose-50 text-rose-900 text-sm flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>Camera unavailable.</span>
            </span>
            <button
              type="button"
              onClick={startScanner}
              title={cameraError}
              className="font-semibold text-rose-700 hover:text-rose-800 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Camera Viewport Container */}
        <div className="relative w-full aspect-[4/3] rounded-2xl bg-brand-900 overflow-hidden flex items-center justify-center">
          <style jsx global>{`
            #astrix-barcode-reader {
              width: 100% !important;
              height: 100% !important;
              position: absolute !important;
              inset: 0 !important;
              display: flex !important;
              align-items: center !important;
              justify-content: center !important;
              overflow: hidden !important;
            }
            #astrix-barcode-reader video {
              width: 100% !important;
              height: 100% !important;
              object-fit: cover !important;
              border-radius: 1rem !important;
            }
            #astrix-barcode-reader__scan_region {
              width: 100% !important;
              height: 100% !important;
            }
            #astrix-barcode-reader__dashboard_section {
              display: none !important;
            }
            #astrix-barcode-reader img {
              display: none !important;
            }
          `}</style>

          {/* html5-qrcode video mount element */}
          <div id="astrix-barcode-reader" className="w-full h-full object-cover" />
          <div id="astrix-file-scanner" className="hidden" />

          {/* Idle state before the camera starts */}
          {!isScanning && !isChecking && (
            <Barcode className="relative w-10 h-10 text-white/25" aria-hidden="true" />
          )}

          {/* Aiming guide */}
          {isScanning && !existingUserError && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-4">
              <div className="w-[84%] max-w-[320px] aspect-[16/10] relative">
                <div className="absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-white rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-white rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-white rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-white rounded-br-lg" />
                <div className="absolute inset-x-6 top-1/2 h-px bg-white/70" />
              </div>
            </div>
          )}

          {/* Checking Overlay */}
          {isChecking && (
            <div className="absolute inset-0 bg-brand-900/85 flex flex-col items-center justify-center gap-3 z-20">
              <div className="w-8 h-8 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
              <p className="text-white font-medium text-sm">Checking your ID...</p>
            </div>
          )}

          {/* Torch Button */}
          {hasTorch && isScanning && (
            <button
              type="button"
              onClick={toggleTorch}
              className={`absolute top-3 right-3 p-2.5 rounded-full transition z-10 ${
                isTorchOn ? 'bg-white text-brand-900' : 'bg-white/15 text-white hover:bg-white/25'
              }`}
              title="Toggle Flashlight"
            >
              <Flashlight className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Raw scan readout (local development builds only) */}
        {IS_DEV_BUILD && lastRawScan && (
          <p className="text-[10px] font-mono text-slate-500 px-1">Last raw scan: {lastRawScan}</p>
        )}

        {/* Hidden File Input for fallback photo scan */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileScan}
          accept="image/*"
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-3.5 px-4 rounded-xl border border-brand-100 hover:bg-brand-50 text-brand-700 font-semibold text-sm flex items-center justify-center gap-2 transition"
        >
          <Upload className="w-4 h-4" />
          <span>Upload a photo</span>
        </button>

        <p className="pt-4 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand-600 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
