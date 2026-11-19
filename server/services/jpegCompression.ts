import type {
  AnalysisItem,
  ELADetails,
  MethodDocumentation,
  RecompressionDetails,
  RecompressionQuantTableSummary,
  RegionalBlockGridMetric,
} from '../../shared/contracts.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import { medianValue, normalizeGridScores } from './gridNormalization.ts';

// Standard JPEG Annex K / IJG luminance quantization table at Quality 50 (zig-zag order or natural order)
// Note: DQT marker stores values in zig-zag scan order; here we map IJG Q50 into zig-zag order for direct DQT comparison.
const IJG_LUMA_NATURAL = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const ZIGZAG_ORDER = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

const IJG_LUMA_ZIGZAG = ZIGZAG_ORDER.map((idx) => IJG_LUMA_NATURAL[idx]);

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function scaleIjgLumaTable(quality: number): number[] {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return IJG_LUMA_ZIGZAG.map((base) => {
    const val = Math.floor((base * scale + 50) / 100);
    return Math.max(1, Math.min(255, val));
  });
}

function estimateIjgQualityFromDqt(values: number[]): {
  quality: number;
  rmse: number;
  isCustom: boolean;
} {
  let bestQ = 50;
  let bestRmse = Infinity;
  for (let q = 1; q <= 100; q += 1) {
    const ref = scaleIjgLumaTable(q);
    let sqErr = 0;
    for (let i = 0; i < 64; i += 1) {
      const diff = (values[i] ?? 0) - ref[i];
      sqErr += diff * diff;
    }
    const rmse = Math.sqrt(sqErr / 64);
    if (rmse < bestRmse) {
      bestRmse = rmse;
      bestQ = q;
    }
  }
  return {
    quality: bestQ,
    rmse: round(bestRmse, 3),
    isCustom: bestRmse > 4.0,
  };
}

interface ParsedJpegTables {
  validJpeg: boolean;
  isProgressive: boolean;
  tables: Array<{ id: number; precisionBits: number; values: number[] }>;
}

function parseJpegDqtAndSof(data: Buffer): ParsedJpegTables {
  const result: ParsedJpegTables = {
    validJpeg: false,
    isProgressive: false,
    tables: [],
  };
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return result;
  }
  result.validJpeg = true;

  let offset = 2;
  while (offset + 1 < data.length) {
    // Skip any padding 0xFF bytes
    while (offset < data.length && data[offset] !== 0xff) {
      offset += 1;
    }
    while (offset < data.length && data[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= data.length) break;

    const marker = data[offset];
    offset += 1;

    // Standalone markers without length
    if (marker === 0xd9 || marker === 0xda) {
      // EOI or SOS (stop header scan before entropy stream)
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      continue;
    }

    if (offset + 2 > data.length) break;
    const segLen = data.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > data.length) break;

    const segStart = offset + 2;
    const segEnd = offset + segLen;

    if (marker === 0xc2) {
      result.isProgressive = true;
    } else if (marker === 0xdb) {
      // DQT segment can hold multiple tables
      let pos = segStart;
      while (pos < segEnd) {
        const pqTq = data[pos];
        pos += 1;
        const precision = (pqTq >> 4) & 0x0f;
        const tableId = pqTq & 0x0f;
        const bytesPerCoeff = precision === 0 ? 1 : 2;
        if (pos + 64 * bytesPerCoeff > segEnd) break;

        const values: number[] = [];
        for (let i = 0; i < 64; i += 1) {
          values.push(
            bytesPerCoeff === 1 ? data[pos + i] : data.readUInt16BE(pos + i * 2),
          );
        }
        result.tables.push({
          id: tableId,
          precisionBits: bytesPerCoeff * 8,
          values,
        });
        pos += 64 * bytesPerCoeff;
      }
    }

    offset = segEnd;
  }

  return result;
}

