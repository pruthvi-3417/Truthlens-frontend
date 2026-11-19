import path from 'node:path';

export interface Settings {
  appName: string;
  appVersion: string;
  debug: boolean;
  corsOrigins: string[];
  casesDir: string;
  maxUploadBytes: number;
  maxImageDimension: number;
  maxPixelCount: number;
  elaDefaultQuality: number;
  noiseDefaultSigma: number;
  fftMaxDimension: number;
  regionalGridRows: number;
  regionalGridCols: number;
  regionalEdgeThreshold: number;
  supportedFormats: readonly string[];
}

function parseIntEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseFloatEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseDebugEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['true', '1', 'yes', 'on', 'debug', 'dev', 'development'].includes(raw.toLowerCase());
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    return [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getSettings(): Settings {
  return {
    appName: process.env.APP_NAME?.trim() || 'TruthLens',
    appVersion: process.env.APP_VERSION?.trim() || '1.0.0',
    debug: parseDebugEnv(process.env.DEBUG),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    casesDir: process.env.TRUTHLENS_CASES_DIR?.trim()
      ? path.resolve(process.env.TRUTHLENS_CASES_DIR.trim())
      : path.resolve('workspace/cases'),
    maxUploadBytes: parseIntEnv('MAX_UPLOAD_BYTES', 15 * 1024 * 1024, 1024, 250 * 1024 * 1024),
    maxImageDimension: parseIntEnv('MAX_IMAGE_DIMENSION', 12000, 64, 50000),
    maxPixelCount: parseIntEnv('MAX_PIXEL_COUNT', 40_000_000, 1000, 200_000_000),
    elaDefaultQuality: parseIntEnv('ELA_DEFAULT_QUALITY', 90, 1, 100),
    noiseDefaultSigma: parseFloatEnv('NOISE_DEFAULT_SIGMA', 1.0, 0.3, 50.0),
    fftMaxDimension: parseIntEnv('FFT_MAX_DIMENSION', 1024, 64, 12000),
    regionalGridRows: parseIntEnv('REGIONAL_GRID_ROWS', 4, 1, 16),
    regionalGridCols: parseIntEnv('REGIONAL_GRID_COLS', 4, 1, 16),
    regionalEdgeThreshold: parseFloatEnv('REGIONAL_EDGE_THRESHOLD', 15.0, 1.0, 255.0),
    supportedFormats: ['JPEG', 'PNG', 'WEBP'],
  };
}
