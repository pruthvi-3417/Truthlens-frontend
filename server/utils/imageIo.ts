import sharp from 'sharp';
import type { Settings } from '../config.ts';
import { PayloadTooLargeError, ValidationFailedError } from '../errors.ts';
import { sniffMimeAndFormat } from '../services/hashing.ts';

export interface GridTile {
  row: number;
  col: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  regionId: string;
}

export interface DecodedImage {
  filename: string | null;
  format: 'JPEG' | 'PNG' | 'WEBP';
  mimeType: string;
  sizeBytes: number;
  sizeReadable: string;
  width: number;
  height: number;
  aspectRatio: number;
  pixelCount: number;
  mode: string;
  hasTransparency: boolean;
  rgbPixels: Uint8Array;
  isProgressive: boolean;
  chromaSubsampling: string | null;
  hasIccProfile: boolean;
  exifOrientationTag: number | null;
  luminanceMean: number;
  luminanceStd: number;
  dynamicRange: number;
  isUniformContent: boolean;
  isSmallImage: boolean;
  containerNotes: string[];
}

const FORMAT_TO_MIME: Record<string, string> = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
};

export function mimeForFormat(imageFormat: string | null | undefined): string | null {
  if (!imageFormat) return null;
  return FORMAT_TO_MIME[imageFormat.toUpperCase()] ?? null;
}

