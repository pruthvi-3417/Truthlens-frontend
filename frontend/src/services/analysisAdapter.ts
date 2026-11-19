import {
  UNCALIBRATED_QUALITATIVE_INFO,
  type CalibrationInfo,
  type CrossDomainRelationship,
  type ELAMultiQualityPoint,
  type EvidenceDomainItem,
  type EvidenceSummary,
  type KeyObservation,
  type MaturityTier,
  type MetadataConsistencyCheck,
  type MethodologyInfo,
  type NormalizedRegionScore,
  type RecompressionDetails,
  type RegionalSynthesis,
  type RobustnessDetails,
  type SynthesisDetails,
  type SynthesisRelationship,
} from '../../../shared/contracts.ts';
import {
  mapRelationshipOrCategoryToUiLabel,
  mapSynthesisRelationshipToCategory,
} from '../../../shared/validation.ts';
import type {
  AnalysisStatus,
  AssessmentDetail,
  CalibrationInfo as FrontCalibrationInfo,
  Finding,
  InvestigationResult,
  MediaType,
  RegionalMeasurement,
} from '../types';

export class AnalysisConnectionError extends Error {
  constructor(message = 'Forensic engine not connected') {
    super(message);
    this.name = 'AnalysisConnectionError';
  }
}

export class AnalysisContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisContractError';
  }
}

export class AnalysisTimeoutError extends Error {
  constructor(message = 'The forensic backend request timed out') {
    super(message);
    this.name = 'AnalysisTimeoutError';
  }
}

export type BackendConnectionStatus =
  | 'configured'
  | 'connected'
  | 'disconnected'
  | 'unknown'
  | 'not-configured';

export interface AnalysisJob {
  jobId: string;
  status: AnalysisStatus;
  statusUrl?: string;
  result?: InvestigationResult;
}

export interface AnalysisSubmission {
  kind: 'result' | 'job';
  result?: InvestigationResult;
  job?: AnalysisJob;
}

export interface AnalysisPayload {
  mediaType: MediaType;
  file?: File;
  text?: string;
  caseId?: string;
  contextText?: string;
}

export interface SubmissionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PollOptions extends SubmissionOptions {
  intervalMs?: number;
  onStatus?: (job: AnalysisJob) => void;
}

const envBackendUrl = (import.meta.env?.VITE_TRUTHLENS_API_URL as string | undefined)
  ?.trim()
  .replace(/\/$/, '');
const backendUrl = envBackendUrl ?? '';
const submissionPath =
  (import.meta.env?.VITE_TRUTHLENS_ANALYSIS_PATH as string | undefined)?.trim() || '/api/v1/analyze';
const imagePath =
  (import.meta.env?.VITE_TRUTHLENS_IMAGE_ANALYSIS_PATH as string | undefined)?.trim() ||
  '/api/v1/analyze';
const videoPath = (import.meta.env?.VITE_TRUTHLENS_VIDEO_ANALYSIS_PATH as string | undefined)?.trim();
const audioPath = (import.meta.env?.VITE_TRUTHLENS_AUDIO_ANALYSIS_PATH as string | undefined)?.trim();
const textPath = (import.meta.env?.VITE_TRUTHLENS_TEXT_ANALYSIS_PATH as string | undefined)?.trim();
const statusPath = (import.meta.env?.VITE_TRUTHLENS_STATUS_PATH as string | undefined)?.trim();
const healthPath =
  (import.meta.env?.VITE_TRUTHLENS_HEALTH_PATH as string | undefined)?.trim() || '/health';
const configuredRequestTimeout = Number(import.meta.env?.VITE_TRUTHLENS_REQUEST_TIMEOUT_MS);
const configuredStatusTimeout = Number(import.meta.env?.VITE_TRUTHLENS_STATUS_TIMEOUT_MS);
const configuredPollInterval = Number(import.meta.env?.VITE_TRUTHLENS_POLL_INTERVAL_MS);

export function isBackendConfigured(): boolean {
  return true;
}

export function getBackendConnectionStatus(): BackendConnectionStatus {
  if (!healthPath) return 'unknown';
  return 'configured';
}

function joinUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = `/${path.replace(/^\//, '')}`;
  return backendUrl ? `${backendUrl}${cleanPath}` : cleanPath;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return response;
  } catch {
    if (controller.signal.aborted && externalSignal?.aborted) {
      throw new DOMException('Request cancelled', 'AbortError');
    }
    throw new AnalysisTimeoutError();
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function getSubmitPath(mediaType: MediaType): string | undefined {
  if (mediaType === 'image') return imagePath || submissionPath;
  if (mediaType === 'video') return videoPath || submissionPath;
  if (mediaType === 'audio') return audioPath || submissionPath;
  return textPath || submissionPath;
}

export async function checkBackendConnection(timeoutMs = 5000): Promise<BackendConnectionStatus> {
  if (!healthPath) return 'unknown';
  try {
    const response = await fetchWithTimeout(joinUrl(healthPath), { method: 'GET' }, timeoutMs);
    return response.ok ? 'connected' : 'disconnected';
  } catch {
    return 'disconnected';
  }
}

const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const asNumberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
};