function computeRegionBlockiness(
  lum: Float32Array,
  imgW: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): {
  alignedRatio: number;
  maxShiftedRatio: number;
  dominantOffset: [number, number];
} {
  const horizSum = new Float64Array(8);
  const horizCount = new Uint32Array(8);
  const vertSum = new Float64Array(8);
  const vertCount = new Uint32Array(8);

  const startX = Math.max(1, x1);
  const startY = Math.max(1, y1);

  for (let y = y1; y < y2; y += 1) {
    const rowOff = y * imgW;
    for (let x = startX; x < x2; x += 1) {
      const diff = Math.abs(lum[rowOff + x] - lum[rowOff + x - 1]);
      // Exclude strong foreground object edges so a single sharp border does not mimic a shifted 8x8 JPEG grid
      if (diff > 24) continue;
      const phaseX = x & 7;
      horizSum[phaseX] += diff;
      horizCount[phaseX] += 1;
    }
  }

  for (let y = startY; y < y2; y += 1) {
    const rowOff = y * imgW;
    const prevOff = (y - 1) * imgW;
    for (let x = x1; x < x2; x += 1) {
      const diff = Math.abs(lum[rowOff + x] - lum[prevOff + x]);
      if (diff > 24) continue;
      const phaseY = y & 7;
      vertSum[phaseY] += diff;
      vertCount[phaseY] += 1;
    }
  }

  const hMeans = Array.from({ length: 8 }, (_, d) =>
    horizCount[d] > 0 ? horizSum[d] / horizCount[d] : 0,
  );
  const vMeans = Array.from({ length: 8 }, (_, d) =>
    vertCount[d] > 0 ? vertSum[d] / vertCount[d] : 0,
  );

  const hMed = medianValue(hMeans);
  const vMed = medianValue(vMeans);

  const combinedRatios = Array.from({ length: 8 }, (_, d) => {
    const hr = hMed > 0.05 ? hMeans[d] / hMed : 1.0;
    const vr = vMed > 0.05 ? vMeans[d] / vMed : 1.0;
    return 0.5 * (hr + vr);
  });

  // Also find best (dx, dy) independently
  let bestDx = 0;
  let bestHx = 0;
  let bestDy = 0;
  let bestVy = 0;
  for (let d = 0; d < 8; d += 1) {
    const hr = hMed > 0.05 ? hMeans[d] / hMed : 1.0;
    const vr = vMed > 0.05 ? vMeans[d] / vMed : 1.0;
    if (hr > bestHx) {
      bestHx = hr;
      bestDx = d;
    }
    if (vr > bestVy) {
      bestVy = vr;
      bestDy = d;
    }
  }

  const alignedRatio = combinedRatios[0];
  let maxShiftedRatio = alignedRatio;
  for (let dx = 0; dx < 8; dx += 1) {
    for (let dy = 0; dy < 8; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const hr = hMed > 0.05 ? hMeans[dx] / hMed : 1.0;
      const vr = vMed > 0.05 ? vMeans[dy] / vMed : 1.0;
      const score = 0.5 * (hr + vr);
      if (score > maxShiftedRatio) maxShiftedRatio = score;
    }
  }

  return {
    alignedRatio: round(alignedRatio, 4),
    maxShiftedRatio: round(maxShiftedRatio, 4),
    dominantOffset: [bestDx, bestDy],
  };
}

function recompressionLimitations(): string[] {
  return [
    '8x8 block-grid metrics can be masked by dense high-frequency scene textures or heavy denoising.',
    'Synthetic graphics, pixel art, or UI screenshots aligned on multiples of 8 pixels may elevate aligned block ratios even without JPEG compression.',
    'Custom quantization tables occur legitimately in camera firmware, Adobe exports, and social platform encoders; they do not prove malicious editing.',
  ];
}

