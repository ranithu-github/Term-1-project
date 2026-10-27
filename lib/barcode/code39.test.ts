import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { code39Pattern, decodeCode39Image, decodeRuns, toRuns } from './code39';

/**
 * Draws a Code 39 barcode the way it comes out on the printed UoM card:
 * bars spread by `inkSpread` px into the gaps, optional quiet zone, glare.
 */
function drawCard(text: string, opts: { module?: number; ratio?: number; inkSpread?: number; quiet?: number; glare?: number; noise?: number; seed?: number } = {}) {
  const { module = 6, ratio = 2.5, inkSpread = 0, quiet = 60, glare = 0, noise = 0 } = opts;
  let seed = opts.seed ?? 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const elements: Array<{ dark: boolean; w: number }> = [];
  for (const [n, ch] of [...`*${text}*`].entries()) {
    if (n > 0) elements.push({ dark: false, w: module }); // gap between characters
    const pattern = code39Pattern(ch)!;
    [...pattern].forEach((bit, k) => elements.push({ dark: k % 2 === 0, w: bit === '1' ? module * ratio : module }));
  }
  const width = Math.round(elements.reduce((a, e) => a + e.w, 0) + quiet * 2);
  const height = 40;

  // Which columns are inked: each bar spreads by inkSpread px on both sides
  const inked = new Array<boolean>(width).fill(false);
  let pos = quiet;
  for (const e of elements) {
    if (e.dark) {
      for (let x = Math.max(0, Math.floor(pos - inkSpread)); x < Math.min(width, pos + e.w + inkSpread); x++) inked[x] = true;
    }
    pos += e.w;
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shine = glare * Math.max(0, 1 - x / (width * 0.35)); // glare on the left third
      const v = (inked[x] ? 40 + shine : 225) + (random() - 0.5) * noise;
      const i = (y * width + x) * 4;
      data[i] = inked[x] ? v * 0.6 : v; // the glare on the card is teal-ish: less red
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('Code 39 decoder', () => {
  it('reads a clean barcode', () => {
    expect(decodeCode39Image(drawCard('250999X'))).toBe('250999X');
  });

  it('reads the printed card: heavy ink spread, no quiet zone, glare, noise', () => {
    // Proportions measured on a real card photo: a narrow bar (9 + 2×2.5 = 14 px) is as wide as
    // a wide gap (19.8 − 5 ≈ 15 px), so a single-threshold decoder can't tell them apart
    const card = drawCard('250999X', { module: 9, ratio: 2.2, inkSpread: 2.5, quiet: 3, glare: 70, noise: 30 });
    expect(decodeCode39Image(card)).toBe('250999X');
  });

  it('reads upside down (right to left)', () => {
    const runs = toRuns(Array.from(lineOf(drawCard('123456A'))).reverse(), 30);
    expect(decodeRuns(runs)).toBe('123456A');
  });

  it('rejects a barcode with a damaged character instead of guessing', () => {
    const card = drawCard('250999X');
    // paint over part of the 4th character on every row
    for (let y = 0; y < card.height; y++) {
      for (let x = 230; x < 260; x++) card.data.fill(225, (y * card.width + x) * 4, (y * card.width + x) * 4 + 3);
    }
    expect(decodeCode39Image(card)).toBeNull();
  });

  it('rejects a picture with no barcode', () => {
    const blank = { width: 200, height: 50, data: new Uint8ClampedArray(200 * 50 * 4).fill(200) };
    expect(decodeCode39Image(blank)).toBeNull();
  });

  // Optional: the real card photo, kept outside the repo (it shows a student's name and address).
  // ASTRIX_ID_RAW=/path/card-<width>x<height>.rgba ASTRIX_ID_EXPECT=250999X npx vitest run
  it.runIf(Boolean(process.env.ASTRIX_ID_RAW))('reads the real UoM ID photo', () => {
    const file = process.env.ASTRIX_ID_RAW!;
    const [, w, h] = file.match(/-(\d+)x(\d+)\.rgba$/)!;
    const img = { data: new Uint8ClampedArray(fs.readFileSync(file)), width: Number(w), height: Number(h) };
    expect(decodeCode39Image(img)).toBe(process.env.ASTRIX_ID_EXPECT);
  });
});

function lineOf(img: { data: Uint8ClampedArray; width: number; height: number }) {
  const y = Math.floor(img.height / 2);
  return Float32Array.from({ length: img.width }, (_, x) => img.data[(y * img.width + x) * 4 + 1]);
}