export function normalizeInvestigation(raw: Record<string, unknown>): InvestigationResult {
  const firstObject = (...values: unknown[]) =>
    values.find((value) => typeof value === 'object' && value !== null && !Array.isArray(value)) as
      | Record<string, unknown>
      | undefined;
  const stringValue = (...values: unknown[]) =>
    values.find((value) => typeof value === 'string') as string | undefined;
  const numberValue = (...values: unknown[]) =>
    values.find((value) => typeof value === 'number') as number | undefined;
  const arrayValue = (...values: unknown[]) =>
    values.find((value) => Array.isArray(value)) as unknown[] | undefined;
  const normalizeStatusValue = (value: unknown): AnalysisStatus => {
    if (value === 'queued' || value === 'pending') return 'pending';
    if (value === 'processing' || value === 'running') return 'running';
    if (value === 'completed' || value === 'ok') return 'completed';
    if (value === 'failed') return 'failed';
    return 'unavailable';
  };

  // Support TruthLens AnalyzeResponse shape (`image_properties`, `analyses[]`, `assessment: { status, summary, limitations }`)
  const analysesArr = Array.isArray(raw.analyses)
    ? raw.analyses.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : undefined;
  const findAnalysis = (name: string) => analysesArr?.find((item) => item.name === name);

  const imagePropsRaw = firstObject(raw.image_properties, raw.imageProperties);
  const metaAnalysis = findAnalysis('metadata');
  const elaAnalysis = findAnalysis('ela');
  const noiseAnalysis = findAnalysis('noise');
  const freqAnalysis = findAnalysis('frequency');
  const recompAnalysis = findAnalysis('recompression');
  const robustAnalysis = findAnalysis('robustness');
  const regionalAnalysis = findAnalysis('regional');
  const synthesisAnalysis = findAnalysis('synthesis');

  const imageRaw = firstObject(
    raw.image,
    raw.imageEvidence,
    raw.image_evidence,
    raw.image_analysis,
    imagePropsRaw,
  );
  const metadataRaw = firstObject(
    raw.metadata,
    raw.exif,
    raw.exif_metadata,
    raw.exifMetadata,
    imageRaw?.metadata,
    imageRaw?.exif,
    metaAnalysis?.details,
  );
  const elaRaw = firstObject(
    raw.ela,
    raw.elaAnalysis,
    raw.ela_analysis,
    imageRaw?.ela,
    elaAnalysis?.details,
  );
  const noiseRaw = firstObject(
    raw.noise,
    raw.noiseResidual,
    raw.noise_residual,
    raw.noiseResidualAnalysis,
    imageRaw?.noise,
    imageRaw?.noiseResidual,
    noiseAnalysis?.details,
  );
  const freqRaw = firstObject(freqAnalysis?.details);
  const recompRaw = firstObject(recompAnalysis?.details);
  const robustRaw = firstObject(robustAnalysis?.details);
  const regionalRaw = firstObject(regionalAnalysis?.details);
  const synthRaw = firstObject(synthesisAnalysis?.details);
  const evidenceRaw = firstObject(
    raw.evidence,
    raw.evidenceInterpretation,
    raw.evidence_interpretation,
    imageRaw?.evidence,
  );

  const orientationVal = metadataRaw?.orientation;
  const normalizedOrientation =
    typeof orientationVal === 'number' || typeof orientationVal === 'string'
      ? orientationVal
      : undefined;

  const exif = metadataRaw
    ? {
        exifPresent:
          typeof metadataRaw.exif_present === 'boolean'
            ? metadataRaw.exif_present
            : typeof metadataRaw.exifPresent === 'boolean'
              ? metadataRaw.exifPresent
              : undefined,
        cameraManufacturer: stringValue(
          metadataRaw.cameraManufacturer,
          metadataRaw.camera_manufacturer,
          metadataRaw.camera_make,
          metadataRaw.make,
        ),
        cameraModel: stringValue(
          metadataRaw.cameraModel,
          metadataRaw.camera_model,
          metadataRaw.model,
        ),
        lens: stringValue(metadataRaw.lens, metadataRaw.lensModel),
        orientation: normalizedOrientation,
        originalTimestamp: stringValue(
          metadataRaw.originalTimestamp,
          metadataRaw.original_timestamp,
          metadataRaw.capture_datetime,
          metadataRaw.dateTimeOriginal,
          metadataRaw.DateTimeOriginal,
        ),
        modificationTimestamp: stringValue(
          metadataRaw.modificationTimestamp,
          metadataRaw.modification_timestamp,
          metadataRaw.digitized_datetime,
          metadataRaw.dateTimeModified,
          metadataRaw.DateTimeModified,
        ),
        colorSpace: stringValue(metadataRaw.colorSpace, metadataRaw.color_space),
        exifVersion: stringValue(metadataRaw.exifVersion, metadataRaw.exif_version),
        editingSoftware: stringValue(
          metadataRaw.editingSoftware,
          metadataRaw.editing_software,
          metadataRaw.software,
        ),
        gpsPresent:
          typeof metadataRaw.gpsPresent === 'boolean'
            ? metadataRaw.gpsPresent
            : typeof metadataRaw.gps_present === 'boolean'
              ? metadataRaw.gps_present
              : typeof metadataRaw.gps !== 'undefined'
                ? metadataRaw.gps !== null
                : undefined,
        gpsFieldsPresent: arrayValue(
          metadataRaw.gpsFieldsPresent,
          metadataRaw.gps_fields_present,
        )?.map(String),
        fieldsFound: arrayValue(metadataRaw.fieldsFound, metadataRaw.fields_found)?.map(String),
        fieldsMissing: arrayValue(metadataRaw.fieldsMissing, metadataRaw.fields_missing)?.map(
          String,
        ),
        parseErrors: arrayValue(metadataRaw.parseErrors, metadataRaw.parse_errors)?.map(String),
        formatNotes: stringValue(metadataRaw.formatNotes, metadataRaw.format_notes),
        embeddedThumbnailPresent:
          typeof metadataRaw.embedded_thumbnail_present === 'boolean'
            ? metadataRaw.embedded_thumbnail_present
            : undefined,
        embeddedThumbnailWidth:
          typeof metadataRaw.embedded_thumbnail_width === 'number' ||
          metadataRaw.embedded_thumbnail_width === null
            ? (metadataRaw.embedded_thumbnail_width as number | null)
            : undefined,
        embeddedThumbnailHeight:
          typeof metadataRaw.embedded_thumbnail_height === 'number' ||
          metadataRaw.embedded_thumbnail_height === null
            ? (metadataRaw.embedded_thumbnail_height as number | null)
            : undefined,
        exifImageWidth:
          typeof metadataRaw.exif_image_width === 'number' ||
          metadataRaw.exif_image_width === null
            ? (metadataRaw.exif_image_width as number | null)
            : undefined,
        exifImageHeight:
          typeof metadataRaw.exif_image_height === 'number' ||
          metadataRaw.exif_image_height === null
            ? (metadataRaw.exif_image_height as number | null)
            : undefined,
        consistencyChecks: Array.isArray(metadataRaw.consistency_checks)
          ? (metadataRaw.consistency_checks as MetadataConsistencyCheck[])
          : undefined,
      }
    : undefined;

  const normalizeRgb = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined;
    const rgb = value as Record<string, unknown>;
    const numeric = (key: string) => (typeof rgb[key] === 'number' ? (rgb[key] as number) : undefined);
    return {
      red: numeric('red') ?? numeric('r'),
      green: numeric('green') ?? numeric('g'),
      blue: numeric('blue') ?? numeric('b'),
      mean: numeric('mean'),
      r: numeric('r'),
      g: numeric('g'),
      b: numeric('b'),
    };
  };

  const normalizeRegions = (value: unknown): RegionalMeasurement[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const obj = item as Record<string, unknown>;
        const row = typeof obj.row === 'number' ? obj.row : undefined;
        const column =
          typeof obj.column === 'number'
            ? obj.column
            : typeof obj.col === 'number'
              ? obj.col
              : undefined;
        const region =
          typeof obj.region === 'string'
            ? obj.region
            : typeof obj.region_id === 'string'
              ? obj.region_id
              : undefined;
        const val =
          typeof obj.value === 'number'
            ? obj.value
            : typeof obj.mean_difference === 'number'
              ? obj.mean_difference
              : typeof obj.deviation_score === 'number'
                ? obj.deviation_score
                : undefined;

        return {
          ...obj,
          row,
          column,
          region,
          x: typeof obj.x === 'number' ? obj.x : undefined,
          y: typeof obj.y === 'number' ? obj.y : undefined,
          width: typeof obj.width === 'number' ? obj.width : undefined,
          height: typeof obj.height === 'number' ? obj.height : undefined,
          value: val,
          variance: typeof obj.variance === 'number' ? obj.variance : undefined,
          std: typeof obj.std === 'number' ? obj.std : undefined,
          maxDifference: typeof obj.max_difference === 'number' ? obj.max_difference : undefined,
          meanLuminance: typeof obj.mean_luminance === 'number' ? obj.mean_luminance : undefined,
          stdLuminance: typeof obj.std_luminance === 'number' ? obj.std_luminance : undefined,
          minLuminance: typeof obj.min_luminance === 'number' ? obj.min_luminance : undefined,
          maxLuminance: typeof obj.max_luminance === 'number' ? obj.max_luminance : undefined,
          meanGradient: typeof obj.mean_gradient === 'number' ? obj.mean_gradient : undefined,
          stdGradient: typeof obj.std_gradient === 'number' ? obj.std_gradient : undefined,
          edgeDensity: typeof obj.edge_density === 'number' ? obj.edge_density : undefined,
          noiseResidualStd:
            typeof obj.noise_residual_std === 'number' || obj.noise_residual_std === null
              ? (obj.noise_residual_std as number | null)
              : undefined,
          noiseMeanAbs:
            typeof obj.noise_mean_abs === 'number' || obj.noise_mean_abs === null
              ? (obj.noise_mean_abs as number | null)
              : undefined,
          elaMean:
            typeof obj.ela_mean === 'number' || obj.ela_mean === null
              ? (obj.ela_mean as number | null)
              : undefined,
          elaVariance:
            typeof obj.ela_variance === 'number' || obj.ela_variance === null
              ? (obj.ela_variance as number | null)
              : undefined,
          regionalFftHighFreqRatio:
            typeof obj.regional_fft_high_freq_ratio === 'number' ||
            obj.regional_fft_high_freq_ratio === null
              ? (obj.regional_fft_high_freq_ratio as number | null)
              : undefined,
          deviationScore: typeof obj.deviation_score === 'number' ? obj.deviation_score : undefined,
          neighborDeviation:
            typeof obj.neighbor_deviation === 'number' ? obj.neighbor_deviation : undefined,
          zScores: asNumberRecord(obj.z_scores),
          familyZScores: asNumberRecord(obj.family_z_scores),
          corroboratingFamiliesCount:
            typeof obj.corroborating_families_count === 'number'
              ? obj.corroborating_families_count
              : undefined,
          flatRegionSurprise:
            typeof obj.flat_region_surprise === 'boolean' ? obj.flat_region_surprise : undefined,
          observation: typeof obj.observation === 'string' ? obj.observation : undefined,
        } satisfies RegionalMeasurement;
      });
  };

  const elaDifference = elaRaw
    ? typeof elaRaw.difference === 'object' && elaRaw.difference !== null
      ? (elaRaw.difference as Record<string, number>)
      : typeof elaRaw.overall === 'object' && elaRaw.overall !== null
        ? (elaRaw.overall as Record<string, number>)
        : typeof elaRaw.mean_difference === 'number'
          ? {
              mean_difference: elaRaw.mean_difference,
              median_difference: Number(elaRaw.median_difference ?? 0),
              max_difference: Number(elaRaw.max_difference ?? 0),
              p95_difference: Number(elaRaw.p95_difference ?? 0),
              p99_difference: Number(elaRaw.p99_difference ?? 0),
            }
          : undefined
    : undefined;

  const ela =
    elaRaw || elaAnalysis
      ? {
          status: normalizeStatusValue(elaRaw?.status ?? elaAnalysis?.status),
          visualizationUrl: stringValue(
            elaRaw?.visualizationUrl,
            elaRaw?.visualization_url,
            elaRaw?.imageUrl,
            elaRaw?.image_url,
            elaRaw?.difference_image_data_url,
          ),
          recompressionQuality: numberValue(elaRaw?.recompression_quality),
          scaleFactor: numberValue(elaRaw?.scale_factor),
          difference: elaDifference,
          thresholdPercentages: asNumberRecord(elaRaw?.threshold_percentages),
          rgb: normalizeRgb(
            elaRaw?.rgb ?? elaRaw?.rgbMeasurements ?? elaRaw?.rgb_measurements ?? elaRaw?.channel_means,
          ),
          channelMaxes: normalizeRgb(elaRaw?.channel_maxes),
          regionalSummary: asNumberRecord(elaRaw?.regional_summary),
          regional: normalizeRegions(
            elaRaw?.regional ??
              elaRaw?.regionalAnalysis ??
              elaRaw?.regional_analysis ??
              elaRaw?.regions ??
              elaRaw?.regional_metrics,
          ),
          multiQualityCurve: Array.isArray(elaRaw?.multi_quality_curve)
            ? (elaRaw.multi_quality_curve as ELAMultiQualityPoint[])
            : undefined,
          regionGridScores: Array.isArray(elaRaw?.region_grid_scores)
            ? (elaRaw.region_grid_scores as NormalizedRegionScore[])
            : undefined,
          observations: arrayValue(elaRaw?.observations, elaAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(elaAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const noiseStats = noiseRaw
    ? typeof noiseRaw.statistics === 'object' && noiseRaw.statistics !== null
      ? (noiseRaw.statistics as Record<string, number>)
      : typeof noiseRaw.measurements === 'object' && noiseRaw.measurements !== null
        ? (noiseRaw.measurements as Record<string, number>)
        : typeof noiseRaw.residual_std === 'number'
          ? {
              residual_mean: Number(noiseRaw.residual_mean ?? 0),
              residual_std: noiseRaw.residual_std,
              mean_absolute_residual: Number(noiseRaw.mean_absolute_residual ?? 0),
              median_absolute_residual: Number(noiseRaw.median_absolute_residual ?? 0),
              max_absolute_residual: Number(noiseRaw.max_absolute_residual ?? 0),
              p95_absolute_residual: Number(noiseRaw.p95_absolute_residual ?? 0),
              p99_absolute_residual: Number(noiseRaw.p99_absolute_residual ?? 0),
            }
          : undefined
    : undefined;

  const noiseSmoothing = noiseRaw
    ? typeof noiseRaw.gaussianSmoothing === 'string' ||
      (typeof noiseRaw.gaussianSmoothing === 'object' && noiseRaw.gaussianSmoothing !== null)
      ? (noiseRaw.gaussianSmoothing as string | Record<string, unknown>)
      : typeof noiseRaw.gaussian_smoothing === 'string' ||
          (typeof noiseRaw.gaussian_smoothing === 'object' && noiseRaw.gaussian_smoothing !== null)
        ? (noiseRaw.gaussian_smoothing as string | Record<string, unknown>)
        : typeof noiseRaw.smoothing_sigma === 'number'
          ? `Gaussian low-pass filter (sigma = ${noiseRaw.smoothing_sigma})`
          : undefined
    : undefined;

  const noise =
    noiseRaw || noiseAnalysis
      ? {
          status: normalizeStatusValue(noiseRaw?.status ?? noiseAnalysis?.status),
          visualizationUrl: stringValue(
            noiseRaw?.visualizationUrl,
            noiseRaw?.visualization_url,
            noiseRaw?.imageUrl,
            noiseRaw?.image_url,
            noiseRaw?.visualization_data_url,
          ),
          smoothingSigma: numberValue(noiseRaw?.smoothing_sigma),
          gaussianSmoothing: noiseSmoothing,
          statistics: noiseStats,
          rgb: normalizeRgb(
            noiseRaw?.rgb ??
              noiseRaw?.rgbMeasurements ??
              noiseRaw?.rgb_measurements ??
              noiseRaw?.channel_mean_absolute_residuals,
          ),
          channelResidualMeans: normalizeRgb(noiseRaw?.channel_residual_means),
          channelResidualStds: normalizeRgb(noiseRaw?.channel_residual_stds),
          flatPixelResidualStd: numberValue(noiseRaw?.flat_pixel_residual_std),
          edgePixelResidualStd: numberValue(noiseRaw?.edge_pixel_residual_std),
          flatToEdgeNoiseRatio: numberValue(noiseRaw?.flat_to_edge_noise_ratio),
          regionalSummary: asNumberRecord(noiseRaw?.regional_summary),
          regional: normalizeRegions(
            noiseRaw?.regional ??
              noiseRaw?.regionalAnalysis ??
              noiseRaw?.regional_analysis ??
              noiseRaw?.regions ??
              noiseRaw?.regional_metrics,
          ),
          regionGridScores: Array.isArray(noiseRaw?.region_grid_scores)
            ? (noiseRaw.region_grid_scores as NormalizedRegionScore[])
            : undefined,
          observations: arrayValue(noiseRaw?.observations, noiseAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(noiseAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const frequency =
    freqRaw || freqAnalysis
      ? {
          status: normalizeStatusValue(freqAnalysis?.status),
          visualizationUrl: stringValue(freqRaw?.visualization_data_url),
          analysisWidth: numberValue(freqRaw?.analysis_width),
          analysisHeight: numberValue(freqRaw?.analysis_height),
          originalWidth: numberValue(freqRaw?.original_width),
          originalHeight: numberValue(freqRaw?.original_height),
          windowFunction: stringValue(freqRaw?.window_function),
          totalNonDcPower: numberValue(freqRaw?.total_non_dc_power),
          lowFrequencyPower: numberValue(freqRaw?.low_frequency_power),
          midFrequencyPower: numberValue(freqRaw?.mid_frequency_power),
          highFrequencyPower: numberValue(freqRaw?.high_frequency_power),
          bandBoundaries:
            freqRaw?.band_boundaries && typeof freqRaw.band_boundaries === 'object'
              ? (freqRaw.band_boundaries as Record<string, number[]>)
              : undefined,
          statistics: freqRaw
            ? {
                low_frequency_energy_pct: Number(freqRaw.low_frequency_energy_pct ?? 0),
                mid_frequency_energy_pct: Number(freqRaw.mid_frequency_energy_pct ?? 0),
                high_frequency_energy_pct: Number(freqRaw.high_frequency_energy_pct ?? 0),
                spectral_centroid: Number(freqRaw.spectral_centroid ?? 0),
                spectral_entropy: Number(freqRaw.spectral_entropy ?? 0),
                ...(typeof freqRaw.high_to_low_ratio === 'number'
                  ? { high_to_low_ratio: freqRaw.high_to_low_ratio }
                  : {}),
                ...(typeof freqRaw.spectral_rolloff_85 === 'number'
                  ? { spectral_rolloff_85: freqRaw.spectral_rolloff_85 }
                  : {}),
                ...(typeof freqRaw.azimuthal_spike_ratio === 'number'
                  ? { azimuthal_spike_ratio: freqRaw.azimuthal_spike_ratio }
                  : {}),
                is_downsampled: Boolean(freqRaw.is_downsampled),
              }
            : undefined,
          observations: arrayValue(freqAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(freqAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const recompression =
    recompRaw || recompAnalysis
      ? {
          status: normalizeStatusValue(recompAnalysis?.status),
          details: recompRaw ? (recompRaw as unknown as RecompressionDetails) : undefined,
          observations: arrayValue(recompAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(recompAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const robustness =
    robustRaw || robustAnalysis
      ? {
          status: normalizeStatusValue(robustAnalysis?.status),
          details: robustRaw ? (robustRaw as unknown as RobustnessDetails) : undefined,
          observations: arrayValue(robustAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(robustAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const regional =
    regionalRaw || regionalAnalysis
      ? {
          status: normalizeStatusValue(regionalAnalysis?.status),
          visualizationUrl: stringValue(regionalRaw?.visualization_data_url),
          gridRows: numberValue(regionalRaw?.grid_rows),
          gridCols: numberValue(regionalRaw?.grid_cols),
          analyzedFeatures: arrayValue(regionalRaw?.analyzed_features)?.map(String),
          activeModulesUsed: arrayValue(regionalRaw?.active_modules_used)?.map(String),
          regionalSummary: asNumberRecord(regionalRaw?.regional_summary),
          statistics: regionalRaw
            ? {
                max_deviation_score: Number(regionalRaw.max_deviation_score ?? 0),
                mean_deviation_score: Number(regionalRaw.mean_deviation_score ?? 0),
                highest_deviation_region_id:
                  typeof regionalRaw.highest_deviation_region_id === 'string'
                    ? regionalRaw.highest_deviation_region_id
                    : null,
                total_regions: Number(regionalRaw.total_regions ?? 16),
              }
            : undefined,
          regional: normalizeRegions(regionalRaw?.regional_anomalies),
          observations: arrayValue(regionalAnalysis?.observations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          limitations: arrayValue(regionalAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : undefined;

  const synthSummary = firstObject(synthRaw?.evidence_summary) as unknown as
    | EvidenceSummary
    | undefined;
  const synthDomains = Array.isArray(synthRaw?.domains)
    ? (synthRaw.domains as EvidenceDomainItem[])
    : undefined;
  const synthCrossRelationships = Array.isArray(synthRaw?.cross_domain_relationships)
    ? (synthRaw.cross_domain_relationships as CrossDomainRelationship[])
    : undefined;
  const synthKeyObs = Array.isArray(synthRaw?.key_observations)
    ? (synthRaw.key_observations as KeyObservation[])
    : undefined;
  const synthRegional = firstObject(synthRaw?.regional_synthesis) as unknown as
    | RegionalSynthesis
    | undefined;
  const synthMethodology = firstObject(synthRaw?.methodology) as unknown as
    | MethodologyInfo
    | undefined;
  const synthSpatialCorrob = firstObject(synthRaw?.spatial_corroboration) as unknown as
    | SynthesisDetails['spatial_corroboration']
    | undefined;

  const mappedEvidence = evidenceRaw
    ? {
        observedIndicators: arrayValue(evidenceRaw.observedIndicators, evidenceRaw.indicators)?.filter(
          (item): item is string => typeof item === 'string',
        ),
        supportingEvidence: arrayValue(
          evidenceRaw.supportingEvidence,
          evidenceRaw.supporting_evidence,
        )?.filter((item): item is string => typeof item === 'string'),
        potentialAnomalies: arrayValue(
          evidenceRaw.potentialAnomalies,
          evidenceRaw.potential_anomalies,
        )?.filter((item): item is string => typeof item === 'string'),
        limitations: arrayValue(evidenceRaw.limitations)?.filter(
          (item): item is string => typeof item === 'string',
        ),
        interpretationNotes: arrayValue(
          evidenceRaw.interpretationNotes,
          evidenceRaw.notes,
        )?.filter((item): item is string => typeof item === 'string'),
      }
    : synthRaw
      ? {
          observedIndicators: synthDomains
            ?.filter((d) => d.status === 'available')
            .map((d) => `${d.domain_name}: ${d.summary}`),
          supportingEvidence: synthCrossRelationships?.map((r) => r.description),
          potentialAnomalies: synthKeyObs?.map((ko) => `${ko.title}: ${ko.description}`),
          limitations: arrayValue(synthRaw.limitations, synthesisAnalysis?.limitations)?.filter(
            (item): item is string => typeof item === 'string',
          ),
          interpretationNotes: [
            ...(synthSummary?.synthesis_statement ? [synthSummary.synthesis_statement] : []),
            ...(synthMethodology?.disclaimer ? [synthMethodology.disclaimer] : []),
          ],
          evidenceSummary: synthSummary,
          domains: synthDomains,
          crossDomainRelationships: synthCrossRelationships,
          keyObservations: synthKeyObs,
          regionalSynthesis: synthRegional,
          methodology: synthMethodology,
          spatialCorroboration: synthSpatialCorrob,
        }
      : undefined;

  const modulesValue = arrayValue(raw.modules, analysesArr);
  const modules = modulesValue
    ? modulesValue
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          name: stringValue(item.name, item.module) ?? 'Unnamed module',
          status: normalizeStatusValue(item.status),
          tier:
            item.tier === 'A' || item.tier === 'B' || item.tier === 'C'
              ? (item.tier as MaturityTier)
              : undefined,
        }))
    : [];

  const shaStr = stringValue(raw.sha256, raw.sha_256, imageRaw?.sha256, imageRaw?.sha_256);
  const filenames = asArray(raw.filenames).length
    ? asArray(raw.filenames)
    : typeof raw.filename === 'string'
      ? [raw.filename]
      : typeof raw.originalFilename === 'string'
        ? [raw.originalFilename]
        : typeof imagePropsRaw?.filename === 'string'
          ? [imagePropsRaw.filename]
          : [];
  const primaryFilename = filenames[0] ?? 'Uploaded image';
  const maturityTier: MaturityTier =
    raw.maturity_tier === 'A' || raw.maturity_tier === 'B' || raw.maturity_tier === 'C'
      ? (raw.maturity_tier as MaturityTier)
      : 'A';
  const rawCalibration = firstObject(raw.calibration) as CalibrationInfo | undefined;
  const calibration: FrontCalibrationInfo = rawCalibration ?? UNCALIBRATED_QUALITATIVE_INFO;

  const findingsSource = arrayValue(raw.findings) ?? (synthKeyObs as unknown[] | undefined);
  const findings: Finding[] = findingsSource
    ? findingsSource
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item, index) => {
          const regionIds = Array.isArray(item.region_ids) ? item.region_ids.map(String) : [];
          const obsText =
            stringValue(item.observation, item.description) ?? 'No observation supplied.';
          const interpText = stringValue(
            item.interpretation,
            item.possibleInterpretation,
            item.neutral_interpretation,
          );
          const limitsList = Array.isArray(item.limitations) ? item.limitations.map(String) : undefined;
          const limitsStr =
            stringValue(item.limitations, item.limitationsText) ??
            (limitsList ? limitsList.join(' ') : undefined);
          return {
            id: stringValue(item.id, item.observation_id) ?? `finding-${index + 1}`,
            title: stringValue(item.title, item.name) ?? 'Backend finding',
            severity:
              typeof item.severity === 'string' ? (item.severity as Finding['severity']) : 'informational',
            module:
              stringValue(item.module, item.relatedModule) ??
              (Array.isArray(item.relevant_domains)
                ? item.relevant_domains.join(', ')
                : 'Evidence synthesis'),
            tier: maturityTier,
            observation: obsText,
            interpretation: interpText,
            evidenceReference:
              stringValue(item.evidenceReference, item.evidence_reference) ??
              (regionIds.length ? `Regions: ${regionIds.join(', ')}` : undefined),
            limitations: limitsStr,
            flaggedEvidence: `${primaryFilename} (${regionIds.length ? regionIds.join(', ') : 'Image-wide'})`,
            indicator: obsText,
            crossModalContext:
              synthSummary?.synthesis_statement ??
              'Single-image multi-domain synthesis (cross-modal requires multi-item case).',
            confidence: calibration.label,
            calibrationLabel: calibration.label,
            sourceTrace: shaStr ? `sha256:${shaStr.slice(0, 16)}…` : primaryFilename,
            summary: interpText ?? obsText,
            limitationsList: limitsList,
          };
        })
    : [];

  const width = numberValue(
    raw.width,
    raw.imageWidth,
    raw.image_width,
    imageRaw?.width,
    imageRaw?.imageWidth,
    imageRaw?.image_width,
  );
  const height = numberValue(
    raw.height,
    raw.imageHeight,
    raw.image_height,
    imageRaw?.height,
    imageRaw?.imageHeight,
    imageRaw?.image_height,
  );

  const assessmentRawObj =
    typeof raw.assessment === 'object' && raw.assessment !== null
      ? (raw.assessment as Record<string, unknown>)
      : undefined;
  const overallStatus =
    assessmentRawObj?.status === 'COMPLETE' || raw.success === true
      ? 'completed'
      : normalizeStatusValue(raw.analysisStatus ?? raw.status ?? imageRaw?.status);

  const caseId = stringValue(raw.case_id, raw.caseId);
  const evidenceId = stringValue(raw.evidence_id, raw.evidenceId);
  const auditHeadHash = stringValue(raw.audit_head_hash, raw.auditHeadHash);

  const imageEvidence =
    imageRaw || ela || noise || exif
      ? {
          status: overallStatus,
          caseId,
          evidenceId,
          auditHeadHash,
          originalImageUrl: stringValue(
            raw.originalImageUrl,
            raw.original_image_url,
            raw.fileUrl,
            raw.file_url,
            imageRaw?.originalImageUrl,
            imageRaw?.original_image_url,
          ),
          fileFormat: stringValue(
            raw.fileFormat,
            raw.file_format,
            raw.format,
            imageRaw?.fileFormat,
            imageRaw?.format,
          ),
          mimeType: stringValue(imageRaw?.mime_type, imageRaw?.mimeType),
          fileSize: numberValue(
            raw.fileSize,
            raw.file_size,
            imageRaw?.fileSize,
            imageRaw?.file_size,
            imageRaw?.size_bytes,
          ),
          sizeReadable: stringValue(imageRaw?.size_readable, imageRaw?.sizeReadable),
          width,
          height,
          aspectRatio: numberValue(imageRaw?.aspect_ratio, imageRaw?.aspectRatio),
          pixelCount: numberValue(imageRaw?.pixel_count, imageRaw?.pixelCount),
          mode: stringValue(imageRaw?.mode),
          hasTransparency:
            typeof imageRaw?.has_transparency === 'boolean' ? imageRaw.has_transparency : undefined,
          resolution:
            stringValue(raw.resolution, imageRaw?.resolution) ??
            (width && height ? `${width} × ${height}` : undefined),
          sha256: shaStr,
          exif,
          ela,
          noise,
          frequency,
          recompression,
          robustness,
          regional,
          frequencyStatus: normalizeStatusValue(freqAnalysis?.status),
          recompressionStatus: normalizeStatusValue(recompAnalysis?.status),
          robustnessStatus: normalizeStatusValue(robustAnalysis?.status),
          regionalStatus: normalizeStatusValue(regionalAnalysis?.status),
          evidenceStatus: normalizeStatusValue(
            synthesisAnalysis?.status ?? (evidenceRaw ? 'completed' : 'unavailable'),
          ),
          evidence: mappedEvidence,
        }
      : undefined;

  const relationship =
    (assessmentRawObj?.relationship as SynthesisRelationship | undefined) ??
    synthSummary?.relationship;
  const assessmentCategory = mapSynthesisRelationshipToCategory(relationship);

  let mappedAssessment: InvestigationResult['assessment'];
  if (typeof raw.assessment === 'string') {
    mappedAssessment = raw.assessment as InvestigationResult['assessment'];
  } else {
    mappedAssessment = mapRelationshipOrCategoryToUiLabel(relationship);
  }

  const assessmentDetail: AssessmentDetail = {
    status:
      assessmentRawObj?.status === 'INCOMPLETE' ||
      assessmentRawObj?.status === 'INCONCLUSIVE' ||
      assessmentRawObj?.status === 'COMPLETE'
        ? assessmentRawObj.status
        : 'COMPLETE',
    label: mappedAssessment ?? 'INCONCLUSIVE',
    category: assessmentCategory,
    relationship,
    summary:
      stringValue(assessmentRawObj?.summary, synthSummary?.synthesis_statement) ??
      'Backend-provided assessment completed.',
    limitations: arrayValue(assessmentRawObj?.limitations, synthRaw?.limitations)?.map(String) ?? [],
    maturityTier,
    calibration,
  };

  return {
    id:
      stringValue(raw.id, raw.investigationId, raw.investigation_id, caseId) ??
      (shaStr ? `TL-${shaStr.slice(0, 12)}` : undefined),
    schemaVersion: stringValue(raw.schema_version, raw.schemaVersion),
    caseId,
    evidenceId,
    auditHeadHash,
    maturityTier,
    calibration,
    filenames,
    mediaTypes: Array.isArray(raw.mediaTypes)
      ? (raw.mediaTypes as InvestigationResult['mediaTypes'])
      : imageRaw
        ? ['image']
        : [],
    timestamp:
      stringValue(
        raw.analysis_timestamp,
        raw.timestamp,
        raw.createdAt,
        raw.created_at,
        raw.analysisTimestamp,
      ) ?? new Date().toISOString(),
    sha256: shaStr ? [shaStr] : Array.isArray(raw.sha256) ? asArray(raw.sha256) : [],
    fileFormat: stringValue(
      raw.fileFormat,
      raw.file_format,
      raw.format,
      imageRaw?.fileFormat,
      imageRaw?.format,
    ),
    fileSize: numberValue(
      raw.fileSize,
      raw.file_size,
      imageRaw?.fileSize,
      imageRaw?.file_size,
      imageRaw?.size_bytes,
    ),
    imageProperties: imagePropsRaw
      ? {
          width,
          height,
          format: stringValue(imagePropsRaw.format),
          size: numberValue(imagePropsRaw.size_bytes),
          mimeType: stringValue(imagePropsRaw.mime_type),
          sizeReadable: stringValue(imagePropsRaw.size_readable),
          aspectRatio: numberValue(imagePropsRaw.aspect_ratio),
          pixelCount: numberValue(imagePropsRaw.pixel_count),
          mode: stringValue(imagePropsRaw.mode),
          hasTransparency:
            typeof imagePropsRaw.has_transparency === 'boolean'
              ? imagePropsRaw.has_transparency
              : undefined,
        }
      : undefined,
    analysisStatus: overallStatus,
    imageEvidence,
    assessment: mappedAssessment,
    assessmentDetail,
    modules,
    findings,
  };
}

function normalizeStatus(value: unknown): AnalysisStatus {
  if (
    value === 'pending' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'unavailable'
  ) {
    if (value === 'queued') return 'pending';
    if (value === 'processing') return 'running';
    return value;
  }
  return 'unavailable';
}

export function normalizeAnalysisJob(raw: Record<string, unknown>, statusUrl?: string): AnalysisJob {
  const jobIdValue = raw.jobId ?? raw.job_id ?? raw.id;
  if (typeof jobIdValue !== 'string' && typeof jobIdValue !== 'number') {
    throw new AnalysisContractError('Backend response did not provide a job ID.');
  }
  return {
    jobId: String(jobIdValue),
    status: normalizeStatus(raw.status ?? raw.state),
    statusUrl:
      typeof raw.statusUrl === 'string'
        ? raw.statusUrl
        : typeof raw.status_url === 'string'
          ? raw.status_url
          : statusUrl,
  };
}

export async function submitImage(
  payload: Omit<AnalysisPayload, 'mediaType'> & { file: File },
  options: SubmissionOptions = {},
) {
  return submitAnalysis({ ...payload, mediaType: 'image' }, options);
}

export async function submitVideo(
  payload: Omit<AnalysisPayload, 'mediaType'> & { file: File },
  options: SubmissionOptions = {},
) {
  return submitAnalysis({ ...payload, mediaType: 'video' }, options);
}

export async function submitAudio(
  payload: Omit<AnalysisPayload, 'mediaType'> & { file: File },
  options: SubmissionOptions = {},
) {
  return submitAnalysis({ ...payload, mediaType: 'audio' }, options);
}

export async function submitText(
  payload: Omit<AnalysisPayload, 'mediaType'> & { text: string },
  options: SubmissionOptions = {},
) {
  return submitAnalysis({ ...payload, mediaType: 'text' }, options);
}

export async function submitAnalysis(
  payload: AnalysisPayload,
  options: SubmissionOptions = {},
): Promise<AnalysisSubmission> {
  const path = getSubmitPath(payload.mediaType);
  if (!path) {
    throw new AnalysisContractError(
      'Analysis submission endpoint is not configured. Set VITE_TRUTHLENS_ANALYSIS_PATH or a media-specific analysis path.',
    );
  }

  const form = new FormData();
  form.append('mediaType', payload.mediaType);
  if (payload.file) form.append('media', payload.file);
  if (payload.text) form.append('text', payload.text);
  if (payload.caseId) form.append('caseId', payload.caseId);
  if (payload.contextText) form.append('contextText', payload.contextText);

  const response = await fetchWithTimeout(
    joinUrl(path),
    { method: 'POST', body: form },
    options.timeoutMs ??
      (Number.isFinite(configuredRequestTimeout) && configuredRequestTimeout > 0
        ? configuredRequestTimeout
        : 30000),
    options.signal,
  );
  if (!response.ok) {
    let detail = `Backend request failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      if (errBody?.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore JSON parse errors */
    }
    throw new Error(detail);
  }
  const raw = (await response.json()) as Record<string, unknown>;

  const jobId = raw.jobId ?? raw.job_id;
  const statusUrl =
    typeof raw.statusUrl === 'string'
      ? raw.statusUrl
      : typeof raw.status_url === 'string'
        ? raw.status_url
        : undefined;
  if (jobId !== undefined || statusUrl) {
    return { kind: 'job', job: normalizeAnalysisJob(raw, statusUrl) };
  }

  return { kind: 'result', result: normalizeInvestigation(raw) };
}

export async function submitInvestigation(
  payload: AnalysisPayload,
  signal?: AbortSignal,
): Promise<InvestigationResult> {
  const submission = await submitAnalysis(payload, { signal });
  if (submission.kind === 'result' && submission.result) return submission.result;
  if (submission.kind === 'job' && submission.job) {
    throw new AnalysisContractError(
      'Backend returned an asynchronous job. Use polling with submitAnalysis and pollAnalysisJob.',
    );
  }
  throw new AnalysisContractError('Backend response did not contain a result or job.');
}

export function buildStatusUrl(job: AnalysisJob): string | undefined {
  if (job.statusUrl) return joinUrl(job.statusUrl);
  if (!statusPath) return undefined;
  return joinUrl(statusPath.replace('{jobId}', encodeURIComponent(job.jobId)));
}

export async function pollAnalysisJob(
  job: AnalysisJob,
  options: PollOptions = {},
): Promise<AnalysisJob> {
  const url = buildStatusUrl(job);
  if (!url) {
    throw new AnalysisContractError(
      'Job status endpoint is not configured. Set VITE_TRUTHLENS_STATUS_PATH or return a status URL from submission.',
    );
  }

  const interval =
    options.intervalMs ??
    (Number.isFinite(configuredPollInterval) && configuredPollInterval > 0
      ? configuredPollInterval
      : 1500);
  let current = job;
  while (current.status === 'pending' || current.status === 'running') {
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        cleanup();
        resolve();
      }, interval);
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const abort = () => {
        globalThis.clearTimeout(timer);
        cleanup();
        reject(new DOMException('Polling cancelled', 'AbortError'));
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
    const response = await fetchWithTimeout(
      url,
      { method: 'GET' },
      options.timeoutMs ??
        (Number.isFinite(configuredStatusTimeout) && configuredStatusTimeout > 0
          ? configuredStatusTimeout
          : 10000),
      options.signal,
    );
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    const raw = (await response.json()) as Record<string, unknown>;
    current = normalizeAnalysisJob(raw, url);

    const resultValue = raw.result;
    if (current.status === 'completed' && typeof resultValue === 'object' && resultValue !== null) {
      current.result = normalizeInvestigation(resultValue as Record<string, unknown>);
    }
    options.onStatus?.(current);
  }

  return current;
}
