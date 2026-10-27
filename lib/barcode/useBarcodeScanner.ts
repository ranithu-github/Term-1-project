'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// =====================================================================
// Camera barcode scanner for the student ID.
// Two readers run on every frame and the first answer wins:
//   1. our Code 39 decoder (lib/barcode/code39.ts) in a Web Worker: it reads
//      the UoM card's printing, which general decoders can't (see code39.ts)
//   2. the phone's built-in BarcodeDetector, where the browser has one
// =====================================================================

export type ScannerError = 'denied' | 'no-camera' | 'unsupported' | 'failed';

const FRAME_EVERY_MS = 120;
const MAX_FRAME_WIDTH = 1280; // enough detail for the bars, small enough to decode fast
const WORKER_TIMEOUT_MS = 1500;

type Detector = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };

export function useBarcodeScanner(onRead: (text: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const detectorRef = useRef<Detector | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<ScannerError | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const workerFailedRef = useRef(false);

  const getWorker = useCallback(() => {
    if (!workerRef.current && !workerFailedRef.current) {
      try {
        workerRef.current = new Worker(new URL('./decode.worker.ts', import.meta.url));
        workerRef.current.onerror = () => {
          // The worker couldn't load or crashed: decode on the main thread from now on
          console.warn('[Scanner] Decoder worker failed; decoding on the main thread.');
          workerFailedRef.current = true;
          workerRef.current?.terminate();
          workerRef.current = null;
        };
      } catch {
        workerFailedRef.current = true;
      }
    }
    return workerRef.current;
  }, []);

  // Decode one picture, in the worker when possible; resolves with the text or null.
  // Never hangs: a frame the worker doesn't answer within WORKER_TIMEOUT_MS is skipped.
  const decodeInWorker = useCallback(
    async (image: ImageData): Promise<string | null> => {
      const worker = getWorker();
      if (!worker) {
        const { decodeCode39Image } = await import('./code39');
        return decodeCode39Image(image);
      }
      return new Promise<string | null>((resolve) => {
        const id = Math.random();
        const done = (text: string | null) => {
          clearTimeout(timer);
          worker.removeEventListener('message', handle);
          resolve(text);
        };
        const handle = (e: MessageEvent<{ id: number; text: string | null }>) => {
          if (e.data.id === id) done(e.data.text);
        };
        const timer = setTimeout(() => done(null), WORKER_TIMEOUT_MS);
        worker.addEventListener('message', handle);
        worker.postMessage({ id, data: image.data, width: image.width, height: image.height }, [image.data.buffer]);
      });
    },
    [getWorker]
  );

  const stop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsScanning(false);
    setTorchOn(false);
  }, []);

  // The part of the camera picture the student can actually see (the video is
  // shown with object-fit: cover), scaled down to MAX_FRAME_WIDTH
  const grabVisibleFrame = (video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cw = video.clientWidth || vw;
    const ch = video.clientHeight || vh;
    if (!vw || !vh) return null;
    const scale = Math.max(cw / vw, ch / vh);
    const sw = Math.min(vw, cw / scale);
    const sh = Math.min(vh, ch / scale);
    const out = Math.min(1, MAX_FRAME_WIDTH / sw);
    canvas.width = Math.round(sw * out);
    canvas.height = Math.round(sh * out);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  };

  const start = useCallback(async () => {
    if (runningRef.current) return;
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('unsupported'); // e.g. the page was opened over plain http
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e: any) {
      const name = e?.name || '';
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no-camera' : 'failed');
      return;
    }

    const video = videoRef.current;
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    runningRef.current = true;

    const track = stream.getVideoTracks()[0];
    // Sharp bars matter more than anything else for a 1D barcode
    track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
    try {
      setHasTorch(Boolean((track?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch));
    } catch {
      setHasTorch(false);
    }

    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // iOS: don't go full screen
    video.muted = true;
    try {
      await video.play();
    } catch {
      // autoplay of a muted inline video is allowed everywhere we care about; keep going
    }
    setIsScanning(true);

    // The browser's own reader, if it has one that knows Code 39
    if (!detectorRef.current && 'BarcodeDetector' in window) {
      try {
        const BD = (window as any).BarcodeDetector;
        const formats: string[] = await BD.getSupportedFormats();
        if (formats.includes('code_39')) detectorRef.current = new BD({ formats: ['code_39'] });
      } catch {
        detectorRef.current = null;
      }
    }

    const canvas = document.createElement('canvas');
    const tick = async () => {
      if (!runningRef.current) return;
      if (video.readyState >= 2) {
        const reads = [];
        const frame = grabVisibleFrame(video, canvas);
        if (frame) reads.push(decodeInWorker(frame));
        if (detectorRef.current) {
          reads.push(
            detectorRef.current
              .detect(video)
              .then((codes) => codes[0]?.rawValue ?? null)
              .catch(() => null)
          );
        }
        // One read per frame, even if both readers saw it: the page wants the same
        // index from two separate frames before it accepts it
        const text = (await Promise.all(reads)).find(Boolean);
        if (text && runningRef.current) onReadRef.current(text);
      }
      if (runningRef.current) timerRef.current = setTimeout(tick, FRAME_EVERY_MS);
    };
    tick();
  }, [decodeInWorker]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] });
      setTorchOn(!torchOn);
    } catch {
      setHasTorch(false);
    }
  }, [torchOn]);

  /** Reads the barcode from a photo the student picked; resolves with the text or null */
  const decodeFile = useCallback(
    async (file: File): Promise<string | null> => {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      const ours = await decodeInWorker(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (ours || !detectorRef.current) return ours;
      const codes = await detectorRef.current.detect(canvas).catch(() => []);
      return codes[0]?.rawValue ?? null;
    },
    [decodeInWorker]
  );

  // Release the camera and the worker when the page goes away
  useEffect(
    () => () => {
      stop();
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [stop]
  );

  return { videoRef, start, stop, isScanning, error, hasTorch, torchOn, toggleTorch, decodeFile };
}
