import type { NormalizedRegionScore } from '../../shared/contracts.ts';

export interface RawTileScoreInput {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  raw_value: number;
}

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

export function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function stdDevValue(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Normalizes per-tile raw values onto a shared NxN NormalizedRegionScore grid
 * using robust median / (1.4826 * MAD) scaling with fallback to population stdDev.
 * Uniform or constant grids safely collapse to zero z-scores without division by zero.
 */
export function normalizeGridScores(tiles: RawTileScoreInput[]): NormalizedRegionScore[] {
  if (tiles.length === 0) return [];

  const values = tiles.map((t) => (Number.isFinite(t.raw_value) ? t.raw_value : 0));
  const med = medianValue(values);
  const absDevs = values.map((v) => Math.abs(v - med));
  const mad = medianValue(absDevs);
  const std = stdDevValue(values);
  const isConstant = values.every((v) => Math.abs(v - values[0]) <= 1e-8);

  let scale = 1.0;
  if (mad > 1e-6) {
    scale = 1.4826 * mad;
  } else if (std > 1e-6) {
    scale = std;
  }

  // Compute percentile ranks
  const sorted = [...values].sort((a, b) => a - b);

  return tiles.map((tile, idx) => {
    const val = values[idx];
    const signedZ = isConstant || scale <= 1e-8 ? 0 : (val - med) / scale;
    const robustZ = Math.abs(signedZ);

    // Mid-rank percentile in [0, 100]
    let below = 0;
    let equal = 0;
    for (const sVal of sorted) {
      if (sVal < val) below += 1;
      else if (sVal === val) equal += 1;
    }
    const pct =
      sorted.length <= 1
        ? 50
        : ((below + 0.5 * Math.max(0, equal - 1)) / (sorted.length - 1)) * 100;

    // Monotonic bounded normalized indicator in [0, 1] where robustZ=4 maps to 1.0
    const normalizedScore = Math.min(1, Math.max(0, robustZ / 4.0));

    let flagLevel: NormalizedRegionScore['flag_level'] = 'typical';
    if (robustZ >= 2.0) flagLevel = 'elevated';
    else if (robustZ >= 1.2) flagLevel = 'mild';

    return {
      region_id: tile.region_id,
      row: tile.row,
      col: tile.col,
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      raw_value: round(val, 4),
      robust_z: round(robustZ, 4),
      signed_z: round(signedZ, 4),
      percentile_rank: round(pct, 2),
      normalized_score: round(normalizedScore, 4),
      flag_level: flagLevel,
    };
  });
}

export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  if (denom <= 1e-9) {
    const aConst = denA <= 1e-9;
    const bConst = denB <= 1e-9;
    return aConst && bConst ? 1 : 0;
  }
  return round(Math.max(-1, Math.min(1, num / denom)), 4);
}

export interface TopKAgreementResult {
  top_k: number;
  iou: number;
  overlap_regions: string[];
  status: 'corroborated' | 'divergent' | 'insufficient_contrast';
}

/**
 * Computes Top-K spatial IoU (Jaccard overlap) between two NormalizedRegionScore grids.
 * Requires both grids to show minimal statistical spread (max robust_z >= minZ) so noise
 * in flat/uniform images is never falsely scored as spatial corroboration or divergence.
 */
export function computeTopKCellAgreement(
  scoresA: NormalizedRegionScore[],
  scoresB: NormalizedRegionScore[],
  topK = 3,
  minZ = 1.2,
): TopKAgreementResult {
  if (scoresA.length === 0 || scoresB.length === 0) {
    return { top_k: topK, iou: 0, overlap_regions: [], status: 'insufficient_contrast' };
  }

  const maxZA = Math.max(...scoresA.map((s) => s.robust_z));
  const maxZB = Math.max(...scoresB.map((s) => s.robust_z));
  if (maxZA < minZ || maxZB < minZ) {
    return { top_k: topK, iou: 0, overlap_regions: [], status: 'insufficient_contrast' };
  }

  const k = Math.max(1, Math.min(topK, scoresA.length, scoresB.length));
  const topA = new Set(
    [...scoresA]
      .filter((s) => s.robust_z >= minZ * 0.75)
      .sort((x, y) => y.robust_z - x.robust_z)
      .slice(0, k)
      .map((s) => s.region_id),
  );
  const topB = new Set(
    [...scoresB]
      .filter((s) => s.robust_z >= minZ * 0.75)
      .sort((x, y) => y.robust_z - x.robust_z)
      .slice(0, k)
      .map((s) => s.region_id),
  );

  if (topA.size === 0 || topB.size === 0) {
    return { top_k: k, iou: 0, overlap_regions: [], status: 'insufficient_contrast' };
  }

  const overlap: string[] = [];
  for (const id of topA) {
    if (topB.has(id)) overlap.push(id);
  }
  const unionSize = new Set([...topA, ...topB]).size;
  const iou = unionSize > 0 ? round(overlap.length / unionSize, 4) : 0;

  return {
    top_k: k,
    iou,
    overlap_regions: overlap.sort(),
    status: overlap.length > 0 && iou >= 0.25 ? 'corroborated' : 'divergent',
  };
}
