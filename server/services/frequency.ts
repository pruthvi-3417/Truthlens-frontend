import sharp from 'sharp';
import type {
  AnalysisItem,
  FrequencyDetails,
  MethodDocumentation,
  NormalizedRegionScore,
} from '../types.ts';
import { fft2dShiftedMagnitudeAndPower } from '../utils/fft2d.ts';
import type { DecodedImage } from '../utils/imageIo.ts';
import { partitionGrid } from '../utils/imageIo.ts';
import { medianValue, normalizeGridScores } from './gridNormalization.ts';

const DEFAULT_FFT_MAX_DIMENSION = 1024;
const MAX_VISUALIZATION_DIMENSION = 1200;
const LOW_FREQ_CUTOFF = 0.1;
const MID_FREQ_CUTOFF = 0.4;
const MIN_REGIONAL_FFT_DIM = 8;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
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

async function generateSpectrumVisualization(
  magnitude: Float64Array,
  width: number,
  height: number,
): Promise<string> {
  const total = width * height;
  const logMag = new Float64Array(total);
  let maxVal = 0;

  for (let i = 0; i < total; i += 1) {
    const v = Math.log1p(magnitude[i]);
    logMag[i] = v;
    if (v > maxVal) maxVal = v;
  }

  const scale = maxVal > 0 ? 255.0 / maxVal : 1.0;
  const gray = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const v = Math.round(logMag[i] * scale);
    gray[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }

  let pipeline = sharp(Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength), {
    raw: { width, height, channels: 1 },
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

function frequencyLimitations(isDownsampled: boolean, analysisW: number, analysisH: number): string[] {
  const limitations = [
    'Frequency domain patterns are strongly governed by image semantic content, sharp edges, and detailed textures.',
    'Lossy compression algorithms (such as JPEG DCT quantization), sharpening, downsampling, and denoising alter high-frequency spectral roll-off.',
    'Natural photographs, digital artwork, and generative AI outputs can exhibit overlapping frequency characteristics depending on resolution, content, and post-processing.',
    '2D FFT evaluates global spatial frequencies and does not isolate localized spatial manipulations or splices.',
  ];
  if (isDownsampled) {
    limitations.push(
      `Analysis was performed on a downsampled ${analysisW}x${analysisH} copy to prevent excessive memory usage during FFT calculation; fine pixel-level Nyquist frequencies of the original image were band-limited.`,
    );
  }
  return limitations;
}

function interpretFrequency(details: FrequencyDetails): string[] {
  const downsampleNote = details.is_downsampled ? ' (downsampled for memory safety)' : '';
  const windowName =
    details.window_function.charAt(0).toUpperCase() + details.window_function.slice(1);

  const observations: string[] = [
    `2D Fast Fourier Transform computed using ${windowName} windowing on ${details.analysis_width}x${details.analysis_height} luminance matrix${downsampleNote}.`,
    `Spectral energy distribution: Low frequency (r < ${LOW_FREQ_CUTOFF.toFixed(2)}): ${details.low_frequency_energy_pct.toFixed(2)}%, Mid frequency (${LOW_FREQ_CUTOFF.toFixed(2)} <= r < ${MID_FREQ_CUTOFF.toFixed(2)}): ${details.mid_frequency_energy_pct.toFixed(2)}%, High frequency (r >= ${MID_FREQ_CUTOFF.toFixed(2)}): ${details.high_frequency_energy_pct.toFixed(2)}%.`,
    `Spectral centroid is ${details.spectral_centroid.toFixed(3)} (normalized radial frequency) with normalized spectral entropy of ${details.spectral_entropy.toFixed(3)}.`,
  ];

  if (
    typeof details.spectral_rolloff_85 === 'number' &&
    typeof details.azimuthal_spike_ratio === 'number'
  ) {
    observations.push(
      `85% spectral power roll-off radius is ${details.spectral_rolloff_85.toFixed(3)}; mid/high azimuthal peak-to-median spike ratio is ${details.azimuthal_spike_ratio.toFixed(2)}.`,
    );
  }

  if (details.total_non_dc_power === 0) {
    observations.push('Image contains zero non-DC spectral energy (uniform constant luminance).');
  } else if (details.low_frequency_energy_pct >= 80.0) {
    observations.push(
      'Spectral energy is predominantly concentrated in lower spatial frequencies, typical of smooth gradients, out-of-focus areas, and broad image structures.',
    );
  } else if (details.high_frequency_energy_pct >= 50.0) {
    observations.push(
      'A substantial proportion of spectral energy lies in higher spatial frequencies, consistent with fine textures, sharp transitions, or sensor noise.',
    );
  } else {
    observations.push(
      'Spectral energy is distributed across both lower and higher spatial frequencies, reflecting a combination of structural content and fine detail.',
    );
  }

  observations.push(
    'Frequency domain analysis evaluates spatial-frequency energy distribution via 2D FFT; it does not classify an image as real or fake, and cannot prove AI generation or manipulation.',
  );

  return observations;
}

function computeTileHighFreqRatio(
  luminance: Float64Array,
  imgW: number,
  x1: number,
  y1: number,
  tw: number,
  th: number,
): number {
  const total = tw * th;
  let tileSum = 0;
  for (let y = 0; y < th; y += 1) {
    const rowOff = (y1 + y) * imgW + x1;
    for (let x = 0; x < tw; x += 1) {
      tileSum += luminance[rowOff + x];
    }
  }
  const tileMean = total > 0 ? tileSum / total : 0;

  const wh = hann1D(th);
  const ww = hann1D(tw);
  const windowed = new Float64Array(total);
  for (let y = 0; y < th; y += 1) {
    const wy = wh[y];
    const srcOff = (y1 + y) * imgW + x1;
    const dstOff = y * tw;
    for (let x = 0; x < tw; x += 1) {
      windowed[dstOff + x] = (luminance[srcOff + x] - tileMean) * wy * ww[x];
    }
  }

  const { power } = fft2dShiftedMagnitudeAndPower(windowed, th, tw);
  const cy = Math.floor(th / 2);
  const cx = Math.floor(tw / 2);
  let totalPower = 0;
  for (let i = 0; i < total; i += 1) totalPower += power[i];
  const nonDcPower = totalPower - power[cy * tw + cx];
  if (nonDcPower <= 1e-12) return 0;

  const ny = th > 1 ? th / 2 : 1;
  const nx = tw > 1 ? tw / 2 : 1;
  let highFreqPower = 0;
  for (let y = 0; y < th; y += 1) {
    const fy = (y - cy) / ny;
    const rowOff = y * tw;
    for (let x = 0; x < tw; x += 1) {
      const fx = (x - cx) / nx;
      if (Math.hypot(fx, fy) >= MID_FREQ_CUTOFF) {
        highFreqPower += power[rowOff + x];
      }
    }
  }
  return Math.min(1, Math.max(0, highFreqPower / nonDcPower));
}

export async function buildFrequencyAnalysis(
  decoded: DecodedImage,
  options: {
    maxDimension?: number;
    gridRows?: number;
    gridCols?: number;
    includeVisualization?: boolean;
  } = {},
): Promise<AnalysisItem> {
  const maxDimension = options.maxDimension ?? DEFAULT_FFT_MAX_DIMENSION;
  const gridRows = options.gridRows ?? 4;
  const gridCols = options.gridCols ?? 4;
  const includeVisualization = options.includeVisualization ?? true;

  try {
    const origW = decoded.width;
    const origH = decoded.height;
    let analysisW = origW;
    let analysisH = origH;
    let rgbPixels = decoded.rgbPixels;
    let isDownsampled = false;

    if (Math.max(origW, origH) > maxDimension) {
      isDownsampled = true;
      const origBuf = Buffer.from(rgbPixels.buffer, rgbPixels.byteOffset, rgbPixels.byteLength);
      const resized = await sharp(origBuf, {
        raw: { width: origW, height: origH, channels: 3 },
      })
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      analysisW = resized.info.width;
      analysisH = resized.info.height;
      rgbPixels = new Uint8Array(
        resized.data.buffer,
        resized.data.byteOffset,
        resized.data.byteLength,
      );
    }

    const totalPixels = analysisW * analysisH;
    const luminance = new Float64Array(totalPixels);
    let lumSum = 0;

    for (let p = 0; p < totalPixels; p += 1) {
      const idx = p * 3;
      const yVal =
        0.299 * rgbPixels[idx] + 0.587 * rgbPixels[idx + 1] + 0.114 * rgbPixels[idx + 2];
      luminance[p] = yVal;
      lumSum += yVal;
    }

    const meanVal = totalPixels > 0 ? lumSum / totalPixels : 0;
    const wy = hann1D(analysisH);
    const wx = hann1D(analysisW);
    const windowed = new Float64Array(totalPixels);

    for (let y = 0; y < analysisH; y += 1) {
      const wyVal = wy[y];
      const rowOffset = y * analysisW;
      for (let x = 0; x < analysisW; x += 1) {
        windowed[rowOffset + x] = (luminance[rowOffset + x] - meanVal) * wyVal * wx[x];
      }
    }

    const { magnitude, power } = fft2dShiftedMagnitudeAndPower(windowed, analysisH, analysisW);

    const cy = Math.floor(analysisH / 2);
    const cx = Math.floor(analysisW / 2);
    const halfH = analysisH > 1 ? analysisH / 2 : 1;
    const halfW = analysisW > 1 ? analysisW / 2 : 1;

    let totalNonDcPower = 0;
    let lowPower = 0;
    let midPower = 0;
    let highPower = 0;
    let rPowerSum = 0;
    let maxR = 0;

    const RADIAL_BINS = 24;
    const radialBinSums = new Float64Array(RADIAL_BINS);
    const midHighRingRatios: number[] = [];

    for (let y = 0; y < analysisH; y += 1) {
      const fy = analysisH > 1 ? Math.abs(y - cy) / halfH : 0;
      const rowOffset = y * analysisW;
      for (let x = 0; x < analysisW; x += 1) {
        const fx = analysisW > 1 ? Math.abs(x - cx) / halfW : 0;
        const r = Math.hypot(fx, fy);
        if (r > maxR) maxR = r;

        if (y === cy && x === cx) continue;

        const pVal = power[rowOffset + x];
        totalNonDcPower += pVal;
        rPowerSum += r * pVal;

        const bin = Math.min(RADIAL_BINS - 1, Math.floor((r / 1.42) * RADIAL_BINS));
        radialBinSums[bin] += pVal;

        if (r < LOW_FREQ_CUTOFF) {
          lowPower += pVal;
        } else if (r < MID_FREQ_CUTOFF) {
          midPower += pVal;
        } else {
          highPower += pVal;
        }
      }
    }

    let lowPct = 0;
    let midPct = 0;
    let highPct = 0;
    let spectralCentroid = 0;
    let spectralEntropy = 0;
    let rolloff85 = 0;
    let azimuthalSpikeRatio = 1.0;

    if (totalNonDcPower > 0) {
      lowPct = (lowPower / totalNonDcPower) * 100;
      midPct = (midPower / totalNonDcPower) * 100;
      highPct = (highPower / totalNonDcPower) * 100;
      spectralCentroid = rPowerSum / totalNonDcPower;

      // 85% radial spectral roll-off
      let cumPower = 0;
      const targetPower = totalNonDcPower * 0.85;
      for (let b = 0; b < RADIAL_BINS; b += 1) {
        cumPower += radialBinSums[b];
        if (cumPower >= targetPower) {
          rolloff85 = ((b + 1) / RADIAL_BINS) * Math.max(1, maxR);
          break;
        }
      }

      // Evaluate mid/high azimuthal periodic spikes (ratio of radial annulus peak to median)
      for (let b = 4; b < RADIAL_BINS - 2; b += 1) {
        const rMin = (b / RADIAL_BINS) * 1.42;
        const rMax = ((b + 1) / RADIAL_BINS) * 1.42;
        const ringVals: number[] = [];
        for (let y = 0; y < analysisH; y += 2) {
          const fy = analysisH > 1 ? Math.abs(y - cy) / halfH : 0;
          const rowOff = y * analysisW;
          for (let x = 0; x < analysisW; x += 2) {
            const fx = analysisW > 1 ? Math.abs(x - cx) / halfW : 0;
            const r = Math.hypot(fx, fy);
            if (r >= rMin && r < rMax) {
              ringVals.push(power[rowOff + x]);
            }
          }
        }
        if (ringVals.length >= 8) {
          const ringMed = medianValue(ringVals);
          const ringMax = Math.max(...ringVals);
          if (ringMed > 1e-12) {
            midHighRingRatios.push(ringMax / ringMed);
          }
        }
      }
      if (midHighRingRatios.length > 0) {
        azimuthalSpikeRatio = medianValue(midHighRingRatios);
      }

      const k = Math.max(1, totalPixels - 1);
      if (k > 1) {
        let negEntropy = 0;
        for (let y = 0; y < analysisH; y += 1) {
          const rowOffset = y * analysisW;
          for (let x = 0; x < analysisW; x += 1) {
            if (y === cy && x === cx) continue;
            const pNorm = power[rowOffset + x] / totalNonDcPower;
            if (pNorm > 0) {
              negEntropy += pNorm * Math.log(pNorm);
            }
          }
        }
        spectralEntropy = -negEntropy / Math.log(k);
      }
    }

    const highToLowRatio = lowPower > 1e-12 ? highPower / lowPower : 0;

    let regionGridScores: NormalizedRegionScore[] = [];
    const tileMinW = Math.floor(analysisW / gridCols);
    const tileMinH = Math.floor(analysisH / gridRows);
    if (tileMinW >= MIN_REGIONAL_FFT_DIM && tileMinH >= MIN_REGIONAL_FFT_DIM) {
      const tiles = partitionGrid(analysisW, analysisH, gridRows, gridCols);
      const rawTiles = tiles.map((t) => ({
        region_id: t.regionId,
        row: t.row,
        col: t.col,
        x: Math.round((t.x1 / analysisW) * origW),
        y: Math.round((t.y1 / analysisH) * origH),
        width: Math.max(1, Math.round(((t.x2 - t.x1) / analysisW) * origW)),
        height: Math.max(1, Math.round(((t.y2 - t.y1) / analysisH) * origH)),
        raw_value: computeTileHighFreqRatio(
          luminance,
          analysisW,
          t.x1,
          t.y1,
          t.x2 - t.x1,
          t.y2 - t.y1,
        ),
      }));
      regionGridScores = normalizeGridScores(rawTiles);
    }

    const visUrl = includeVisualization
      ? await generateSpectrumVisualization(magnitude, analysisW, analysisH)
      : null;

    const methodInfo: MethodDocumentation = {
      what_it_measures:
        'Computes 2D Hann-windowed FFT power spectrum across low/mid/high radial bands, 85% spectral roll-off, azimuthal peak-to-median ratio, and per-tile high-frequency ratios.',
      assumptions: [
        'Hann windowing suppresses image-border spectral leakage.',
        'Natural scenes typically exhibit smooth 1/f-like radial spectral decay without sharp synthetic periodic spikes.',
      ],
      limitations: frequencyLimitations(isDownsampled, analysisW, analysisH),
      parameters: {
        max_dimension: maxDimension,
        window_function: 'hann',
        low_freq_cutoff: LOW_FREQ_CUTOFF,
        mid_freq_cutoff: MID_FREQ_CUTOFF,
      },
    };

    const details: FrequencyDetails = {
      analysis_width: analysisW,
      analysis_height: analysisH,
      original_width: origW,
      original_height: origH,
      is_downsampled: isDownsampled,
      window_function: 'hann',
      total_non_dc_power: round(totalNonDcPower, 4),
      low_frequency_power: round(lowPower, 4),
      mid_frequency_power: round(midPower, 4),
      high_frequency_power: round(highPower, 4),
      low_frequency_energy_pct: round(lowPct, 2),
      mid_frequency_energy_pct: round(midPct, 2),
      high_frequency_energy_pct: round(highPct, 2),
      spectral_centroid: round(spectralCentroid, 4),
      spectral_entropy: round(spectralEntropy, 4),
      band_boundaries: {
        low: [0.0, LOW_FREQ_CUTOFF],
        mid: [LOW_FREQ_CUTOFF, MID_FREQ_CUTOFF],
        high: [MID_FREQ_CUTOFF, totalPixels > 0 ? round(maxR, 4) : 1.0],
      },
      visualization_data_url: visUrl,
      high_to_low_ratio: round(highToLowRatio, 4),
      spectral_rolloff_85: round(rolloff85, 4),
      azimuthal_spike_ratio: round(azimuthalSpikeRatio, 4),
      region_grid_scores: regionGridScores,
      method_info: methodInfo,
    };

    return {
      name: 'frequency',
      status: 'completed',
      observations: interpretFrequency(details),
      metrics: {
        total_non_dc_power: details.total_non_dc_power,
        low_frequency_power: details.low_frequency_power,
        mid_frequency_power: details.mid_frequency_power,
        high_frequency_power: details.high_frequency_power,
        low_frequency_energy_pct: details.low_frequency_energy_pct,
        mid_frequency_energy_pct: details.mid_frequency_energy_pct,
        high_frequency_energy_pct: details.high_frequency_energy_pct,
        spectral_centroid: details.spectral_centroid,
        spectral_entropy: details.spectral_entropy,
        high_to_low_ratio: details.high_to_low_ratio ?? 0,
        spectral_rolloff_85: details.spectral_rolloff_85 ?? 0,
        azimuthal_spike_ratio: details.azimuthal_spike_ratio ?? 1,
        is_downsampled: details.is_downsampled,
      },
      limitations: frequencyLimitations(isDownsampled, analysisW, analysisH),
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'frequency',
      status: 'failed',
      observations: [`Frequency domain analysis could not be computed: ${msg}`],
      metrics: {},
      limitations: frequencyLimitations(false, 0, 0),
      details: null,
    };
  }
}
