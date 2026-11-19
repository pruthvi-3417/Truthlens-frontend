import sharp from 'sharp';
import type {
  AnalysisItem,
  ELADetails,
  MethodDocumentation,
  NoiseDetails,
  RecompressionDetails,
  RegionalAnomalyDetails,
  RegionalAnomalyItem,
} from '../types.ts';
import { fft2dShiftedMagnitudeAndPower } from '../utils/fft2d.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import { normalizeGridScores } from './gridNormalization.ts';

const DEFAULT_EDGE_THRESHOLD = 15.0;
const MIN_FFT_REGION_DIM = 8;
const MAX_VISUALIZATION_DIMENSION = 1200;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function hann1D(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 2) {
    w.fill(1);
    return w;
  }
  const denom = n - 1;
  for (let i = 0; i < n; i += 1) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return w;
}

function computeRegionalFftHighFreqRatio(
  lumArr: Float32Array,
  imgWidth: number,
  x1: number,
  y1: number,
  tw: number,
  th: number,
): number | null {
  if (th < MIN_FFT_REGION_DIM || tw < MIN_FFT_REGION_DIM) return null;

  // Cap large tiles (e.g. 12MP tiles of 1000x750) to radix-2 128x128 via uniform stride sampling
  // to avoid O(N log N) Bluestein transform overhead on multi-megapixel images.
  const MAX_TILE_FFT_DIM = 128;
  const fftW = tw > MAX_TILE_FFT_DIM ? MAX_TILE_FFT_DIM : tw;
  const fftH = th > MAX_TILE_FFT_DIM ? MAX_TILE_FFT_DIM : th;
  const total = fftW * fftH;

  let tileSum = 0;
  const sampleBuf = new Float64Array(total);
  if (fftW === tw && fftH === th) {
    for (let y = 0; y < th; y += 1) {
      const rowOffset = (y1 + y) * imgWidth + x1;
      const dstOffset = y * fftW;
      for (let x = 0; x < tw; x += 1) {
        const v = lumArr[rowOffset + x];
        sampleBuf[dstOffset + x] = v;
        tileSum += v;
      }
    }
  } else {
    for (let y = 0; y < fftH; y += 1) {
      const sy = y1 + Math.min(th - 1, Math.floor((y * th) / fftH));
      const rowOffset = sy * imgWidth + x1;
      const dstOffset = y * fftW;
      for (let x = 0; x < fftW; x += 1) {
        const sx = Math.min(tw - 1, Math.floor((x * tw) / fftW));
        const v = lumArr[rowOffset + sx];
        sampleBuf[dstOffset + x] = v;
        tileSum += v;
      }
    }
  }
  const tileMean = tileSum / total;

  const wh = hann1D(fftH);
  const ww = hann1D(fftW);
  const windowed = new Float64Array(total);
  for (let y = 0; y < fftH; y += 1) {
    const wy = wh[y];
    const rowOffset = y * fftW;
    for (let x = 0; x < fftW; x += 1) {
      windowed[rowOffset + x] = (sampleBuf[rowOffset + x] - tileMean) * wy * ww[x];
    }
  }

  const { power } = fft2dShiftedMagnitudeAndPower(windowed, fftH, fftW);
  const cy = Math.floor(fftH / 2);
  const cx = Math.floor(fftW / 2);
  let totalPower = 0;
  for (let i = 0; i < total; i += 1) totalPower += power[i];
  const dcPower = power[cy * fftW + cx];
  const nonDcPower = totalPower - dcPower;
  if (nonDcPower <= 1e-12) return 0;

  const ny = Math.max(1, fftH / 2);
  const nx = Math.max(1, fftW / 2);
  let highFreqPower = 0;

  for (let y = 0; y < fftH; y += 1) {
    const fy = (y - cy) / ny;
    const rowOffset = y * fftW;
    for (let x = 0; x < fftW; x += 1) {
      const fx = (x - cx) / nx;
      if (fx * fx + fy * fy >= 0.16) {
        highFreqPower += power[rowOffset + x];
      }
    }
  }

  return Math.min(1, Math.max(0, highFreqPower / nonDcPower));
}

function escapeXml(str: string): string {
  return str.replace(/[<>&'"]/g, (ch) => {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '&') return '&amp;';
    if (ch === "'") return '&apos;';
    return '&quot;';
  });
}