export function formatBytes(numBytes: number): string {
  if (numBytes < 0) throw new Error('numBytes must be non-negative');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = numBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.trunc(size)} B`;
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function partitionGrid(
  width: number,
  height: number,
  gridRows: number,
  gridCols: number,
): GridTile[] {
  const rows = Math.max(1, gridRows);
  const cols = Math.max(1, gridCols);
  const rowHeight = height / rows;
  const colWidth = width / cols;
  const tiles: GridTile[] = [];

  for (let r = 0; r < rows; r += 1) {
    const y1 = Math.round(r * rowHeight);
    const y2 = r === rows - 1 ? height : Math.round((r + 1) * rowHeight);
    for (let c = 0; c < cols; c += 1) {
      const x1 = Math.round(c * colWidth);
      const x2 = c === cols - 1 ? width : Math.round((c + 1) * colWidth);
      tiles.push({
        row: r,
        col: c,
        x1,
        y1,
        x2,
        y2,
        regionId: `r${r}_c${c}`,
      });
    }
  }
  return tiles;
}

function computeSignalStats(rgbPixels: Uint8Array, totalPixels: number) {
  if (totalPixels <= 0) {
    return { mean: 0, std: 0, dynamicRange: 0, isUniformContent: true };
  }
  let sum = 0;
  let sqSum = 0;
  let minLum = 255;
  let maxLum = 0;

  for (let p = 0; p < totalPixels; p += 1) {
    const idx = p * 3;
    const lum = 0.299 * rgbPixels[idx] + 0.587 * rgbPixels[idx + 1] + 0.114 * rgbPixels[idx + 2];
    sum += lum;
    sqSum += lum * lum;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  const mean = sum / totalPixels;
  const variance = Math.max(0, sqSum / totalPixels - mean * mean);
  const std = Math.sqrt(variance);
  const dynamicRange = Math.max(0, maxLum - minLum);
  const isUniformContent = dynamicRange < 2.0 || std < 0.5;
  return { mean, std, dynamicRange, isUniformContent };
}

export async function validateAndDecodeImage(
  data: Buffer,
  options: {
    filename: string | null;
    declaredContentType?: string | null;
    settings: Settings;
  },
): Promise<DecodedImage> {
  const { filename, declaredContentType, settings } = options;

  if (!data || data.length === 0) {
    throw new ValidationFailedError('Empty file rejected.', 'empty_file');
  }

  if (data.length > settings.maxUploadBytes) {
    throw new PayloadTooLargeError(
      `File exceeds the maximum upload size of ${formatBytes(settings.maxUploadBytes)}.`,
    );
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(data, { limitInputPixels: settings.maxPixelCount }).metadata();
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('pixel limit') || msg.includes('exceeds')) {
      throw new ValidationFailedError(
        `Image exceeds the maximum allowed pixel count (${settings.maxPixelCount.toLocaleString()} pixels).`,
        'decompression_bomb',
      );
    }
    throw new ValidationFailedError('File is not a recognized image format.', 'unrecognized_image');
  }

  let imageFormat = (metadata.format || '').toUpperCase();
  if (imageFormat === 'JPG') imageFormat = 'JPEG';

  if (imageFormat !== 'JPEG' && imageFormat !== 'PNG' && imageFormat !== 'WEBP') {
    throw new ValidationFailedError(
      `Unsupported image format '${imageFormat || 'unknown'}'. Supported formats: JPEG, PNG, WEBP.`,
      'unsupported_format',
    );
  }

  const mimeType = mimeForFormat(imageFormat);
  if (!mimeType) {
    throw new ValidationFailedError(
      'Unable to determine MIME type for the decoded image.',
      'unsupported_format',
    );
  }

  const containerNotes: string[] = [];
  const sniffed = sniffMimeAndFormat(data, filename, declaredContentType);
  if (sniffed.detected_format !== 'UNKNOWN' && sniffed.detected_format !== imageFormat) {
    containerNotes.push(
      `Bitstream magic header (${sniffed.detected_format}) differs from container decoder label (${imageFormat}).`,
    );
  }
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (
      ext &&
      ((imageFormat === 'JPEG' && ext !== 'jpg' && ext !== 'jpeg') ||
        (imageFormat === 'PNG' && ext !== 'png') ||
        (imageFormat === 'WEBP' && ext !== 'webp'))
    ) {
      containerNotes.push(
        `Filename extension '.${ext}' does not match verified pixel container format '${imageFormat}'.`,
      );
    }
  }

  if (declaredContentType) {
    const normalized = declaredContentType.split(';')[0].trim().toLowerCase();
    if (
      normalized &&
      normalized !== 'application/octet-stream' &&
      normalized !== mimeType &&
      (normalized.startsWith('text/') ||
        normalized === 'application/json' ||
        normalized === 'application/xml' ||
        normalized === 'application/pdf' ||
        normalized === 'image/svg+xml')
    ) {
      throw new ValidationFailedError(
        `Declared content type '${normalized}' is not a supported image type.`,
        'mime_mismatch',
      );
    }
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new ValidationFailedError('Image dimensions must be positive.', 'invalid_dimensions');
  }

  if (width > settings.maxImageDimension || height > settings.maxImageDimension) {
    throw new ValidationFailedError(
      `Image dimensions ${width}x${height} exceed the maximum allowed dimension of ${settings.maxImageDimension} pixels.`,
      'dimension_limit',
    );
  }

  const pixelCount = width * height;
  if (pixelCount > settings.maxPixelCount) {
    throw new ValidationFailedError(
      `Image pixel count ${pixelCount.toLocaleString()} exceeds the maximum allowed ${settings.maxPixelCount.toLocaleString()} pixels.`,
      'pixel_limit',
    );
  }

  let rgbBuffer: Buffer;
  let decodedWidth = width;
  let decodedHeight = height;
  try {
    const decoded = await sharp(data, { limitInputPixels: settings.maxPixelCount })
      .removeAlpha()
      .toColorspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    rgbBuffer = decoded.data;
    decodedWidth = decoded.info.width;
    decodedHeight = decoded.info.height;
  } catch {
    throw new ValidationFailedError('Image data is corrupt or could not be decoded.', 'corrupt_image');
  }

  const hasTransparency = Boolean(metadata.hasAlpha);
  const channels: number = metadata.channels ?? 3;
  const mode = channels === 4 ? 'RGBA' : channels === 1 ? 'L' : 'RGB';
  const rgbPixels = new Uint8Array(rgbBuffer.buffer, rgbBuffer.byteOffset, rgbBuffer.byteLength);
  const decodedPixelCount = decodedWidth * decodedHeight;
  const stats = computeSignalStats(rgbPixels, decodedPixelCount);
  const isSmallImage = decodedWidth < 32 || decodedHeight < 32;

  return {
    filename,
    format: imageFormat,
    mimeType,
    sizeBytes: data.length,
    sizeReadable: formatBytes(data.length),
    width: decodedWidth,
    height: decodedHeight,
    aspectRatio: decodedWidth / decodedHeight,
    pixelCount: decodedPixelCount,
    mode,
    hasTransparency,
    rgbPixels,
    isProgressive: Boolean(metadata.isProgressive),
    chromaSubsampling: metadata.chromaSubsampling ?? null,
    hasIccProfile: Boolean(metadata.icc),
    exifOrientationTag: typeof metadata.orientation === 'number' ? metadata.orientation : null,
    luminanceMean: Math.round(stats.mean * 1000) / 1000,
    luminanceStd: Math.round(stats.std * 1000) / 1000,
    dynamicRange: Math.round(stats.dynamicRange * 1000) / 1000,
    isUniformContent: stats.isUniformContent,
    isSmallImage,
    containerNotes,
  };
}
