// =====================================================================
// Code 39 decoder for the UoM student ID barcode.
//
// Why not just a library: the barcode on the printed card has heavy ink
// spread (bars print fatter, gaps thinner), so a narrow bar is about as
// wide as a wide gap. General decoders (ZXing, used by html5-qrcode) use a
// single width threshold for bars and gaps together and can't read it. The
// card also prints the barcode almost to its edge, so there is no quiet
// zone. This decoder measures bars and gaps separately and doesn't need a
// quiet zone. Every read must still start and end with '*' and every
// character must match the Code 39 table exactly, so a misread is rejected
// rather than guessed.
// =====================================================================

// 9 elements per character (bar, space, bar, ... bar); 1 = wide
const PATTERNS: Record<string, string> = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000',
  F: '001011000', G: '000001101', H: '100001100', I: '001001100', J: '000011100',
  K: '100000011', L: '001000011', M: '101000010', N: '000010011', O: '100010010',
  P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001', Y: '110010000',
  Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', '*': '010010100',
  $: '010101000', '/': '010100010', '+': '010001010', '%': '000101010',
};
const BY_PATTERN: Record<string, string> = Object.fromEntries(
  Object.entries(PATTERNS).map(([ch, p]) => [p, ch])
);

const MAX_CHARS = 24;
const MIN_CONTRAST = 24; // grey levels; flatter areas count as background

/** The 9 wide/narrow flags of a character, for building test images */
export function code39Pattern(ch: string): string | undefined {
  return PATTERNS[ch];
}

/**
 * Splits one line of grey values (0 = black) into alternating run widths.
 * Each pixel is compared with the midpoint of the darkest and lightest pixel
 * around it, so glare or shadow across the card doesn't break the bars.
 * Edges are placed between pixels where the line crosses that midpoint, so
 * small or slightly blurred bars still get accurate (fractional) widths.
 * Returns widths starting with a bar.
 */
export function toRuns(line: ArrayLike<number>, window: number): number[] {
  const n = line.length;
  const half = Math.max(4, Math.floor(window / 2));
  const lo = slidingExtreme(line, half, (a, b) => a <= b);
  const hi = slidingExtreme(line, half, (a, b) => a >= b);
  // > 0 = darker than its surroundings; flat areas count as background
  const level = (i: number) => (hi[i] - lo[i] >= MIN_CONTRAST ? (hi[i] + lo[i]) / 2 - line[i] : -1);

  const runs: number[] = [];
  let edge = 0;
  let prev = level(0);
  let dark = prev > 0;
  for (let i = 1; i < n; i++) {
    const cur = level(i);
    if (cur > 0 === dark) {
      prev = cur;
      continue;
    }
    const at = i - 1 + prev / (prev - cur); // where the line crosses the midpoint
    if (dark || runs.length > 0) runs.push(at - edge); // drop the leading space
    edge = at;
    dark = !dark;
    prev = cur;
  }
  if (dark) runs.push(n - edge);
  return runs;
}

/** Running min or max over [i - half, i + half] in O(n) */
function slidingExtreme(line: ArrayLike<number>, half: number, keep: (a: number, b: number) => boolean) {
  const n = line.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    for (; next < n && next <= i + half; next++) {
      while (tail > head && keep(line[next], line[deque[tail - 1]])) tail--;
      deque[tail++] = next;
    }
    while (deque[head] < i - half) head++;
    out[i] = line[deque[head]];
  }
  return out;
}

/**
 * Decodes the text between the '*' start and stop characters from run widths
 * (bar, space, bar, ...), or null. Tries both reading directions.
 */
export function decodeRuns(runs: number[]): string | null {
  return decodeForward(runs) ?? decodeForward(runs.slice().reverse().slice(runs.length % 2 === 0 ? 1 : 0));
}

function decodeForward(runs: number[]): string | null {
  // runs[even] are bars, runs[odd] are spaces
  for (let start = 0; start + 9 <= runs.length; start += 2) {
    const text = decodeFrom(runs, start);
    if (text) return text;
  }
  return null;
}

