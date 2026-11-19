import sharp from 'sharp';
import type {
  AnalysisItem,
  NormalizedRegionScore,
  RobustnessDetails,
  RobustnessTransformResult,
} from '../../shared/contracts.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import {
  computeTopKCellAgreement,
  normalizeGridScores,
  pearsonCorrelation,
} from './gridNormalization.ts';

const MAX_ROBUSTNESS_DIM = 768;
const MIN_ROBUSTNESS_DIM = 32;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

async function computeFastNoiseGrid(
  rgbBuf: Buffer,
  width: number,
  height: number,
  gridRows: number,
  gridCols: number,
): Promise<{ meanAbsResidual: number; gridScores: NormalizedRegionScore[] }> {
  const smoothed = await sharp(rgbBuf, { raw: { width, height, channels: 3 } })
    .blur(1.0)
    .raw()
    .toBuffer();

  const totalValues = width * height * 3;
  let sumAbs = 0;
  for (let i = 0; i < totalValues; i += 1) {
    sumAbs += Math.abs(rgbBuf[i] - smoothed[i]);
  }
  const meanAbsResidual = totalValues > 0 ? sumAbs / totalValues : 0;

  const tiles = partitionGrid(width, height, gridRows, gridCols);
  const rawTiles = tiles.map((tile) => {
    const tw = tile.x2 - tile.x1;
    const th = tile.y2 - tile.y1;
    const count = tw * th * 3;
    let tSum = 0;
    let tSq = 0;
    for (let y = tile.y1; y < tile.y2; y += 1) {
      const start = (y * width + tile.x1) * 3;
      const end = (y * width + tile.x2) * 3;
      for (let i = start; i < end; i += 1) {
        const r = rgbBuf[i] - smoothed[i];
        tSum += r;
        tSq += r * r;
      }
    }
    const mean = count > 0 ? tSum / count : 0;
    const std = count > 0 ? Math.sqrt(Math.max(0, tSq / count - mean * mean)) : 0;
    return {
      region_id: tile.regionId,
      row: tile.row,
      col: tile.col,
      x: tile.x1,
      y: tile.y1,
      width: tw,
      height: th,
      raw_value: std,
    };
  });

  return {
    meanAbsResidual: round(meanAbsResidual, 4),
    gridScores: normalizeGridScores(rawTiles),
  };
}

function classifyTransformStability(
  baselineHasContrast: boolean,
  corr: number,
  iou: number,
  retentionRatio: number,
): RobustnessTransformResult['signal_retained'] {
  if (!baselineHasContrast) return 'insufficient_contrast';
  if (corr >= 0.75 && (iou >= 0.5 || retentionRatio >= 0.65)) return 'stable';
  if (corr >= 0.45 && retentionRatio >= 0.35) return 'attenuated';
  return 'fragile';
}

function robustnessLimitations(): string[] {
  return [
    'Robustness stress testing evaluates signal persistence under simulated re-encoding (JPEG Q85, JPEG Q70, 0.75x resampling) in memory without altering original evidence.',
    'Signal persistence under compression reflects physical spatial contrast durability, not proof of tampering.',
    'Delicate genuine sensor noise or subtle high-frequency artifacts naturally attenuate under Q70 compression or downsampling.',
    `Images larger than ${MAX_ROBUSTNESS_DIM}px are normalized to <= ${MAX_ROBUSTNESS_DIM}px in memory for bounded perturbation latency.`,
  ];
}

