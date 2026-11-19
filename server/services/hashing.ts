import { createHash, timingSafeEqual } from 'node:crypto';
import type { Modality } from '../../shared/contracts.ts';

export function computeSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface Sha256VerificationResult {
  valid: boolean;
  expected_sha256: string;
  actual_sha256: string;
}

export function verifySha256(data: Buffer, expectedSha256: string): Sha256VerificationResult {
  const actual = computeSha256(data);
  const normalizedExpected = expectedSha256.trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalizedExpected)) {
    return {
      valid: false,
      expected_sha256: expectedSha256,
      actual_sha256: actual,
    };
  }

  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(normalizedExpected, 'hex');
  const valid = a.length === b.length && timingSafeEqual(a, b);
  return {
    valid,
    expected_sha256: normalizedExpected,
    actual_sha256: actual,
  };
}

/**
 * Deterministic JSON canonicalizer (sorts object keys lexicographically at every depth)
 * so cryptographic hashes over structured objects are invariant to key insertion order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeCanonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf-8').digest('hex');
}

export interface SniffedMediaType {
  sniffed_mime: string;
  detected_format: string;
  inferred_modality: Modality | null;
}

export function sniffMimeAndFormat(
  data: Buffer,
  filename?: string | null,
  declaredMime?: string | null,
): SniffedMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { sniffed_mime: 'image/jpeg', detected_format: 'JPEG', inferred_modality: 'image' };
  }

  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { sniffed_mime: 'image/png', detected_format: 'PNG', inferred_modality: 'image' };
  }

  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { sniffed_mime: 'image/webp', detected_format: 'WEBP', inferred_modality: 'image' };
  }

  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { sniffed_mime: 'audio/wav', detected_format: 'WAV', inferred_modality: 'audio' };
  }

  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('ascii');
    if (brand === 'M4A ' || brand === 'M4B ') {
      return { sniffed_mime: 'audio/mp4', detected_format: 'M4A', inferred_modality: 'audio' };
    }
    if (brand === 'qt  ') {
      return { sniffed_mime: 'video/quicktime', detected_format: 'MOV', inferred_modality: 'video' };
    }
    return { sniffed_mime: 'video/mp4', detected_format: 'MP4', inferred_modality: 'video' };
  }

  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return { sniffed_mime: 'video/webm', detected_format: 'WEBM', inferred_modality: 'video' };
  }

  if (
    (data.length >= 3 && data.subarray(0, 3).toString('ascii') === 'ID3') ||
    (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  ) {
    return { sniffed_mime: 'audio/mpeg', detected_format: 'MP3', inferred_modality: 'audio' };
  }

  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS') {
    return { sniffed_mime: 'audio/ogg', detected_format: 'OGG', inferred_modality: 'audio' };
  }

  // Detect printable UTF-8 text if no binary NUL bytes
  const sample = data.subarray(0, Math.min(data.length, 4096));
  const hasNul = sample.includes(0x00);
  if (!hasNul && sample.length > 0) {
    const ext = filename?.split('.').pop()?.toLowerCase();
    if (ext === 'txt' || declaredMime?.startsWith('text/')) {
      return { sniffed_mime: 'text/plain', detected_format: 'TXT', inferred_modality: 'text' };
    }
  }

  return {
    sniffed_mime: 'application/octet-stream',
    detected_format: 'UNKNOWN',
    inferred_modality: null,
  };
}
