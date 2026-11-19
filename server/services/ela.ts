import sharp from 'sharp';
import type {
  AnalysisItem,
  ELADetails,
  ELAMultiQualityPoint,
  MethodDocumentation,
  RegionalMetric,
} from '../types.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import { normalizeGridScores } from './gridNormalization.ts';

const DEFAULT_ELA_QUALITY = 90;
const MULTI_QUALITY_LEVELS = [95, 90, 80, 70] as const;
const DEFAULT_THRESHOLDS = [5, 10, 15, 20, 30, 50] as const;
const MAX_VISUALIZATION_DIMENSION = 1200;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function percentileFromUint8Histogram(hist: Uint32Array, totalCount: number, q: number): number {
  if (totalCount === 0) return 0;
  const target = (q / 100) * (totalCount - 1);
  const lowerIdx = Math.floor(target);
  const upperIdx = Math.ceil(target);
  const frac = target - lowerIdx;

  let cumulative = 0;
  let lowerVal = 0;
  let upperVal = 0;
  let foundLower = false;

  for (let v = 0; v < 256; v += 1) {
    cumulative += hist[v];
    if (!foundLower && cumulative > lowerIdx) {
      lowerVal = v;
      foundLower = true;
    }
    if (cumulative > upperIdx) {
      upperVal = v;
      break;
    }
  }
  return lowerVal + (upperVal - lowerVal) * frac;
}

function elaLimitations(quality = DEFAULT_ELA_QUALITY): string[] {
  return [
    'Error Level Analysis indicates compression error relative to a recompression baseline, not absolute authenticity.',
    'High-frequency content, textures, and edges naturally produce higher error levels under JPEG quantization.',
    'Multiple re-saves, resamplings, and varying JPEG quantization tables alter error patterns non-linearly.',
    'Uniform error levels do not guarantee absence of manipulation, nor do localized error variations prove forgery.',
    `Results depend on the selected baseline recompression quality (evaluated at quality ${quality}).`,
  ];
}

function interpretEla(details: ELADetails): string[] {
  const observations: string[] = [
    `JPEG Error Level Analysis evaluated with recompression quality ${details.recompression_quality}.`,
    `Global mean absolute difference is ${details.mean_difference.toFixed(2)} on a 0–255 scale (maximum observed: ${Math.trunc(details.max_difference)}).`,
    `Median difference is ${details.median_difference.toFixed(2)}; 95th percentile is ${details.p95_difference.toFixed(2)}, and 99th percentile is ${details.p99_difference.toFixed(2)}.`,
  ];

  const above10 = details.threshold_percentages.above_10 ?? 0;
  const above20 = details.threshold_percentages.above_20 ?? 0;
  observations.push(
    `${above10.toFixed(1)}% of pixels exceed an error threshold of 10, and ${above20.toFixed(1)}% exceed a threshold of 20.`,
  );

  const spread = details.regional_summary.mean_spread ?? 0;
  const meanMin = details.regional_summary.mean_min ?? 0;
  const meanMax = details.regional_summary.mean_max ?? 0;

  if (spread < 3.0) {
    observations.push(
      `Error level is relatively uniform across spatial regions (regional mean spread: ${spread.toFixed(2)}, range ${meanMin.toFixed(2)}–${meanMax.toFixed(2)}).`,
    );
  } else {
    observations.push(
      `Spatial variations in error levels observed across image regions (regional mean range: ${meanMin.toFixed(2)} to ${meanMax.toFixed(2)}, spread: ${spread.toFixed(2)}). This can reflect varying edge density, texture detail, or differing compression histories.`,
    );
  }

  const elevatedRegions = (details.region_grid_scores ?? [])
    .filter((r) => r.flag_level === 'elevated')
    .map((r) => `${r.region_id} (z=${r.robust_z.toFixed(2)})`);
  if (elevatedRegions.length > 0) {
    observations.push(
      `Elevated normalized ELA regions relative to grid median: ${elevatedRegions.join(', ')}.`,
    );
  }

  observations.push(
    'Higher error levels naturally concentrate along sharp edges, detailed textures, and high-frequency content due to DCT quantization.',
  );
  observations.push(
    'Error Level Analysis provides relative compression error metrics; it does not compute authenticity scores or determine whether an image is real or fake.',
  );
  return observations;
}