async function generateVisualizationDataUrl(
  decoded: DecodedImage,
  regionalItems: RegionalAnomalyItem[],
  maxScore: number,
): Promise<string> {
  const { width: origW, height: origH, rgbPixels } = decoded;
  const origBuf = Buffer.from(rgbPixels.buffer, rgbPixels.byteOffset, rgbPixels.byteLength);

  let visW = origW;
  let visH = origH;
  let scaleX = 1;
  let scaleY = 1;

  let basePipeline = sharp(origBuf, {
    raw: { width: origW, height: origH, channels: 3 },
  });

  if (Math.max(origW, origH) > MAX_VISUALIZATION_DIMENSION) {
    const scale = MAX_VISUALIZATION_DIMENSION / Math.max(origW, origH);
    visW = Math.max(1, Math.round(origW * scale));
    visH = Math.max(1, Math.round(origH * scale));
    scaleX = visW / origW;
    scaleY = visH / origH;
    basePipeline = basePipeline.resize(visW, visH, { fit: 'fill' });
  }

  const normDenom = Math.max(2.5, maxScore);
  const svgRects: string[] = [];

  for (const item of regionalItems) {
    const x1 = Math.round(item.x * scaleX);
    const y1 = Math.round(item.y * scaleY);
    const x2 = Math.min(visW, Math.round((item.x + item.width) * scaleX));
    const y2 = Math.min(visH, Math.round((item.y + item.height) * scaleY));
    const rw = x2 - x1;
    const rh = y2 - y1;
    if (rw <= 0 || rh <= 0) continue;

    const frac = Math.min(1, Math.max(0, item.deviation_score / normDenom));
    let r: number;
    let g: number;
    let b: number;
    let a: number;

    if (frac <= 0.5) {
      const t = frac / 0.5;
      r = Math.round(46 * (1 - t) + 243 * t);
      g = Math.round(134 * (1 - t) + 156 * t);
      b = Math.round(193 * (1 - t) + 18 * t);
      a = (50 * (1 - t) + 80 * t) / 255;
    } else {
      const t = (frac - 0.5) / 0.5;
      r = Math.round(243 * (1 - t) + 231 * t);
      g = Math.round(156 * (1 - t) + 76 * t);
      b = Math.round(18 * (1 - t) + 60 * t);
      a = (80 * (1 - t) + 110 * t) / 255;
    }

    svgRects.push(
      `<rect x="${x1}" y="${y1}" width="${rw}" height="${rh}" fill="rgba(${r},${g},${b},${a.toFixed(3)})" stroke="rgba(255,255,255,0.63)" stroke-width="1"/>`,
    );

    if (rw >= 48 && rh >= 22) {
      const label = escapeXml(`${item.region_id} (${item.deviation_score.toFixed(1)})`);
      svgRects.push(
        `<text x="${x1 + 5}" y="${y1 + 15}" font-family="sans-serif" font-size="11" fill="rgba(255,255,255,0.92)">${label}</text>`,
      );
    }
  }

  const footerHeight = 28;
  const legendBarW = Math.min(120, Math.max(40, Math.floor(visW / 4)));
  const legendX = visW - legendBarW - 10;
  const legendY = visH + 8;

  const overlaySvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${visW}" height="${visH + footerHeight}">
  <defs>
    <linearGradient id="devGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="rgb(46,134,193)"/>
      <stop offset="50%" stop-color="rgb(243,156,18)"/>
      <stop offset="100%" stop-color="rgb(231,76,60)"/>
    </linearGradient>
  </defs>
  ${svgRects.join('\n  ')}
  <rect x="0" y="${visH}" width="${visW}" height="${footerHeight}" fill="rgb(22,26,34)"/>
  <text x="10" y="${visH + 18}" font-family="sans-serif" font-size="11" fill="rgb(200,205,215)">Regional Deviation: Low -&gt; Elevated (relative statistical contrast)</text>
  <rect x="${legendX}" y="${legendY}" width="${legendBarW}" height="10" fill="url(#devGrad)"/>
</svg>`.trim();

  const extendedBase = await basePipeline
    .extend({
      bottom: footerHeight,
      background: { r: 22, g: 26, b: 34, alpha: 1 },
    })
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer();

  return `data:image/png;base64,${extendedBase.toString('base64')}`;
}

function formatNeutralObservation(
  score: number,
  zScores: Record<string, number>,
): string {
  if (score < 0.8) {
    return 'Regional measurements are closely aligned with image-wide statistics.';
  }
  if (score < 1.8) {
    return 'Mild regional variation observed, consistent with normal spatial distribution.';
  }

  const featNames: Record<string, string> = {
    std_luminance: 'luminance variation',
    mean_gradient: 'gradient magnitude',
    std_gradient: 'texture variation',
    edge_density: 'edge density',
    noise_residual_std: 'residual variation',
    noise_mean_abs: 'residual magnitude',
    ela_mean: 'recompression difference',
    ela_variance: 'recompression variance',
    regional_fft_high_freq_ratio: 'high-frequency spectral energy',
  };

  let topFeature = 'characteristics';
  let topZ = score;
  for (const [k, v] of Object.entries(zScores)) {
    if (v > topZ || topFeature === 'characteristics') {
      topFeature = k;
      topZ = v;
    }
  }
  const topLabel = featNames[topFeature] ?? topFeature;
  return `Elevated statistical deviation observed, primarily driven by ${topLabel} (z=${topZ.toFixed(2)}); regional differences reflect spatial texture rather than tampering.`;
}

export async function buildRegionalAnalysis(
  decoded: DecodedImage,
  options: {
    gridRows?: number;
    gridCols?: number;
    edgeThreshold?: number;
    elaAnalysis?: AnalysisItem | null;
    noiseAnalysis?: AnalysisItem | null;
    recompressionAnalysis?: AnalysisItem | null;
    includeVisualization?: boolean;
  } = {},
): Promise<AnalysisItem> {
  const rows = Math.max(1, options.gridRows ?? 4);
  const cols = Math.max(1, options.gridCols ?? 4);
  const edgeThreshold = options.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;
  const includeVisualization = options.includeVisualization ?? true;

  try {
    const { width, height, rgbPixels } = decoded;
    const totalRegions = rows * cols;
    const totalPixels = width * height;

    const lumArr = new Float32Array(totalPixels);
    for (let p = 0; p < totalPixels; p += 1) {
      const idx = p * 3;
      lumArr[p] = 0.299 * rgbPixels[idx] + 0.587 * rgbPixels[idx + 1] + 0.114 * rgbPixels[idx + 2];
    }

    const gradMag = new Float32Array(totalPixels);
    if (height >= 2 && width >= 2) {
      for (let y = 0; y < height; y += 1) {
        const yPrev = y === 0 ? 0 : y - 1;
        const yNext = y === height - 1 ? height - 1 : y + 1;
        const yDenom = y === 0 || y === height - 1 ? 1 : 2;
        const rowOff = y * width;

        for (let x = 0; x < width; x += 1) {
          const xPrev = x === 0 ? 0 : x - 1;
          const xNext = x === width - 1 ? width - 1 : x + 1;
          const xDenom = x === 0 || x === width - 1 ? 1 : 2;

          const gy = (lumArr[yNext * width + x] - lumArr[yPrev * width + x]) / yDenom;
          const gx = (lumArr[rowOff + xNext] - lumArr[rowOff + xPrev]) / xDenom;
          gradMag[rowOff + x] = Math.sqrt(gx * gx + gy * gy);
        }
      }
    }

    const noiseById = new Map<string, { std: number; mean_difference: number }>();
    if (
      options.noiseAnalysis &&
      options.noiseAnalysis.status === 'completed' &&
      options.noiseAnalysis.details
    ) {
      const nd = options.noiseAnalysis.details as NoiseDetails;
      for (const rm of nd.regional_metrics ?? []) {
        noiseById.set(rm.region_id, { std: rm.std, mean_difference: rm.mean_difference });
      }
    }

    const elaById = new Map<string, { mean_difference: number; variance: number }>();
    if (
      options.elaAnalysis &&
      options.elaAnalysis.status === 'completed' &&
      options.elaAnalysis.details
    ) {
      const ed = options.elaAnalysis.details as ELADetails;
      for (const rm of ed.regional_metrics ?? []) {
        elaById.set(rm.region_id, { mean_difference: rm.mean_difference, variance: rm.variance });
      }
    }

    const blockGridById = new Map<
      string,
      {
        z: number;
        alignedRatio: number;
        alignedVsShiftedRatio: number;
        dominantOffset: [number, number];
      }
    >();
    if (
      options.recompressionAnalysis &&
      options.recompressionAnalysis.status === 'completed' &&
      options.recompressionAnalysis.details
    ) {
      const rd = options.recompressionAnalysis.details as RecompressionDetails;
      if (rd.pixel_block_grid?.available) {
        const rawBlockById = new Map<
          string,
          {
            aligned_blockiness: number;
            aligned_vs_shifted_ratio: number;
            dominant_offset: [number, number];
          }
        >();
        for (const rm of rd.pixel_block_grid.regional_block_grid ?? []) {
          rawBlockById.set(rm.region_id, rm);
        }
        for (const rg of rd.pixel_block_grid.region_grid_scores ?? []) {
          const rm = rawBlockById.get(rg.region_id);
          blockGridById.set(rg.region_id, {
            z: rg.robust_z,
            alignedRatio: rm?.aligned_blockiness ?? 1.0,
            alignedVsShiftedRatio: rm?.aligned_vs_shifted_ratio ?? 1.0,
            dominantOffset: rm?.dominant_offset ?? [0, 0],
          });
        }
      }
    }

    const tiles = partitionGrid(width, height, rows, cols);
    const hasNoise = noiseById.size > 0;
    const hasEla = elaById.size > 0;
    const hasBlockGrid = blockGridById.size > 0;
    const hasRegionalFft = Math.min(Math.floor(width / cols), Math.floor(height / rows)) >= MIN_FFT_REGION_DIM;

    const activeModules: string[] = ['luminance', 'gradient'];
    if (hasNoise) activeModules.push('noise');
    if (hasEla) activeModules.push('ela');
    if (hasRegionalFft) activeModules.push('frequency');
    if (hasBlockGrid) activeModules.push('block_grid');

    interface RawRegion {
      region_id: string;
      row: number;
      col: number;
      x: number;
      y: number;
      width: number;
      height: number;
      mean_luminance: number;
      std_luminance: number;
      min_luminance: number;
      max_luminance: number;
      mean_gradient: number;
      std_gradient: number;
      edge_density: number;
      noise_residual_std: number | null;
      noise_mean_abs: number | null;
      ela_mean: number | null;
      ela_variance: number | null;
      regional_fft_high_freq_ratio: number | null;
      [key: string]: string | number | null;
    }

    const rawRegions: RawRegion[] = [];

    for (const tile of tiles) {
      const tw = tile.x2 - tile.x1;
      const th = tile.y2 - tile.y1;
      const count = tw * th;

      let meanLum = 0;
      let stdLum = 0;
      let minLum = 0;
      let maxLum = 0;
      let meanGrad = 0;
      let stdGrad = 0;
      let edgeDens = 0;
      let fftRatio: number | null = null;

      if (count > 0) {
        let sumLum = 0;
        let sqLum = 0;
        let sumGrad = 0;
        let sqGrad = 0;
        let edgeCount = 0;
        minLum = Infinity;
        maxLum = -Infinity;

        for (let y = tile.y1; y < tile.y2; y += 1) {
          const rowOff = y * width;
          for (let x = tile.x1; x < tile.x2; x += 1) {
            const idx = rowOff + x;
            const lv = lumArr[idx];
            const gv = gradMag[idx];
            sumLum += lv;
            sqLum += lv * lv;
            if (lv < minLum) minLum = lv;
            if (lv > maxLum) maxLum = lv;

            sumGrad += gv;
            sqGrad += gv * gv;
            if (gv >= edgeThreshold) edgeCount += 1;
          }
        }

        meanLum = sumLum / count;
        stdLum = Math.sqrt(Math.max(0, sqLum / count - meanLum * meanLum));
        meanGrad = sumGrad / count;
        stdGrad = Math.sqrt(Math.max(0, sqGrad / count - meanGrad * meanGrad));
        edgeDens = (edgeCount / count) * 100;

        if (hasRegionalFft) {
          fftRatio = computeRegionalFftHighFreqRatio(lumArr, width, tile.x1, tile.y1, tw, th);
        }
      }

      const nm = noiseById.get(tile.regionId);
      const em = elaById.get(tile.regionId);

      rawRegions.push({
        region_id: tile.regionId,
        row: tile.row,
        col: tile.col,
        x: tile.x1,
        y: tile.y1,
        width: tw,
        height: th,
        mean_luminance: meanLum,
        std_luminance: stdLum,
        min_luminance: minLum === Infinity ? 0 : minLum,
        max_luminance: maxLum === -Infinity ? 0 : maxLum,
        mean_gradient: meanGrad,
        std_gradient: stdGrad,
        edge_density: edgeDens,
        noise_residual_std: nm ? nm.std : null,
        noise_mean_abs: nm ? nm.mean_difference : null,
        ela_mean: em ? em.mean_difference : null,
        ela_variance: em ? em.variance : null,
        regional_fft_high_freq_ratio: fftRatio,
      });
    }

    const candidateFeatures = ['std_luminance', 'mean_gradient', 'std_gradient', 'edge_density'];
    if (hasNoise) candidateFeatures.push('noise_residual_std', 'noise_mean_abs');
    if (hasEla) candidateFeatures.push('ela_mean', 'ela_variance');
    if (hasRegionalFft) candidateFeatures.push('regional_fft_high_freq_ratio');

    const activeFeatures = candidateFeatures.filter((feat) =>
      rawRegions.every((reg) => reg[feat] !== null && reg[feat] !== undefined),
    );

    const featureScales = new Map<string, [number, number]>();
    for (const feat of activeFeatures) {
      const vals = rawRegions.map((reg) => Number(reg[feat]));
      const med = median(vals);
      const mad = median(vals.map((v) => Math.abs(v - med)));
      let scale: number;
      if (mad > 1e-6) {
        scale = 1.4826 * mad;
      } else {
        const s = stdDev(vals);
        scale = s > 1e-6 ? s : 1.0;
      }
      featureScales.set(feat, [med, scale]);
    }

    const medNoiseStd = featureScales.get('noise_residual_std')?.[0] ?? 0;
    const medElaMean = featureScales.get('ela_mean')?.[0] ?? 0;

    const gridMap = new Map<string, RawRegion>();
    for (const reg of rawRegions) {
      gridMap.set(`${reg.row},${reg.col}`, reg);
    }

    const regionalItems: RegionalAnomalyItem[] = [];
    const deviationScores: number[] = [];

    for (const reg of rawRegions) {
      const zDict: Record<string, number> = {};
      const zList: number[] = [];

      for (const feat of activeFeatures) {
        const val = Number(reg[feat]);
        const [med, scale] = featureScales.get(feat)!;
        const allSame = rawRegions.every((r0) => Math.abs(Number(r0[feat]) - val) <= 1e-8);
        const z = scale <= 1e-6 || allSame ? 0 : Math.abs(val - med) / scale;
        zDict[feat] = round(z, 4);
        zList.push(z);
      }

      const compScore = zList.length ? zList.reduce((a, b) => a + b, 0) / zList.length : 0;
      deviationScores.push(compScore);

      const neighborDiffs: number[] = [];
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nReg = gridMap.get(`${reg.row + dr},${reg.col + dc}`);
        if (!nReg) continue;
        const featDiffs: number[] = [];
        for (const f of activeFeatures) {
          const scale = featureScales.get(f)![1];
          if (scale > 1e-6) {
            featDiffs.push(Math.abs(Number(reg[f]) - Number(nReg[f])) / scale);
          }
        }
        if (featDiffs.length) {
          neighborDiffs.push(featDiffs.reduce((a, b) => a + b, 0) / featDiffs.length);
        }
      }

      const neighborDev = neighborDiffs.length
        ? neighborDiffs.reduce((a, b) => a + b, 0) / neighborDiffs.length
        : 0;

      const familyZScores: Record<string, number> = {};
      if (zDict.std_luminance !== undefined) {
        familyZScores.luminance_structure = round(zDict.std_luminance, 4);
      }
      const edgeKeys = ['mean_gradient', 'std_gradient', 'edge_density'].filter(
        (k) => zDict[k] !== undefined,
      );
      if (edgeKeys.length > 0) {
        const edgeMean = edgeKeys.reduce((acc, k) => acc + zDict[k], 0) / edgeKeys.length;
        familyZScores.edge_texture = round(edgeMean, 4);
      }
      const noiseKeys = ['noise_residual_std', 'noise_mean_abs'].filter(
        (k) => zDict[k] !== undefined,
      );
      if (noiseKeys.length > 0) {
        const noiseMean = noiseKeys.reduce((acc, k) => acc + zDict[k], 0) / noiseKeys.length;
        familyZScores.noise_residual = round(noiseMean, 4);
      }
      const elaKeys = ['ela_mean', 'ela_variance'].filter((k) => zDict[k] !== undefined);
      if (elaKeys.length > 0) {
        const elaMean = elaKeys.reduce((acc, k) => acc + zDict[k], 0) / elaKeys.length;
        familyZScores.compression_ela = round(elaMean, 4);
      }
      if (zDict.regional_fft_high_freq_ratio !== undefined) {
        familyZScores.frequency_spectrum = round(zDict.regional_fft_high_freq_ratio, 4);
      }
      const bgInfo = blockGridById.get(reg.region_id);
      if (bgInfo !== undefined) {
        familyZScores.block_grid = round(bgInfo.z, 4);
      }

      const forensicFamilies = [
        'noise_residual',
        'compression_ela',
        'frequency_spectrum',
        'block_grid',
      ] as const;
      const corroboratingFamiliesCount = forensicFamilies.filter(
        (fam) => (familyZScores[fam] ?? 0) >= 1.5,
      ).length;

      const edgeZ = familyZScores.edge_texture ?? 0;
      const noisePhysicalDelta =
        reg.noise_residual_std !== null ? reg.noise_residual_std - medNoiseStd : 0;
      const elaPhysicalDelta = reg.ela_mean !== null ? reg.ela_mean - medElaMean : 0;
      const blockIsNonZeroOffset =
        bgInfo !== undefined &&
        (bgInfo.dominantOffset[0] !== 0 || bgInfo.dominantOffset[1] !== 0) &&
        bgInfo.alignedVsShiftedRatio < 0.88;
      const blockPhysicalElevated =
        bgInfo !== undefined &&
        ((decoded.format !== 'JPEG' && bgInfo.alignedRatio >= 1.12) || blockIsNonZeroOffset);

      const elaSurprise =
        (familyZScores.compression_ela ?? 0) >= 1.8 && elaPhysicalDelta >= 1.2;
      const noiseSurprise =
        (familyZScores.noise_residual ?? 0) >= 1.8 && noisePhysicalDelta >= 0.5;
      const blockSurprise = (familyZScores.block_grid ?? 0) >= 2.0 && blockPhysicalElevated;

      const flatRegionSurprise =
        edgeZ < 1.0 && (elaSurprise || noiseSurprise || blockSurprise);

      regionalItems.push({
        region_id: reg.region_id,
        row: reg.row,
        col: reg.col,
        x: reg.x,
        y: reg.y,
        width: reg.width,
        height: reg.height,
        mean_luminance: round(reg.mean_luminance, 4),
        std_luminance: round(reg.std_luminance, 4),
        min_luminance: round(reg.min_luminance, 4),
        max_luminance: round(reg.max_luminance, 4),
        mean_gradient: round(reg.mean_gradient, 4),
        std_gradient: round(reg.std_gradient, 4),
        edge_density: round(reg.edge_density, 2),
        noise_residual_std:
          reg.noise_residual_std !== null ? round(reg.noise_residual_std, 4) : null,
        noise_mean_abs: reg.noise_mean_abs !== null ? round(reg.noise_mean_abs, 4) : null,
        ela_mean: reg.ela_mean !== null ? round(reg.ela_mean, 4) : null,
        ela_variance: reg.ela_variance !== null ? round(reg.ela_variance, 4) : null,
        regional_fft_high_freq_ratio:
          reg.regional_fft_high_freq_ratio !== null
            ? round(reg.regional_fft_high_freq_ratio, 4)
            : null,
        deviation_score: round(compScore, 4),
        neighbor_deviation: round(neighborDev, 4),
        z_scores: zDict,
        observation: formatNeutralObservation(compScore, zDict),
        family_z_scores: familyZScores,
        corroborating_families_count: corroboratingFamiliesCount,
        flat_region_surprise: flatRegionSurprise,
      });
    }

    const maxDev = deviationScores.length ? Math.max(...deviationScores) : 0;
    const minDev = deviationScores.length ? Math.min(...deviationScores) : 0;
    const meanDev = deviationScores.length
      ? deviationScores.reduce((a, b) => a + b, 0) / deviationScores.length
      : 0;
    const stdDevScore = stdDev(deviationScores);

    let highestRegionId: string | null = null;
    if (deviationScores.length) {
      let maxIdx = 0;
      for (let i = 1; i < deviationScores.length; i += 1) {
        if (deviationScores[i] > deviationScores[maxIdx]) maxIdx = i;
      }
      highestRegionId = regionalItems[maxIdx].region_id;
    }

    const regionalSummary: Record<string, number> = {
      max_deviation_score: round(maxDev, 4),
      mean_deviation_score: round(meanDev, 4),
      min_deviation_score: round(minDev, 4),
      std_deviation_score: round(stdDevScore, 4),
    };

    const regionGridScores = normalizeGridScores(
      regionalItems.map((item) => ({
        region_id: item.region_id,
        row: item.row,
        col: item.col,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        raw_value: item.deviation_score,
      })),
    );

    const visUrl = includeVisualization
      ? await generateVisualizationDataUrl(decoded, regionalItems, maxDev)
      : null;

    const flatSurpriseRegions = regionalItems
      .filter((item) => item.flat_region_surprise)
      .map((item) => item.region_id);

    const observations = [
      `Partitioned image into ${totalRegions} regions (${rows}x${cols} grid).`,
      `Analyzed ${activeFeatures.length} features across active modules: ${activeModules.join(', ')}.`,
      `Mean regional deviation score: ${meanDev.toFixed(2)}; peak deviation score: ${maxDev.toFixed(2)}.`,
    ];

    if (highestRegionId && maxDev >= 1.5) {
      observations.push(
        `Region ${highestRegionId} exhibited the highest relative statistical variation (${maxDev.toFixed(2)}) across measured properties.`,
      );
    } else if (maxDev < 1.0) {
      observations.push('Regional characteristics are homogeneous across the entire image.');
    }

    if (flatSurpriseRegions.length > 0) {
      observations.push(
        `Flat-region forensic contrast noted in ${flatSurpriseRegions.join(', ')} (elevated forensic signal without proportional edge/texture density).`,
      );
    }

    const limitations = [
      'Regional differences reflect spatial contrast, illumination, and scene texture; they do not establish image manipulation.',
      'Regional deviation scores measure statistical dispersion from image-wide medians, not authenticity or forgery probabilities.',
    ];
    if (!hasEla) {
      limitations.push(
        'ELA regional metrics were not included because ELA is JPEG-specific and unavailable for this format.',
      );
    }
    if (!hasRegionalFft) {
      limitations.push(
        `Regional frequency analysis was omitted because tile dimensions (${Math.floor(width / cols)}x${Math.floor(height / rows)}) are below the ${MIN_FFT_REGION_DIM}x${MIN_FFT_REGION_DIM} resolution threshold.`,
      );
    }

    const methodInfo: MethodDocumentation = {
      what_it_measures:
        'Computes per-tile luminance, gradient/edge density, noise residuals, ELA, 2D FFT high-frequency energy, and 8x8 block-grid signals grouped by independent feature families.',
      assumptions: [
        'Uniformly captured scenes share statistical regularity across spatial tiles after separating edge density from flat-region signals.',
      ],
      limitations,
      parameters: {
        grid: `${rows}x${cols}`,
        edge_threshold: edgeThreshold,
        min_fft_region_dim: MIN_FFT_REGION_DIM,
      },
    };

    const details: RegionalAnomalyDetails = {
      grid_rows: rows,
      grid_cols: cols,
      total_regions: totalRegions,
      analyzed_features: activeFeatures,
      active_modules_used: activeModules,
      max_deviation_score: round(maxDev, 4),
      mean_deviation_score: round(meanDev, 4),
      highest_deviation_region_id: highestRegionId,
      regional_anomalies: regionalItems,
      regional_summary: regionalSummary,
      visualization_data_url: visUrl,
      region_grid_scores: regionGridScores,
      method_info: methodInfo,
    };

    return {
      name: 'regional',
      status: 'completed',
      observations,
      metrics: {
        grid_rows: details.grid_rows,
        grid_cols: details.grid_cols,
        total_regions: details.total_regions,
        analyzed_feature_count: activeFeatures.length,
        max_deviation_score: details.max_deviation_score,
        mean_deviation_score: details.mean_deviation_score,
        highest_deviation_region_id: details.highest_deviation_region_id,
        flat_surprise_count: flatSurpriseRegions.length,
      },
      limitations,
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'regional',
      status: 'failed',
      observations: [],
      limitations: [`Regional anomaly analysis failed: ${msg}`],
      metrics: {},
      details: null,
    };
  }
}
