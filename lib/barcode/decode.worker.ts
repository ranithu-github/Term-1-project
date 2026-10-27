// Decodes camera frames off the main thread so the camera view never stutters.
import { decodeCode39Image } from './code39';

self.onmessage = (event: MessageEvent<{ id: number; data: Uint8ClampedArray; width: number; height: number; minAgree?: number }>) => {
  const { id, data, width, height, minAgree } = event.data;
  let text: string | null = null;
  try {
    text = decodeCode39Image({ data, width, height }, minAgree);
  } catch {
    // a bad frame is just skipped
  }
  self.postMessage({ id, text });
};