async function generateVisualizationDataUrl(
  diffArr: Uint8Array,
  width: number,
  height: number,
  scaleFactor: number,
): Promise<string> {
  const scaled = new Uint8Array(diffArr.length);
  for (let i = 0; i < diffArr.length; i += 1) {
    const val = Math.round(diffArr[i] * scaleFactor);
    scaled[i] = val > 255 ? 255 : val < 0 ? 0 : val;
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

async function computeQuickElaPoint(
  origBuf: Buffer,
  rgbPixels: Uint8Array,
  width: number,
  height: number,
  tiles: ReturnType<typeof partitionGrid>,
  quality: number,
): Promise<ELAMultiQualityPoint> {
  const recompJpeg = await sharp(origBuf, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
  const recomp = await sharp(recompJpeg).removeAlpha().toColorspace('srgb').raw().toBuffer();
  const totalValues = width * height * 3;
  let sumAll = 0;
  for (let i = 0; i < totalValues; i += 1) {
    sumAll += Math.abs(rgbPixels[i] - recomp[i]);
  }
  const tileMeans: number[] = [];
  for (const tile of tiles) {
    const count = (tile.x2 - tile.x1) * (tile.y2 - tile.y1) * 3;
    if (count <= 0) continue;
    let bSum = 0;
    for (let y = tile.y1; y < tile.y2; y += 1) {
      const rowStart = (y * width + tile.x1) * 3;
      const rowEnd = (y * width + tile.x2) * 3;
      for (let i = rowStart; i < rowEnd; i += 1) {
        bSum += Math.abs(rgbPixels[i] - recomp[i]);
      }
    }
    tileMeans.push(bSum / count);
  }
  const meanDiff = totalValues > 0 ? sumAll / totalValues : 0;
  const spread = tileMeans.length ? Math.max(...tileMeans) - Math.min(...tileMeans) : 0;
  return {
    quality,
    mean_difference: round(meanDiff, 4),
    regional_mean_spread: round(spread, 4),
  };
}

export async function buildElaAnalysis(
  decoded: DecodedImage,
  options: {
    quality?: number;
    gridRows?: number;
    gridCols?: number;
    includeVisualization?: boolean;
  } = {},
): Promise<AnalysisItem> {
  const quality = options.quality ?? DEFAULT_ELA_QUALITY;
  const gridRows = options.gridRows ?? 4;
  const gridCols = options.gridCols ?? 4;
  const includeVisualization = options.includeVisualization ?? true;

  if (decoded.format !== 'JPEG') {
    return {
      name: 'ela',
      status: 'unavailable',
      observations: [
        `Error Level Analysis was skipped: image format '${decoded.format}' is not JPEG.`,
      ],
      metrics: {},
      limitations: [
        'Error Level Analysis is specifically designed for JPEG lossy compression artifacts.',
        'Lossless formats (such as PNG) or alternative compression schemes (such as WEBP) do not exhibit standard JPEG discrete cosine transform (DCT) quantization error levels.',
      ],
      details: null,
    };
  }

  try {
    const { width, height, rgbPixels } = decoded;
    const origBuf = Buffer.from(rgbPixels.buffer, rgbPixels.byteOffset, rgbPixels.byteLength);

    const recompJpeg = await sharp(origBuf, {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality })
      .toBuffer();

    const recompDecoded = await sharp(recompJpeg)
      .removeAlpha()
      .toColorspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (recompDecoded.info.width !== width || recompDecoded.info.height !== height) {
      throw new Error(
        `Image dimension mismatch after recompression: ${width}x${height} vs ${recompDecoded.info.width}x${recompDecoded.info.height}`,
      );
    }

    const recompPixels = recompDecoded.data;
    const totalPixels = width * height;
    const totalValues = totalPixels * 3;
    const diffArr = new Uint8Array(totalValues);

    const hist = new Uint32Array(256);
    let sumAll = 0;
    let maxDiff = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;

    const thresholdCounts = new Uint32Array(DEFAULT_THRESHOLDS.length);

    for (let p = 0; p < totalPixels; p += 1) {
      const idx = p * 3;
      const dr = Math.abs(rgbPixels[idx] - recompPixels[idx]);
      const dg = Math.abs(rgbPixels[idx + 1] - recompPixels[idx + 1]);
      const db = Math.abs(rgbPixels[idx + 2] - recompPixels[idx + 2]);

      diffArr[idx] = dr;
      diffArr[idx + 1] = dg;
      diffArr[idx + 2] = db;

      hist[dr] += 1;
      hist[dg] += 1;
      hist[db] += 1;

      sumAll += dr + dg + db;
      sumR += dr;
      sumG += dg;
      sumB += db;

      if (dr > maxR) maxR = dr;
      if (dg > maxG) maxG = dg;
      if (db > maxB) maxB = db;

      const pixelMax = Math.max(dr, dg, db);
      if (pixelMax > maxDiff) maxDiff = pixelMax;

      for (let t = 0; t < DEFAULT_THRESHOLDS.length; t += 1) {
        if (pixelMax >= DEFAULT_THRESHOLDS[t]) {
          thresholdCounts[t] += 1;
        }
      }
    }

    const meanDiff = totalValues > 0 ? sumAll / totalValues : 0;
    const medianDiff = percentileFromUint8Histogram(hist, totalValues, 50);
    const p95Diff = percentileFromUint8Histogram(hist, totalValues, 95);
    const p99Diff = percentileFromUint8Histogram(hist, totalValues, 99);

    const channelMeans = {
      red: round(totalPixels > 0 ? sumR / totalPixels : 0, 4),
      green: round(totalPixels > 0 ? sumG / totalPixels : 0, 4),
      blue: round(totalPixels > 0 ? sumB / totalPixels : 0, 4),
    };
    const channelMaxes = {
      red: round(maxR, 4),
      green: round(maxG, 4),
      blue: round(maxB, 4),
    };

    const thresholdPercentages: Record<string, number> = {};
    for (let t = 0; t < DEFAULT_THRESHOLDS.length; t += 1) {
      const pct = totalPixels > 0 ? round((thresholdCounts[t] / totalPixels) * 100, 2) : 0;
      thresholdPercentages[`above_${DEFAULT_THRESHOLDS[t]}`] = pct;
    }

    const tiles = partitionGrid(width, height, gridRows, gridCols);
    const regionalMetrics: RegionalMetric[] = [];
    const regionalMeans: number[] = [];
    const regionalVariances: number[] = [];

    for (const tile of tiles) {
      const tw = tile.x2 - tile.x1;
      const th = tile.y2 - tile.y1;
      const count = tw * th * 3;
      if (count <= 0) continue;

      let bSum = 0;
      let bSqSum = 0;
      let bMax = 0;

      for (let y = tile.y1; y < tile.y2; y += 1) {
        const rowStart = (y * width + tile.x1) * 3;
        const rowEnd = (y * width + tile.x2) * 3;
        for (let i = rowStart; i < rowEnd; i += 1) {
          const val = diffArr[i];
          bSum += val;
          bSqSum += val * val;
          if (val > bMax) bMax = val;
        }
      }

      const bMean = bSum / count;
      const bVar = Math.max(0, bSqSum / count - bMean * bMean);
      regionalMeans.push(bMean);
      regionalVariances.push(bVar);

      regionalMetrics.push({
        region_id: tile.regionId,
        row: tile.row,
        col: tile.col,
        x: tile.x1,
        y: tile.y1,
        width: tw,
        height: th,
        mean_difference: round(bMean, 4),
        variance: round(bVar, 4),
        max_difference: round(bMax, 4),
      });
    }

    const minMean = regionalMeans.length ? Math.min(...regionalMeans) : 0;
    const maxMean = regionalMeans.length ? Math.max(...regionalMeans) : 0;
    const minVar = regionalVariances.length ? Math.min(...regionalVariances) : 0;
    const maxVar = regionalVariances.length ? Math.max(...regionalVariances) : 0;
    const meanVar = regionalVariances.length
      ? regionalVariances.reduce((acc, v) => acc + v, 0) / regionalVariances.length
      : 0;

    const regionalSummary: Record<string, number> = {
      mean_min: round(minMean, 4),
      mean_max: round(maxMean, 4),
      mean_spread: round(maxMean - minMean, 4),
      variance_min: round(minVar, 4),
      variance_max: round(maxVar, 4),
      variance_mean: round(meanVar, 4),
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
        raw_value: rm.mean_difference,
      })),
    );

    const multiQualityCurve: ELAMultiQualityPoint[] = [];
    if (Math.max(width, height) <= 1536) {
      for (const q of MULTI_QUALITY_LEVELS) {
        if (q === quality) {
          multiQualityCurve.push({
            quality: q,
            mean_difference: round(meanDiff, 4),
            regional_mean_spread: regionalSummary.mean_spread,
          });
        } else {
          multiQualityCurve.push(
            await computeQuickElaPoint(origBuf, rgbPixels, width, height, tiles, q),
          );
        }
      }
    } else {
      // Preserve exact 8x8 JPEG DCT alignment via a multiple-of-8 central window
      const cw = Math.min(width, 1024) & ~7;
      const ch = Math.min(height, 1024) & ~7;
      const x0 = Math.floor((width - cw) / 16) * 8;
      const y0 = Math.floor((height - ch) / 16) * 8;
      const cropBuf = Buffer.allocUnsafe(cw * ch * 3);
      for (let y = 0; y < ch; y += 1) {
        const srcStart = ((y0 + y) * width + x0) * 3;
        origBuf.copy(cropBuf, y * cw * 3, srcStart, srcStart + cw * 3);
      }
      const cropPixels = new Uint8Array(cropBuf.buffer, cropBuf.byteOffset, cropBuf.byteLength);
      const cropTiles = partitionGrid(cw, ch, gridRows, gridCols);
      for (const q of MULTI_QUALITY_LEVELS) {
        multiQualityCurve.push(
          await computeQuickElaPoint(cropBuf, cropPixels, cw, ch, cropTiles, q),
        );
      }
    }

    const effectiveScale = maxDiff > 0 ? round(255.0 / maxDiff, 2) : 1.0;
    const dataUrl = includeVisualization
      ? await generateVisualizationDataUrl(diffArr, width, height, effectiveScale)
      : null;

    const methodInfo: MethodDocumentation = {
      what_it_measures:
        'Measures pixel-wise RGB absolute difference after recompressing JPEG imagery at a fixed baseline quality and tracks error variation across an NxN grid and multi-quality sweep.',
      assumptions: [
        'Input is a JPEG image whose pixels reflect prior 8x8 DCT quantization.',
        'Uniformly compressed regions respond similarly to re-encoding unless texture or prior quantization differs.',
      ],
      limitations: elaLimitations(quality),
      parameters: {
        recompression_quality: quality,
        multi_quality_levels: MULTI_QUALITY_LEVELS.join(','),
        grid: `${gridRows}x${gridCols}`,
      },
    };

    const details: ELADetails = {
      recompression_quality: quality,
      scale_factor: effectiveScale,
      mean_difference: round(meanDiff, 4),
      median_difference: round(medianDiff, 4),
      max_difference: round(maxDiff, 4),
      p95_difference: round(p95Diff, 4),
      p99_difference: round(p99Diff, 4),
      threshold_percentages: thresholdPercentages,
      channel_means: channelMeans,
      channel_maxes: channelMaxes,
      regional_metrics: regionalMetrics,
      regional_summary: regionalSummary,
      difference_image_data_url: dataUrl,
      multi_quality_curve: multiQualityCurve,
      region_grid_scores: regionGridScores,
      method_info: methodInfo,
    };

    const observations = interpretEla(details);
    if (decoded.isUniformContent) {
      observations.push(
        'Input luminance contrast is near-uniform; ELA error differences are too small to support spatial interpretation.',
      );
    }

    return {
      name: 'ela',
      status: 'completed',
      observations,
      metrics: {
        recompression_quality: details.recompression_quality,
        scale_factor: details.scale_factor,
        mean_difference: details.mean_difference,
        median_difference: details.median_difference,
        max_difference: details.max_difference,
        p95_difference: details.p95_difference,
        p99_difference: details.p99_difference,
        pixels_above_threshold_5_pct: thresholdPercentages.above_5 ?? 0,
        pixels_above_threshold_10_pct: thresholdPercentages.above_10 ?? 0,
        pixels_above_threshold_20_pct: thresholdPercentages.above_20 ?? 0,
        pixels_above_threshold_50_pct: thresholdPercentages.above_50 ?? 0,
        regional_mean_min: regionalSummary.mean_min,
        regional_mean_max: regionalSummary.mean_max,
        regional_mean_spread: regionalSummary.mean_spread,
        regional_variance_mean: regionalSummary.variance_mean,
        regional_variance_max: regionalSummary.variance_max,
      },
      limitations: elaLimitations(quality),
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'ela',
      status: 'failed',
      observations: [`Error Level Analysis could not be computed: ${msg}`],
      metrics: {},
      limitations: elaLimitations(quality),
      details: null,
    };
  }
}
