import sharp from 'sharp';
import type {
  AnalysisItem,
  MethodDocumentation,
  NoiseDetails,
  RegionalNoiseMetric,
} from '../types.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import { normalizeGridScores } from './gridNormalization.ts';

const DEFAULT_SMOOTHING_SIGMA = 1.0;
const MAX_VISUALIZATION_DIMENSION = 1200;
const FLAT_GRADIENT_THRESHOLD = 10.0;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function percentileFromFloat32(values: Float32Array, q: number): number {
  const len = values.length;
  if (len === 0) return 0;
  if (len <= 1_000_000) {
    const sorted = new Float32Array(values);
    sorted.sort();
    const idx = (q / 100) * (len - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  const bins = 25500;
  const hist = new Uint32Array(bins + 1);
  for (let i = 0; i < len; i += 1) {
    const rawBin = (values[i] * 100 + 0.5) | 0;
    const b = rawBin > bins ? bins : rawBin < 0 ? 0 : rawBin;
    hist[b] += 1;
  }
  const target = (q / 100) * (len - 1);
  let cum = 0;
  for (let b = 0; b <= bins; b += 1) {
    cum += hist[b];
    if (cum > target) return b / 100;
  }
  return 255;
}

function noiseLimitations(sigma = DEFAULT_SMOOTHING_SIGMA): string[] {
  return [
    'Noise residual patterns are heavily influenced by high-frequency image content, sharp edges, and detailed textures.',
    'Image processing operations such as JPEG compression, downsampling, sharpening, and denoising alter noise residual distributions.',
    'Uniform or non-uniform noise residuals do not establish whether an image is authentic, edited, or synthetic.',
    `Residual analysis depends on the chosen filtering model and smoothing parameter (sigma=${sigma}).`,
    'Sensor noise characteristics vary widely across camera models, ISO settings, and lighting conditions.',
  ];
}

function interpretNoise(details: NoiseDetails): string[] {
  const observations: string[] = [
    `Noise residual analysis evaluated using Gaussian low-pass filter (sigma=${details.smoothing_sigma.toFixed(2)}).`,
    `Global mean absolute residual is ${details.mean_absolute_residual.toFixed(2)} on a 0–255 scale (residual standard deviation: ${details.residual_std.toFixed(2)}, signed mean: ${details.residual_mean.toFixed(2)}).`,
    `Median absolute residual is ${details.median_absolute_residual.toFixed(2)}; 95th percentile is ${details.p95_absolute_residual.toFixed(2)}, and 99th percentile is ${details.p99_absolute_residual.toFixed(2)} (peak observed: ${details.max_absolute_residual.toFixed(2)}).`,
  ];

  if (
    typeof details.flat_pixel_residual_std === 'number' &&
    typeof details.edge_pixel_residual_std === 'number'
  ) {
    observations.push(
      `Gradient-separated noise floor: low-gradient flat-pixel residual std is ${details.flat_pixel_residual_std.toFixed(2)} vs edge-pixel residual std ${details.edge_pixel_residual_std.toFixed(2)}.`,
    );
  }

  const spread = details.regional_summary.mean_spread ?? 0;
  const meanMin = details.regional_summary.mean_min ?? 0;
  const meanMax = details.regional_summary.mean_max ?? 0;

  if (spread < 3.0) {
    observations.push(
      `Residual intensity is relatively uniform across spatial regions (regional mean range: ${meanMin.toFixed(2)}–${meanMax.toFixed(2)}, spread: ${spread.toFixed(2)}).`,
    );
  } else {
    observations.push(
      `Residual intensity varies across spatial regions (regional mean range: ${meanMin.toFixed(2)} to ${meanMax.toFixed(2)}, spread: ${spread.toFixed(2)}). This can reflect varying edge density, texture detail, or localized processing.`,
    );
  }

  const elevatedRegions = (details.region_grid_scores ?? [])
    .filter((r) => r.flag_level === 'elevated')
    .map((r) => `${r.region_id} (z=${r.robust_z.toFixed(2)})`);
  if (elevatedRegions.length > 0) {
    observations.push(
      `Elevated normalized noise residual regions relative to grid median: ${elevatedRegions.join(', ')}.`,
    );
  }

  observations.push(
    'Higher residual magnitudes naturally concentrate along edges, textures, and high-frequency structures where the low-pass filter suppresses sharp transitions.',
  );
  observations.push(
    'Noise residual analysis examines high-frequency deviations from a low-pass baseline; it does not classify an image as real or fake, and cannot prove manipulation or AI generation.',
  );
  return observations;
}

async function generateVisualizationDataUrl(
  absResidual: Float32Array,
  maxVal: number,
  width: number,
  height: number,
): Promise<string> {
  const scale = maxVal > 0 ? 255.0 / maxVal : 1.0;
  const scaled = new Uint8Array(absResidual.length);
  for (let i = 0; i < absResidual.length; i += 1) {
    const v = Math.round(absResidual[i] * scale);
    scaled[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }

  let pipeline = sharp(Buffer.from(scaled.buffer, scaled.byteOffset, scaled.byteLength), {
    raw: { width, height, channels: 3 },
  });

  if (Math.max(width, height) > MAX_VISUALIZATION_DIMENSION) {
    pipeline = pipeline.resize({
      width: MAX_VISUALIZATION_DIMENSION,
      height: MAX_VISUALIZATION_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const pngBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}

export async function buildNoiseAnalysis(
  decoded: DecodedImage,
  options: {
    sigma?: number;
    gridRows?: number;
    gridCols?: number;
    includeVisualization?: boolean;
  } = {},
): Promise<AnalysisItem> {
  const sigma = options.sigma ?? DEFAULT_SMOOTHING_SIGMA;
  const gridRows = options.gridRows ?? 4;
  const gridCols = options.gridCols ?? 4;
  const includeVisualization = options.includeVisualization ?? true;

  try {
    const { width, height, rgbPixels } = decoded;
    const origBuf = Buffer.from(rgbPixels.buffer, rgbPixels.byteOffset, rgbPixels.byteLength);
    const effectiveBlurSigma = Math.max(0.3, sigma);

    const smoothedBuf = await sharp(origBuf, {
      raw: { width, height, channels: 3 },
    })
      .blur(effectiveBlurSigma)
      .raw()
      .toBuffer();

    const totalPixels = width * height;
    const totalValues = totalPixels * 3;
    const residual = new Float32Array(totalValues);
    const absResidual = new Float32Array(totalValues);

    let sumRes = 0;
    let sumSqRes = 0;
    let sumAbs = 0;
    let maxAbs = 0;

    const chSumRes = [0, 0, 0];
    const chSumSqRes = [0, 0, 0];
    const chSumAbs = [0, 0, 0];

    for (let i = 0; i < totalValues; i += 1) {
      const r = rgbPixels[i] - smoothedBuf[i];
      const a = Math.abs(r);
      residual[i] = r;
      absResidual[i] = a;
      sumRes += r;
      sumSqRes += r * r;
      sumAbs += a;
      if (a > maxAbs) maxAbs = a;

      const ch = i % 3;
      chSumRes[ch] += r;
      chSumSqRes[ch] += r * r;
      chSumAbs[ch] += a;
    }

    // Compute luminance gradient mask to separate flat regions from high-contrast edges
    const lum = new Float32Array(totalPixels);
    for (let p = 0; p < totalPixels; p += 1) {
      const idx = p * 3;
      lum[p] = 0.299 * rgbPixels[idx] + 0.587 * rgbPixels[idx + 1] + 0.114 * rgbPixels[idx + 2];
    }
    const isFlatPixel = new Uint8Array(totalPixels);
    let flatSum = 0;
    let flatSq = 0;
    let flatCount = 0;
    let edgeSum = 0;
    let edgeSq = 0;
    let edgeCount = 0;

    for (let y = 0; y < height; y += 1) {
      const yPrev = y === 0 ? 0 : y - 1;
      const yNext = y === height - 1 ? height - 1 : y + 1;
      const yDen = y === 0 || y === height - 1 ? 1 : 2;
      const rowOff = y * width;
      for (let x = 0; x < width; x += 1) {
        const xPrev = x === 0 ? 0 : x - 1;
        const xNext = x === width - 1 ? width - 1 : x + 1;
        const xDen = x === 0 || x === width - 1 ? 1 : 2;
        const gx = (lum[rowOff + xNext] - lum[rowOff + xPrev]) / xDen;
        const gy = (lum[yNext * width + x] - lum[yPrev * width + x]) / yDen;
        const grad = Math.sqrt(gx * gx + gy * gy);
        const pIdx = rowOff + x;
        const base = pIdx * 3;
        const rLum = (residual[base] + residual[base + 1] + residual[base + 2]) / 3;
        if (grad < FLAT_GRADIENT_THRESHOLD) {
          isFlatPixel[pIdx] = 1;
          flatSum += rLum;
          flatSq += rLum * rLum;
          flatCount += 1;
        } else {
          edgeSum += rLum;
          edgeSq += rLum * rLum;
          edgeCount += 1;
        }
      }
    }

    const flatPixelResidualStd =
      flatCount > 0 ? Math.sqrt(Math.max(0, flatSq / flatCount - (flatSum / flatCount) ** 2)) : 0;
    const edgePixelResidualStd =
      edgeCount > 0 ? Math.sqrt(Math.max(0, edgeSq / edgeCount - (edgeSum / edgeCount) ** 2)) : 0;
    const flatToEdgeRatio =
      edgePixelResidualStd > 1e-6 ? flatPixelResidualStd / edgePixelResidualStd : 0;

    const resMean = totalValues > 0 ? sumRes / totalValues : 0;
    const resVar = totalValues > 0 ? Math.max(0, sumSqRes / totalValues - resMean * resMean) : 0;
    const resStd = Math.sqrt(resVar);
    const meanAbs = totalValues > 0 ? sumAbs / totalValues : 0;
    const medianAbs = percentileFromFloat32(absResidual, 50);
    const p95Abs = percentileFromFloat32(absResidual, 95);
    const p99Abs = percentileFromFloat32(absResidual, 99);

    const chNames = ['red', 'green', 'blue'] as const;
    const channelResidualMeans: Record<string, number> = {};
    const channelResidualStds: Record<string, number> = {};
    const channelMeanAbs: Record<string, number> = {};

    for (let c = 0; c < 3; c += 1) {
      const m = totalPixels > 0 ? chSumRes[c] / totalPixels : 0;
      const v = totalPixels > 0 ? Math.max(0, chSumSqRes[c] / totalPixels - m * m) : 0;
      channelResidualMeans[chNames[c]] = round(m, 4);
      channelResidualStds[chNames[c]] = round(Math.sqrt(v), 4);
      channelMeanAbs[chNames[c]] = round(totalPixels > 0 ? chSumAbs[c] / totalPixels : 0, 4);
    }

    const tiles = partitionGrid(width, height, gridRows, gridCols);
    const regionalMetrics: RegionalNoiseMetric[] = [];
    const regionalMeans: number[] = [];
    const regionalStds: number[] = [];

    for (const tile of tiles) {
      const tw = tile.x2 - tile.x1;
      const th = tile.y2 - tile.y1;
      const count = tw * th * 3;
      if (count <= 0) continue;

      let bAbsSum = 0;
      let bResSum = 0;
      let bResSqSum = 0;
      let bMaxAbs = 0;

      let bFlatSum = 0;
      let bFlatSq = 0;
      let bFlatCount = 0;

      for (let y = tile.y1; y < tile.y2; y += 1) {
        const rowPixelOffset = y * width;
        const rowStart = (rowPixelOffset + tile.x1) * 3;
        const rowEnd = (rowPixelOffset + tile.x2) * 3;
        for (let i = rowStart; i < rowEnd; i += 1) {
          const r = residual[i];
          const a = absResidual[i];
          bResSum += r;
          bResSqSum += r * r;
          bAbsSum += a;
          if (a > bMaxAbs) bMaxAbs = a;
        }
        for (let x = tile.x1; x < tile.x2; x += 1) {
          const pIdx = rowPixelOffset + x;
          if (isFlatPixel[pIdx]) {
            const base = pIdx * 3;
            const rLum = (residual[base] + residual[base + 1] + residual[base + 2]) / 3;
            bFlatSum += rLum;
            bFlatSq += rLum * rLum;
            bFlatCount += 1;
          }
        }
      }

      const bMeanAbs = bAbsSum / count;
      const bResMean = bResSum / count;
      const bStd = Math.sqrt(Math.max(0, bResSqSum / count - bResMean * bResMean));
      const bFlatStd =
        bFlatCount >= 16
          ? Math.sqrt(Math.max(0, bFlatSq / bFlatCount - (bFlatSum / bFlatCount) ** 2))
          : null;

      regionalMeans.push(bMeanAbs);
      regionalStds.push(bStd);

      regionalMetrics.push({
        region_id: tile.regionId,
        row: tile.row,
        col: tile.col,
        x: tile.x1,
        y: tile.y1,
        width: tw,
        height: th,
        mean_difference: round(bMeanAbs, 4),
        std: round(bStd, 4),
        max_difference: round(bMaxAbs, 4),
        flat_noise_std: bFlatStd !== null ? round(bFlatStd, 4) : null,
      });
    }

    const minMean = regionalMeans.length ? Math.min(...regionalMeans) : 0;
    const maxMean = regionalMeans.length ? Math.max(...regionalMeans) : 0;
    const minStd = regionalStds.length ? Math.min(...regionalStds) : 0;
    const maxStd = regionalStds.length ? Math.max(...regionalStds) : 0;
    const meanStd = regionalStds.length
      ? regionalStds.reduce((acc, v) => acc + v, 0) / regionalStds.length
      : 0;

    const regionalSummary: Record<string, number> = {
      mean_min: round(minMean, 4),
      mean_max: round(maxMean, 4),
      mean_spread: round(maxMean - minMean, 4),
      std_min: round(minStd, 4),
      std_max: round(maxStd, 4),
      std_mean: round(meanStd, 4),
    };

    const regionGridScores = normalizeGridScores(
      regionalMetrics.map((rm) => ({
        region_id: rm.region_id,
        row: rm.row,
        col: rm.col,
        x: rm.x,
        y: rm.y,
        width: rm.width,
        height: rm.height,
        raw_value: rm.flat_noise_std ?? rm.std,
      })),
    );

    const visUrl = includeVisualization
      ? await generateVisualizationDataUrl(absResidual, maxAbs, width, height)
      : null;

    const methodInfo: MethodDocumentation = {
      what_it_measures:
        'Measures high-frequency pixel residual relative to a Gaussian low-pass baseline globally, across an NxN grid, and separately within low-gradient flat regions vs sharp edges.',
      assumptions: [
        'Low-frequency scene illumination varies smoothly within flat image regions.',
        'Separating low-gradient pixels (grad < 10) reduces semantic edge contamination of sensor/synthetic noise variance.',
      ],
      limitations: noiseLimitations(sigma),
      parameters: {
        smoothing_sigma: sigma,
        flat_gradient_threshold: FLAT_GRADIENT_THRESHOLD,
        grid: `${gridRows}x${gridCols}`,
      },
    };

    const details: NoiseDetails = {
      smoothing_sigma: sigma,
      residual_mean: round(resMean, 4),
      residual_std: round(resStd, 4),
      mean_absolute_residual: round(meanAbs, 4),
      median_absolute_residual: round(medianAbs, 4),
      max_absolute_residual: round(maxAbs, 4),
      p95_absolute_residual: round(p95Abs, 4),
      p99_absolute_residual: round(p99Abs, 4),
      channel_residual_means: channelResidualMeans,
      channel_residual_stds: channelResidualStds,
      channel_mean_absolute_residuals: channelMeanAbs,
      regional_metrics: regionalMetrics,
      regional_summary: regionalSummary,
      visualization_data_url: visUrl,
      flat_pixel_residual_std: round(flatPixelResidualStd, 4),
      edge_pixel_residual_std: round(edgePixelResidualStd, 4),
      flat_to_edge_noise_ratio: round(flatToEdgeRatio, 4),
      region_grid_scores: regionGridScores,
      method_info: methodInfo,
    };

    const observations = interpretNoise(details);
    if (decoded.isUniformContent) {
      observations.push(
        'Input image has near-constant pixel intensity; noise residual variance is effectively zero.',
      );
    }

    return {
      name: 'noise',
      status: 'completed',
      observations,
      metrics: {
        smoothing_sigma: details.smoothing_sigma,
        residual_mean: details.residual_mean,
        residual_std: details.residual_std,
        mean_absolute_residual: details.mean_absolute_residual,
        median_absolute_residual: details.median_absolute_residual,
        max_absolute_residual: details.max_absolute_residual,
        p95_absolute_residual: details.p95_absolute_residual,
        p99_absolute_residual: details.p99_absolute_residual,
        flat_pixel_residual_std: details.flat_pixel_residual_std ?? 0,
        edge_pixel_residual_std: details.edge_pixel_residual_std ?? 0,
        flat_to_edge_noise_ratio: details.flat_to_edge_noise_ratio ?? 0,
        channel_residual_means: details.channel_residual_means,
        channel_residual_stds: details.channel_residual_stds,
        channel_mean_absolute_residuals: details.channel_mean_absolute_residuals,
        regional_mean_min: regionalSummary.mean_min,
        regional_mean_max: regionalSummary.mean_max,
        regional_mean_spread: regionalSummary.mean_spread,
        regional_std_mean: regionalSummary.std_mean,
        regional_std_max: regionalSummary.std_max,
      },
      limitations: noiseLimitations(sigma),
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'noise',
      status: 'failed',
      observations: [`Noise residual analysis could not be computed: ${msg}`],
      metrics: {},
      limitations: noiseLimitations(sigma),
      details: null,
    };
  }
}
