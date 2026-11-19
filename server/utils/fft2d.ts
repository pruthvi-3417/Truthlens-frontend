function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

function radix2Fft(re: Float64Array, im: Float64Array, n: number, invert: boolean): void {
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uIdx = i + j;
        const vIdx = uIdx + half;
        const uRe = re[uIdx];
        const uIm = im[uIdx];
        const vRe = re[vIdx] * wRe - im[vIdx] * wIm;
        const vIm = re[vIdx] * wIm + im[vIdx] * wRe;

        re[uIdx] = uRe + vRe;
        im[uIdx] = uIm + vIm;
        re[vIdx] = uRe - vRe;
        im[vIdx] = uIm - vIm;

        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }

  if (invert) {
    const invN = 1 / n;
    for (let i = 0; i < n; i += 1) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

export interface Fft1DPlan {
  n: number;
  transform: (inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array) => void;
}

export function createFft1DPlan(n: number): Fft1DPlan {
  if (n <= 1) {
    return {
      n,
      transform: (inRe, inIm, outRe, outIm) => {
        if (n === 1) {
          outRe[0] = inRe[0];
          outIm[0] = inIm[0];
        }
      },
    };
  }

  if ((n & (n - 1)) === 0) {
    return {
      n,
      transform: (inRe, inIm, outRe, outIm) => {
        outRe.set(inRe.subarray(0, n));
        outIm.set(inIm.subarray(0, n));
        radix2Fft(outRe, outIm, n, false);
      },
    };
  }

  const m = nextPow2(2 * n - 1);
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  const bFftRe = new Float64Array(m);
  const bFftIm = new Float64Array(m);
  const aBufRe = new Float64Array(m);
  const aBufIm = new Float64Array(m);

  const twoN = 2 * n;
  for (let k = 0; k < n; k += 1) {
    const angle = (Math.PI * ((k * k) % twoN)) / n;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    chirpRe[k] = c;
    chirpIm[k] = -s;
    bFftRe[k] = c;
    bFftIm[k] = s;
    if (k > 0) {
      bFftRe[m - k] = c;
      bFftIm[m - k] = s;
    }
  }

  radix2Fft(bFftRe, bFftIm, m, false);

  return {
    n,
    transform: (inRe, inIm, outRe, outIm) => {
      aBufRe.fill(0);
      aBufIm.fill(0);
      for (let k = 0; k < n; k += 1) {
        const xr = inRe[k];
        const xi = inIm[k];
        const cr = chirpRe[k];
        const ci = chirpIm[k];
        aBufRe[k] = xr * cr - xi * ci;
        aBufIm[k] = xr * ci + xi * cr;
      }

      radix2Fft(aBufRe, aBufIm, m, false);

      for (let k = 0; k < m; k += 1) {
        const ar = aBufRe[k];
        const ai = aBufIm[k];
        const br = bFftRe[k];
        const bi = bFftIm[k];
        aBufRe[k] = ar * br - ai * bi;
        aBufIm[k] = ar * bi + ai * br;
      }

      radix2Fft(aBufRe, aBufIm, m, true);

      for (let k = 0; k < n; k += 1) {
        const ar = aBufRe[k];
        const ai = aBufIm[k];
        const cr = chirpRe[k];
        const ci = chirpIm[k];
        outRe[k] = ar * cr - ai * ci;
        outIm[k] = ar * ci + ai * cr;
      }
    },
  };
}

export function fft2dShiftedMagnitudeAndPower(
  inputReal: Float64Array,
  height: number,
  width: number,
): { magnitude: Float64Array; power: Float64Array } {
  const total = height * width;
  const re = new Float64Array(total);
  const im = new Float64Array(total);

  const rowPlan = createFft1DPlan(width);
  const colPlan = createFft1DPlan(height);

  const rowInRe = new Float64Array(width);
  const rowInIm = new Float64Array(width);
  const rowOutRe = new Float64Array(width);
  const rowOutIm = new Float64Array(width);

  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    rowInRe.set(inputReal.subarray(offset, offset + width));
    rowInIm.fill(0);
    rowPlan.transform(rowInRe, rowInIm, rowOutRe, rowOutIm);
    re.set(rowOutRe, offset);
    im.set(rowOutIm, offset);
  }

  const colInRe = new Float64Array(height);
  const colInIm = new Float64Array(height);
  const colOutRe = new Float64Array(height);
  const colOutIm = new Float64Array(height);

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const idx = y * width + x;
      colInRe[y] = re[idx];
      colInIm[y] = im[idx];
    }
    colPlan.transform(colInRe, colInIm, colOutRe, colOutIm);
    for (let y = 0; y < height; y += 1) {
      const idx = y * width + x;
      re[idx] = colOutRe[y];
      im[idx] = colOutIm[y];
    }
  }

  const magnitude = new Float64Array(total);
  const power = new Float64Array(total);
  const shiftY = Math.floor(height / 2);
  const shiftX = Math.floor(width / 2);

  for (let y = 0; y < height; y += 1) {
    const sy = (y + shiftY) % height;
    for (let x = 0; x < width; x += 1) {
      const sx = (x + shiftX) % width;
      const srcIdx = y * width + x;
      const dstIdx = sy * width + sx;
      const p = re[srcIdx] * re[srcIdx] + im[srcIdx] * im[srcIdx];
      power[dstIdx] = p;
      magnitude[dstIdx] = Math.sqrt(p);
    }
  }

  return { magnitude, power };
}