function decodeFrom(runs: number[], start: number): string | null {
  // Learn the narrow/wide widths from the start character ('*' = bars n n W W n, spaces W n n n)
  const bars = [0, 2, 4, 6, 8].map((k) => runs[start + k]);
  const spaces = [1, 3, 5, 7].map((k) => runs[start + k]);
  const narrowBar = (bars[0] + bars[1] + bars[4]) / 3;
  const wideBar = (bars[2] + bars[3]) / 2;
  const narrowSpace = (spaces[1] + spaces[2] + spaces[3]) / 3;
  const wideSpace = spaces[0];
  if (Math.min(bars[2], bars[3]) <= Math.max(bars[0], bars[1], bars[4]) * 1.2) return null;
  if (wideSpace <= Math.max(spaces[1], spaces[2], spaces[3]) * 1.3) return null;

  let barCut = (narrowBar + wideBar) / 2;
  let spaceCut = (narrowSpace + wideSpace) / 2;
  const charWidth = sum(runs, start, 9);
  let text = '';

  for (let i = start + 10; text.length <= MAX_CHARS; i += 10) {
    if (i + 9 > runs.length) return null;
    // The gap between characters is normally narrow; a big one means we've left the barcode
    if (runs[i - 1] > spaceCut * 2) return null;
    const width = sum(runs, i, 9);
    if (Math.abs(width - charWidth) > charWidth * 0.25) return null;

    let pattern = '';
    for (let k = 0; k < 9; k++) pattern += runs[i + k] > (k % 2 === 0 ? barCut : spaceCut) ? '1' : '0';
    const ch = BY_PATTERN[pattern];
    if (!ch) return null;
    if (ch === '*') return text.length > 0 ? text : null;
    text += ch;

    // Follow slow changes in scale (card tilted towards or away from the camera)
    const scale = width / charWidth;
    barCut = ((narrowBar + wideBar) / 2) * scale;
    spaceCut = ((narrowSpace + wideSpace) / 2) * scale;
  }
  return null;
}

function sum(runs: number[], from: number, count: number) {
  let total = 0;
  for (let k = 0; k < count; k++) total += runs[from + k];
  return total;
}

export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array; // RGBA
  width: number;
  height: number;
}

// Scan-line angles in degrees: the card is rarely held perfectly straight
const ANGLES = [0, -4, 4, -8, 8, -12, 12];
const LINES_PER_ANGLE = 32;

/**
 * Reads Code 39 from a picture by sampling many straight lines across it, at
 * small angles either side of horizontal and of vertical (card held sideways).
 * A result is returned only when at least `minAgree` lines read the same text.
 */
export function decodeCode39Image(img: ImageLike, minAgree = 2): string | null {
  const { data, width, height } = img;
  // Darkest channel: keeps black bars dark even under coloured glare
  const grey = new Float32Array(width * height);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) grey[p] = Math.min(data[i], data[i + 1], data[i + 2]);

  // Bilinear sample, averaged with the pixels just above and below the line to smooth noise
  const sample = (x: number, y: number) => {
    const x0 = Math.min(width - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(height - 2, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0));
    const fy = Math.min(1, Math.max(0, y - y0));
    const p = y0 * width + x0;
    return (
      grey[p] * (1 - fx) * (1 - fy) + grey[p + 1] * fx * (1 - fy) +
      grey[p + width] * (1 - fx) * fy + grey[p + width + 1] * fx * fy
    );
  };

  const votes = new Map<string, number>();
  const tryLine = (cx: number, cy: number, dx: number, dy: number, length: number) => {
    const nx = -dy; // unit normal, for the 3-line average
    const ny = dx;
    const line = new Float32Array(length);
    for (let t = 0; t < length; t++) {
      const x = cx + (t - length / 2) * dx;
      const y = cy + (t - length / 2) * dy;
      line[t] = (sample(x - nx, y - ny) + sample(x, y) + sample(x + nx, y + ny)) / 3;
    }
    const text = decodeRuns(toRuns(line, Math.max(24, Math.round(length / 24))));
    if (!text) return null;
    const count = (votes.get(text) || 0) + 1;
    votes.set(text, count);
    return count >= minAgree ? text : null;
  };

  for (const sideways of [false, true]) {
    const along = sideways ? height : width; // the direction the bars are read in
    const across = sideways ? width : height;
    for (const degrees of ANGLES) {
      const a = (degrees * Math.PI) / 180;
      const [dx, dy] = sideways ? [-Math.sin(a), Math.cos(a)] : [Math.cos(a), Math.sin(a)];
      for (let k = 1; k < LINES_PER_ANGLE; k++) {
        const offset = (across * k) / LINES_PER_ANGLE;
        const [cx, cy] = sideways ? [offset, height / 2] : [width / 2, offset];
        const hit = tryLine(cx, cy, dx, dy, along);
        if (hit) return hit;
      }
    }
  }
  return null;
}