export async function buildRobustnessAnalysis(
  decoded: DecodedImage,
  options: {
    gridRows?: number;
    gridCols?: number;
  } = {},
): Promise<AnalysisItem> {
  const startedAt = Date.now();
  const gridRows = options.gridRows ?? 4;
  const gridCols = options.gridCols ?? 4;

  try {
    const origBuf = Buffer.from(
      decoded.rgbPixels.buffer,
      decoded.rgbPixels.byteOffset,
      decoded.rgbPixels.byteLength,
    );

    if (decoded.isSmallImage || decoded.width < MIN_ROBUSTNESS_DIM || decoded.height < MIN_ROBUSTNESS_DIM || decoded.isUniformContent) {
      const reason = decoded.isUniformContent
        ? 'Image has near-uniform pixel intensity with insufficient statistical contrast for perturbation stability testing.'
        : `Image dimensions (${decoded.width}x${decoded.height}) are below the ${MIN_ROBUSTNESS_DIM}x${MIN_ROBUSTNESS_DIM} threshold for spatial robustness perturbations.`;

      const durationMs = Date.now() - startedAt;
      const details: RobustnessDetails = {
        baseline_valid: false,
        insufficient_contrast_reason: reason,
        analysis_resolution: { width: decoded.width, height: decoded.height },
        overall_stability: 'insufficient_evidence',
        duration_ms: durationMs,
        transforms: [],
        method_info: {
          what_it_measures:
            'Measures stability of spatial noise-residual patterns under controlled in-memory JPEG Q85, JPEG Q70, and 0.75x resize perturbations.',
          assumptions: [
            'Structural spatial variations that survive re-encoding are less likely to be single-generation compression jitter.',
          ],
          limitations: robustnessLimitations(),
          parameters: {
            max_dimension: MAX_ROBUSTNESS_DIM,
            min_dimension: MIN_ROBUSTNESS_DIM,
            transforms: 'jpeg_q85,jpeg_q70,resize_75pct',
          },
        },
      };

      return {
        name: 'robustness',
        status: 'completed',
        observations: [reason],
        metrics: {
          baseline_valid: false,
          overall_stability: 'insufficient_evidence',
          duration_ms: durationMs,
          transform_count: 0,
        },
        limitations: robustnessLimitations(),
        details,
      };
    }

    let workW = decoded.width;
    let workH = decoded.height;
    let workBuf = origBuf;

    if (Math.max(decoded.width, decoded.height) > MAX_ROBUSTNESS_DIM) {
      const resized = await sharp(origBuf, {
        raw: { width: decoded.width, height: decoded.height, channels: 3 },
      })
        .resize({
          width: MAX_ROBUSTNESS_DIM,
          height: MAX_ROBUSTNESS_DIM,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      workW = resized.info.width;
      workH = resized.info.height;
      workBuf = resized.data;
    }

    const baseline = await computeFastNoiseGrid(workBuf, workW, workH, gridRows, gridCols);
    const baselineRawVec = baseline.gridScores.map((s) => s.raw_value);
    const baselineMaxZ = Math.max(...baseline.gridScores.map((s) => s.robust_z));
    const baselineHasContrast = baseline.meanAbsResidual >= 0.15 && baselineMaxZ >= 0.8;

    const specs = [
      {
        id: 'jpeg_q85',
        label: 'JPEG re-encode (Q=85)',
        run: async () => {
          const jpg = await sharp(workBuf, { raw: { width: workW, height: workH, channels: 3 } })
            .jpeg({ quality: 85 })
            .toBuffer();
          return sharp(jpg).removeAlpha().toColorspace('srgb').raw().toBuffer();
        },
      },
      {
        id: 'jpeg_q70',
        label: 'JPEG re-encode (Q=70)',
        run: async () => {
          const jpg = await sharp(workBuf, { raw: { width: workW, height: workH, channels: 3 } })
            .jpeg({ quality: 70 })
            .toBuffer();
          return sharp(jpg).removeAlpha().toColorspace('srgb').raw().toBuffer();
        },
      },
      {
        id: 'resize_75pct',
        label: '0.75x downscale + 1.0x restore',
        run: async () => {
          const dw = Math.max(16, Math.round(workW * 0.75));
          const dh = Math.max(16, Math.round(workH * 0.75));
          const down = await sharp(workBuf, { raw: { width: workW, height: workH, channels: 3 } })
            .resize(dw, dh, { fit: 'fill', kernel: 'cubic' })
            .raw()
            .toBuffer();
          return sharp(down, { raw: { width: dw, height: dh, channels: 3 } })
            .resize(workW, workH, { fit: 'fill', kernel: 'cubic' })
            .raw()
            .toBuffer();
        },
      },
    ];

    const transforms: RobustnessTransformResult[] = [];
    for (const spec of specs) {
      const perturbedBuf = await spec.run();
      const perturbed = await computeFastNoiseGrid(perturbedBuf, workW, workH, gridRows, gridCols);
      const perturbedVec = perturbed.gridScores.map((s) => s.raw_value);
      const corr = pearsonCorrelation(baselineRawVec, perturbedVec);
      const agreement = computeTopKCellAgreement(baseline.gridScores, perturbed.gridScores, 3, 0.8);
      const retentionRatio =
        baseline.meanAbsResidual > 1e-6
          ? round(perturbed.meanAbsResidual / baseline.meanAbsResidual, 4)
          : 0;

      transforms.push({
        transform_id: spec.id,
        label: spec.label,
        noise_mean_abs_baseline: baseline.meanAbsResidual,
        noise_mean_abs_perturbed: perturbed.meanAbsResidual,
        noise_retention_ratio: retentionRatio,
        regional_pearson_corr: corr,
        regional_top_k_iou: agreement.iou,
        signal_retained: classifyTransformStability(
          baselineHasContrast,
          corr,
          agreement.iou,
          retentionRatio,
        ),
      });
    }

    let overallStability: RobustnessDetails['overall_stability'] = 'insufficient_evidence';
    if (baselineHasContrast) {
      const stableCount = transforms.filter((t) => t.signal_retained === 'stable').length;
      const fragileCount = transforms.filter((t) => t.signal_retained === 'fragile').length;
      if (stableCount >= 2) overallStability = 'stable';
      else if (fragileCount >= 2) overallStability = 'fragile';
      else overallStability = 'moderately_sensitive';
    }

    const durationMs = Date.now() - startedAt;
    const meanCorr =
      transforms.reduce((acc, t) => acc + t.regional_pearson_corr, 0) / transforms.length;

    const details: RobustnessDetails = {
      baseline_valid: baselineHasContrast,
      insufficient_contrast_reason: baselineHasContrast
        ? null
        : 'Baseline spatial variation across the grid was below the contrast floor required to track perturbation survival.',
      analysis_resolution: { width: workW, height: workH },
      overall_stability: overallStability,
      duration_ms: durationMs,
      transforms,
      method_info: {
        what_it_measures:
          'Measures stability of spatial noise-residual patterns under controlled in-memory JPEG Q85, JPEG Q70, and 0.75x resize perturbations.',
        assumptions: [
          'Structural spatial variations that survive re-encoding are less likely to be single-generation compression jitter.',
        ],
        limitations: robustnessLimitations(),
        parameters: {
          max_dimension: MAX_ROBUSTNESS_DIM,
          min_dimension: MIN_ROBUSTNESS_DIM,
          transforms: 'jpeg_q85,jpeg_q70,resize_75pct',
        },
      },
    };

    const observations = [
      `Perturbation robustness evaluated at ${workW}x${workH} across ${transforms.length} simulated re-encoding transforms in ${durationMs}ms.`,
      baselineHasContrast
        ? `Overall spatial signal stability classified as '${overallStability}' (mean regional Pearson correlation: ${meanCorr.toFixed(3)}).`
        : 'Baseline grid variance was too uniform to reliably distinguish retained vs attenuated regional perturbations.',
      ...transforms.map(
        (t) =>
          `${t.label}: noise retention ${(t.noise_retention_ratio * 100).toFixed(1)}%, regional correlation r=${t.regional_pearson_corr.toFixed(2)}, Top-3 IoU=${t.regional_top_k_iou.toFixed(2)} (${t.signal_retained}).`,
      ),
    ];

    return {
      name: 'robustness',
      status: 'completed',
      observations,
      metrics: {
        baseline_valid: baselineHasContrast,
        overall_stability: overallStability,
        mean_regional_corr: round(meanCorr, 4),
        duration_ms: durationMs,
        transform_count: transforms.length,
      },
      limitations: robustnessLimitations(),
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'robustness',
      status: 'failed',
      observations: [`Robustness check could not be computed: ${msg}`],
      metrics: {},
      limitations: robustnessLimitations(),
      details: null,
    };
  }
}