export function buildRecompressionAnalysis(
  rawBytes: Buffer,
  decoded: DecodedImage,
  options: {
    elaAnalysis?: AnalysisItem | null;
    gridRows?: number;
    gridCols?: number;
  } = {},
): AnalysisItem {
  const gridRows = options.gridRows ?? 4;
  const gridCols = options.gridCols ?? 4;

  try {
    const parsedJpeg =
      decoded.format === 'JPEG'
        ? parseJpegDqtAndSof(rawBytes)
        : { validJpeg: false, isProgressive: false, tables: [] };

    const tableSummaries: RecompressionQuantTableSummary[] = parsedJpeg.tables.map((t) => {
      const acVals = t.values.slice(1);
      const hfVals = t.values.slice(32);
      const acMean = acVals.length ? acVals.reduce((a, b) => a + b, 0) / acVals.length : 0;
      const hfMean = hfVals.length ? hfVals.reduce((a, b) => a + b, 0) / hfVals.length : 0;
      return {
        table_id: t.id,
        precision_bits: t.precisionBits,
        dc_value: t.values[0] ?? 0,
        ac_mean: round(acMean, 3),
        high_freq_mean: round(hfMean, 3),
      };
    });

    let estQuality: number | null = null;
    let tableRmse: number | null = null;
    let isCustomTables: boolean | null = null;

    if (parsedJpeg.tables.length > 0) {
      const lumaTable = parsedJpeg.tables.find((t) => t.id === 0) ?? parsedJpeg.tables[0];
      const fit = estimateIjgQualityFromDqt(lumaTable.values);
      estQuality = fit.quality;
      tableRmse = fit.rmse;
      isCustomTables = fit.isCustom;
    }

    // Pixel-domain 8x8 block-grid analysis across full image and 4x4 grid
    const { width, height, rgbPixels } = decoded;
    const totalPixels = width * height;
    const lum = new Float32Array(totalPixels);
    for (let p = 0; p < totalPixels; p += 1) {
      const idx = p * 3;
      lum[p] = 0.299 * rgbPixels[idx] + 0.587 * rgbPixels[idx + 1] + 0.114 * rgbPixels[idx + 2];
    }

    const canBlockGrid = width >= 24 && height >= 24 && !decoded.isUniformContent;
    const globalGrid = canBlockGrid
      ? computeRegionBlockiness(lum, width, 0, 0, width, height)
      : { alignedRatio: 1, maxShiftedRatio: 1, dominantOffset: [0, 0] as [number, number] };

    const shiftedDetected =
      canBlockGrid &&
      (globalGrid.dominantOffset[0] !== 0 || globalGrid.dominantOffset[1] !== 0) &&
      globalGrid.maxShiftedRatio > globalGrid.alignedRatio * 1.06 &&
      globalGrid.maxShiftedRatio > 1.08;

    const tiles = partitionGrid(width, height, gridRows, gridCols);
    const regionalBlockGrid: RegionalBlockGridMetric[] = tiles.map((tile) => {
      const tw = tile.x2 - tile.x1;
      const th = tile.y2 - tile.y1;
      const regRes =
        canBlockGrid && tw >= 16 && th >= 16
          ? computeRegionBlockiness(lum, width, tile.x1, tile.y1, tile.x2, tile.y2)
          : { alignedRatio: 1, maxShiftedRatio: 1, dominantOffset: [0, 0] as [number, number] };
      return {
        region_id: tile.regionId,
        row: tile.row,
        col: tile.col,
        x: tile.x1,
        y: tile.y1,
        width: tw,
        height: th,
        aligned_blockiness: regRes.alignedRatio,
        dominant_offset: regRes.dominantOffset,
        aligned_vs_shifted_ratio: round(
          regRes.alignedRatio / Math.max(0.01, regRes.maxShiftedRatio),
          4,
        ),
      };
    });

    const regionGridScores = normalizeGridScores(
      regionalBlockGrid.map((r) => ({
        region_id: r.region_id,
        row: r.row,
        col: r.col,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        raw_value: r.aligned_blockiness,
      })),
    );

    // Evaluate multi-quality ELA curve inflection if available
    const elaDetails = (options.elaAnalysis?.details ?? null) as ELADetails | null;
    const curve = elaDetails?.multi_quality_curve ?? [];
    let inflectionQuality: number | null = null;
    let nonMonotonic = false;

    if (curve.length >= 3) {
      // Sorted descending quality [95, 90, 80, 70]: a dip near the image's own single-save DQT quality
      // is expected (matching quantization grid); only flag a substantial secondary dip away from estQuality.
      const sorted = [...curve].sort((a, b) => b.quality - a.quality);
      for (let i = 1; i < sorted.length; i += 1) {
        const drop = sorted[i - 1].mean_difference - sorted[i].mean_difference;
        const awayFromCurrentQ =
          estQuality === null || Math.abs(sorted[i].quality - estQuality) > 6;
        if (
          awayFromCurrentQ &&
          drop > 0.5 &&
          sorted[i].mean_difference < sorted[i - 1].mean_difference * 0.75
        ) {
          nonMonotonic = true;
          inflectionQuality = sorted[i].quality;
          break;
        }
      }
    }

    const indicators: string[] = [];
    if (isCustomTables) {
      indicators.push(
        `Non-standard JPEG luminance quantization table (RMSE=${tableRmse} vs closest IJG Q=${estQuality}); typical of export software or platform transcoding.`,
      );
    }
    if (decoded.format !== 'JPEG' && canBlockGrid && globalGrid.alignedRatio >= 1.12) {
      indicators.push(
        `Aligned 8x8 block-boundary discontinuity detected in lossless/non-JPEG pixels (ratio=${globalGrid.alignedRatio.toFixed(2)}), consistent with prior JPEG compression before re-encoding as ${decoded.format}.`,
      );
    }
    if (shiftedDetected) {
      indicators.push(
        `Dominant 8x8 block grid offset (${globalGrid.dominantOffset[0]}, ${globalGrid.dominantOffset[1]}) exceeds (0,0) grid (${globalGrid.maxShiftedRatio.toFixed(2)} vs ${globalGrid.alignedRatio.toFixed(2)}), consistent with cropping or spatial shifting after prior JPEG encoding.`,
      );
    }
    if (nonMonotonic && inflectionQuality !== null) {
      indicators.push(
        `Multi-quality ELA curve exhibits non-monotonic error reduction around Q=${inflectionQuality}.`,
      );
    }

    let doubleStatus: RecompressionDetails['double_jpeg_indicators']['status'] =
      'no_strong_indicator';
    if (!canBlockGrid) {
      doubleStatus = 'insufficient_contrast';
    } else if (indicators.length > 0) {
      doubleStatus = 'indicators_present';
    }

    const methodInfo: MethodDocumentation = {
      what_it_measures:
        'Inspects raw JPEG DQT quantization tables (IJG fit & non-standard table deviation), multi-quality ELA monotonicity, and pixel-domain 8x8 DCT block-boundary periodicity across all 8x8 grid offsets.',
      assumptions: [
        'JPEG encoders apply 8x8 pixel block DCT quantization centered at (0,0) unless subsequently cropped or spliced.',
        'Lossless conversions (JPEG -> PNG/WEBP) preserve residual 8x8 block boundaries in pixel values.',
      ],
      limitations: recompressionLimitations(),
      parameters: {
        block_size: 8,
        grid: `${gridRows}x${gridCols}`,
      },
    };

    const details: RecompressionDetails = {
      format: decoded.format,
      jpeg_bitstream: {
        available: decoded.format === 'JPEG' && parsedJpeg.tables.length > 0,
        is_progressive: decoded.format === 'JPEG' ? decoded.isProgressive || parsedJpeg.isProgressive : null,
        chroma_subsampling: decoded.format === 'JPEG' ? decoded.chromaSubsampling : null,
        dqt_table_count: tableSummaries.length,
        estimated_ijg_quality: estQuality,
        ijg_table_rmse: tableRmse,
        custom_or_nonstandard_tables: isCustomTables,
        tables: tableSummaries,
        notes:
          decoded.format === 'JPEG'
            ? `Parsed ${tableSummaries.length} JPEG DQT quantization table(s)${estQuality ? `; closest standard IJG quality ≈ ${estQuality}` : ''}.`
            : `Bitstream DQT markers are JPEG-specific and unavailable for ${decoded.format}; pixel-domain 8x8 block-grid scan was executed.`,
      },
      pixel_block_grid: {
        available: canBlockGrid,
        aligned_blockiness_ratio: globalGrid.alignedRatio,
        max_shifted_blockiness_ratio: globalGrid.maxShiftedRatio,
        dominant_offset: globalGrid.dominantOffset,
        shifted_grid_detected: shiftedDetected,
        regional_block_grid: regionalBlockGrid,
        region_grid_scores: regionGridScores,
      },
      double_jpeg_indicators: {
        status: doubleStatus,
        ela_curve_inflection_quality: inflectionQuality,
        ela_curve_non_monotonic: nonMonotonic,
        indicators,
      },
      method_info: methodInfo,
    };

    const observations: string[] = [
      details.jpeg_bitstream.notes,
      canBlockGrid
        ? `Pixel 8x8 block-boundary ratio at (0,0) is ${globalGrid.alignedRatio.toFixed(3)} (dominant phase offset: (${globalGrid.dominantOffset[0]}, ${globalGrid.dominantOffset[1]})).`
        : 'Pixel 8x8 block-grid evaluation skipped due to small dimensions or uniform constant pixel content.',
      ...(indicators.length
        ? indicators
        : ['No strong multi-generation or misaligned 8x8 block-grid shift indicators detected.']),
    ];

    return {
      name: 'recompression',
      status: 'completed',
      observations,
      metrics: {
        dqt_table_count: tableSummaries.length,
        estimated_ijg_quality: estQuality ?? 0,
        ijg_table_rmse: tableRmse ?? 0,
        custom_or_nonstandard_tables: Boolean(isCustomTables),
        aligned_blockiness_ratio: globalGrid.alignedRatio,
        max_shifted_blockiness_ratio: globalGrid.maxShiftedRatio,
        shifted_grid_detected: shiftedDetected,
        ela_curve_non_monotonic: nonMonotonic,
        indicator_count: indicators.length,
      },
      limitations: recompressionLimitations(),
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'recompression',
      status: 'failed',
      observations: [`Recompression / block-grid analysis failed: ${msg}`],
      metrics: {},
      limitations: recompressionLimitations(),
      details: null,
    };
  }
}
