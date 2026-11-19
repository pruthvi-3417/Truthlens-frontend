import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnalyzeResponse,
  MetadataDetails,
  NoiseDetails,
  RecompressionDetails,
  RegionalAnomalyDetails,
  RobustnessDetails,
  SynthesisDetails,
} from '../shared/contracts.ts';
import { validateAnalyzeResponse } from '../shared/validation.ts';
import { createApiApp } from '../server/app.ts';
import { getSettings } from '../server/config.ts';
import { computeSha256 } from '../server/services/hashing.ts';
import {
  computeTopKCellAgreement,
  normalizeGridScores,
} from '../server/services/gridNormalization.ts';

let tempCasesDir = '';
let server: http.Server;
let baseUrl = '';

function buildSmoothGradientRgb(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      buf[idx] = Math.round((x / Math.max(1, width - 1)) * 200) + 25;
      buf[idx + 1] = Math.round((y / Math.max(1, height - 1)) * 180) + 30;
      buf[idx + 2] = Math.round(((x + y) / Math.max(1, width + height - 2)) * 140) + 50;
    }
  }
  return buf;
}

function buildTexturedRgb(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const wave =
        Math.sin(x * 0.14) * 35 +
        Math.cos(y * 0.11) * 30 +
        Math.sin((x + y) * 0.23) * 20;
      const base = 128 + wave;
      buf[idx] = Math.max(0, Math.min(255, Math.round(base + 15)));
      buf[idx + 1] = Math.max(0, Math.min(255, Math.round(base)));
      buf[idx + 2] = Math.max(0, Math.min(255, Math.round(base - 15)));
    }
  }
  return buf;
}

/**
 * Deterministic PRNG for controlled synthetic noise patches
 */
function deterministicPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Builds a minimal valid EXIF APP1 segment (little-endian TIFF) and injects it after JPEG SOI (FF D8).
 */
function injectCustomExifIntoJpeg(
  jpegBuf: Buffer,
  opts: {
    make: string;
    model: string;
    software: string;
    modifyDate: string;
    dateTimeOriginal: string;
    exifWidth: number;
    exifHeight: number;
  },
): Buffer {
  const strBytes = (s: string) => Buffer.from(`${s}\0`, 'ascii');
  const makeB = strBytes(opts.make);
  const modelB = strBytes(opts.model);
  const swB = strBytes(opts.software);
  const modB = strBytes(opts.modifyDate);
  const origB = strBytes(opts.dateTimeOriginal);

  // TIFF offsets relative to TIFF header start
  const ifd0Count = 5;
  const ifd0Offset = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;
  const exifIfdCount = 3;
  const exifIfdSize = 2 + exifIfdCount * 12 + 4;
  let dataCursor = exifIfdOffset + exifIfdSize;

  const allocData = (b: Buffer) => {
    const off = dataCursor;
    dataCursor += b.length;
    return off;
  };

  const makeOff = allocData(makeB);
  const modelOff = allocData(modelB);
  const swOff = allocData(swB);
  const modOff = allocData(modB);
  const origOff = allocData(origB);

  const tiff = Buffer.alloc(dataCursor);
  // TIFF Header: "II", 42, IFD0 offset = 8
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Offset, 4);

  const writeIfdEntry = (
    bufOffset: number,
    tag: number,
    type: number,
    count: number,
    valueOrOffset: number,
  ) => {
    tiff.writeUInt16LE(tag, bufOffset);
    tiff.writeUInt16LE(type, bufOffset + 2);
    tiff.writeUInt32LE(count, bufOffset + 4);
    tiff.writeUInt32LE(valueOrOffset, bufOffset + 8);
  };

  // IFD0
  tiff.writeUInt16LE(ifd0Count, ifd0Offset);
  let p = ifd0Offset + 2;
  writeIfdEntry(p, 0x010f, 2, makeB.length, makeOff); p += 12;
  writeIfdEntry(p, 0x0110, 2, modelB.length, modelOff); p += 12;
  writeIfdEntry(p, 0x0131, 2, swB.length, swOff); p += 12;
  writeIfdEntry(p, 0x0132, 2, modB.length, modOff); p += 12;
  writeIfdEntry(p, 0x8769, 4, 1, exifIfdOffset); p += 12;
  tiff.writeUInt32LE(0, p); // next IFD = 0

  // ExifIFD
  tiff.writeUInt16LE(exifIfdCount, exifIfdOffset);
  let q = exifIfdOffset + 2;
  writeIfdEntry(q, 0x9003, 2, origB.length, origOff); q += 12;
  writeIfdEntry(q, 0xa002, 4, 1, opts.exifWidth); q += 12;
  writeIfdEntry(q, 0xa003, 4, 1, opts.exifHeight); q += 12;
  tiff.writeUInt32LE(0, q);

  makeB.copy(tiff, makeOff);
  modelB.copy(tiff, modelOff);
  swB.copy(tiff, swOff);
  modB.copy(tiff, modOff);
  origB.copy(tiff, origOff);

  const exifHeader = Buffer.from('Exif\0\0', 'ascii');
  const app1PayloadLen = 2 + exifHeader.length + tiff.length;
  const app1Segment = Buffer.alloc(2 + app1PayloadLen);
  app1Segment[0] = 0xff;
  app1Segment[1] = 0xe1;
  app1Segment.writeUInt16BE(app1PayloadLen, 2);
  exifHeader.copy(app1Segment, 4);
  tiff.copy(app1Segment, 4 + exifHeader.length);

  // Insert after SOI (FF D8)
  return Buffer.concat([jpegBuf.subarray(0, 2), app1Segment, jpegBuf.subarray(2)]);
}

async function analyzeBuffer(
  buf: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ status: number; json: AnalyzeResponse }> {
  const form = new FormData();
  form.append('mediaType', 'image');
  form.append('media', new Blob([new Uint8Array(buf)], { type: mimeType }), filename);
  const res = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: form });
  const json = (await res.json()) as AnalyzeResponse;
  return { status: res.status, json };
}

function getModule<T>(resp: AnalyzeResponse, name: string): T {
  const item = resp.analyses.find((a) => a.name === name);
  if (!item) throw new Error(`Missing module ${name}`);
  return item.details as T;
}

beforeAll(async () => {
  tempCasesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-tier-a-'));
  const settings = { ...getSettings(), casesDir: tempCasesDir };
  const { app } = createApiApp({ settings });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempCasesDir, { recursive: true, force: true });
});

describe('Phase 2 Tier A Image Forensics Engine Evaluation', () => {
  it('computes deterministic normalized grid scores and Top-K agreement safely', () => {
    const constant = Array.from({ length: 16 }, (_, i) => ({
      region_id: `r${Math.floor(i / 4)}_c${i % 4}`,
      row: Math.floor(i / 4),
      col: i % 4,
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      raw_value: 5.0,
    }));
    const normConst = normalizeGridScores(constant);
    expect(normConst.every((c) => c.robust_z === 0 && c.normalized_score === 0)).toBe(true);
    expect(computeTopKCellAgreement(normConst, normConst, 3, 1.2).status).toBe(
      'insufficient_contrast',
    );
  });

  it('produces neutral clean behavior on unmodified balanced-spectrum and smooth gradient controls without false manipulation alerts', async () => {
    // 1. Stationary multi-octave broadband texture control -> no_notable_variation
    const W = 256;
    const H = 256;
    const rand = deterministicPrng(1337);
    const makeGrid = (g: number) => Array.from({ length: g * g }, () => rand() - 0.5);
    const sampleGrid = (grid: number[], g: number, x: number, y: number) => {
      const gx = (x / W) * (g - 1);
      const gy = (y / H) * (g - 1);
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(g - 1, x0 + 1);
      const y1 = Math.min(g - 1, y0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const v00 = grid[y0 * g + x0];
      const v10 = grid[y0 * g + x1];
      const v01 = grid[y1 * g + x0];
      const v11 = grid[y1 * g + x1];
      return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    };
    const coarse = makeGrid(16);
    const medium = makeGrid(64);
    const fine = makeGrid(128);
    const balancedRaw = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const idx = (y * W + x) * 3;
        const val =
          128 +
          sampleGrid(coarse, 16, x, y) * 90 +
          sampleGrid(medium, 64, x, y) * 55 +
          sampleGrid(fine, 128, x, y) * 35 +
          (rand() - 0.5) * 14;
        balancedRaw[idx] = Math.max(0, Math.min(255, Math.round(val + 8)));
        balancedRaw[idx + 1] = Math.max(0, Math.min(255, Math.round(val)));
        balancedRaw[idx + 2] = Math.max(0, Math.min(255, Math.round(val - 8)));
      }
    }
    const balancedPng = await sharp(balancedRaw, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer();

    const { status, json } = await analyzeBuffer(balancedPng, 'clean_control.png', 'image/png');
    expect(status).toBe(200);
    expect(validateAnalyzeResponse(json).valid).toBe(true);
    expect(json.analyses).toHaveLength(8);
    expect(json.assessment.status).toBe('COMPLETE');

    const synth = getModule<SynthesisDetails>(json, 'synthesis');
    expect(synth.evidence_summary.relationship).toBe('no_notable_variation');
    expect(synth.spatial_corroboration?.abstained).toBe(false);
    expect(synth.spatial_corroboration?.flat_surprise_regions).toEqual([]);

    // 2. Smooth gradient control -> zero noise/compression/metadata/flat-surprise false positives
    const rawGrad = buildSmoothGradientRgb(256, 256);
    const pngGrad = await sharp(rawGrad, { raw: { width: 256, height: 256, channels: 3 } })
      .png()
      .toBuffer();
    const gradRes = await analyzeBuffer(pngGrad, 'clean_gradient.png', 'image/png');
    const gradSynth = getModule<SynthesisDetails>(gradRes.json, 'synthesis');
    expect(gradSynth.spatial_corroboration?.flat_surprise_regions).toEqual([]);
    expect(gradSynth.domains.find((d) => d.domain_id === 'noise')?.has_notable_variation).toBe(false);
    expect(gradSynth.domains.find((d) => d.domain_id === 'metadata')?.has_notable_variation).toBe(false);
  });

  it('localizes controlled synthetic localized splice inside a smooth region (flat-region surprise)', async () => {
    const W = 256;
    const H = 256;
    const raw = buildSmoothGradientRgb(W, H);
    const rand = deterministicPrng(42);
    // Inject localized high-frequency synthetic grain patch inside region r1_c1 (x=[64..128], y=[64..128])
    for (let y = 74; y < 118; y += 1) {
      for (let x = 74; x < 118; x += 1) {
        const idx = (y * W + x) * 3;
        const jitter = Math.round((rand() - 0.5) * 90);
        raw[idx] = Math.max(0, Math.min(255, raw[idx] + jitter));
        raw[idx + 1] = Math.max(0, Math.min(255, raw[idx + 1] - jitter));
        raw[idx + 2] = Math.max(0, Math.min(255, raw[idx + 2] + jitter));
      }
    }

    const jpegBuf = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    const { status, json } = await analyzeBuffer(jpegBuf, 'spliced_patch.jpg', 'image/jpeg');
    expect(status).toBe(200);
    expect(validateAnalyzeResponse(json).valid).toBe(true);

    const regional = getModule<RegionalAnomalyDetails>(json, 'regional');
    const noise = getModule<NoiseDetails>(json, 'noise');
    const synth = getModule<SynthesisDetails>(json, 'synthesis');

    expect(regional.highest_deviation_region_id).toBe('r1_c1');
    const r1c1Score = noise.region_grid_scores?.find((r) => r.region_id === 'r1_c1');
    expect(r1c1Score?.flag_level).toBe('elevated');
    expect(synth.evidence_summary.relationship).toBe('converging_observations');
    expect(synth.spatial_corroboration?.pairs.length).toBeGreaterThanOrEqual(3);
  });

  it('estimates JPEG DQT quality across Q95, Q80, and Q60 recompression levels accurately', async () => {
    const raw = buildTexturedRgb(192, 192);
    const results: number[] = [];
    for (const q of [95, 80, 60]) {
      const jpg = await sharp(raw, { raw: { width: 192, height: 192, channels: 3 } })
        .jpeg({ quality: q })
        .toBuffer();
      const { json } = await analyzeBuffer(jpg, `tex_q${q}.jpg`, 'image/jpeg');
      const recomp = getModule<RecompressionDetails>(json, 'recompression');
      expect(recomp.jpeg_bitstream.available).toBe(true);
      expect(recomp.jpeg_bitstream.estimated_ijg_quality).not.toBeNull();
      results.push(recomp.jpeg_bitstream.estimated_ijg_quality!);
    }
    expect(results[0]).toBeGreaterThanOrEqual(92);
    expect(results[1]).toBeGreaterThanOrEqual(77);
    expect(results[1]).toBeLessThanOrEqual(83);
    expect(results[2]).toBeGreaterThanOrEqual(57);
    expect(results[2]).toBeLessThanOrEqual(63);
    expect(results[0]).toBeGreaterThan(results[1]);
    expect(results[1]).toBeGreaterThan(results[2]);
  });

  it('detects shifted 8x8 block grid when a JPEG is cropped off-grid and saved losslessly as PNG', async () => {
    // Smooth gradient compressed aggressively at Q45 produces crisp 8x8 quantization steps
    const raw = buildSmoothGradientRgb(272, 272);
    const jpegQ45 = await sharp(raw, { raw: { width: 272, height: 272, channels: 3 } })
      .jpeg({ quality: 45 })
      .toBuffer();
    // Crop by (3, 5) pixels -> 8x8 DCT grid shifts to phase offset (5, 3) mod 8, preserved in PNG
    const shiftedPng = await sharp(jpegQ45)
      .extract({ left: 3, top: 5, width: 256, height: 256 })
      .png()
      .toBuffer();

    const { status, json } = await analyzeBuffer(shiftedPng, 'cropped_from_jpg.png', 'image/png');
    expect(status).toBe(200);
    const recomp = getModule<RecompressionDetails>(json, 'recompression');
    expect(recomp.pixel_block_grid.available).toBe(true);
    expect(recomp.pixel_block_grid.shifted_grid_detected).toBe(true);
    expect(recomp.pixel_block_grid.dominant_offset).toEqual([5, 3]);
    expect(recomp.double_jpeg_indicators.status).toBe('indicators_present');
  });

  it('supports WEBP decoding, filename/container mismatch notice, and resize-reencode robustness checks', async () => {
    const raw = buildTexturedRgb(200, 200);
    const resized = await sharp(raw, { raw: { width: 200, height: 200, channels: 3 } })
      .resize(150, 150)
      .webp({ quality: 85 })
      .toBuffer();

    // Deliberately label WEBP bytes with .png filename
    const { status, json } = await analyzeBuffer(resized, 'misnamed.png', 'image/webp');
    expect(status).toBe(200);
    expect(json.image_properties.format).toBe('WEBP');
    const meta = getModule<MetadataDetails>(json, 'metadata');
    const softCheck = meta.consistency_checks?.find((c) => c.check_id === 'META-SOFTWARE');
    expect(softCheck?.observation).toContain('WEBP');

    const robust = getModule<RobustnessDetails>(json, 'robustness');
    expect(robust.baseline_valid).toBe(true);
    expect(robust.transforms).toHaveLength(3);
    expect(['stable', 'moderately_sensitive', 'fragile']).toContain(robust.overall_stability);
  });

  it('flags EXIF chronology inversion and dimension mismatch while keeping missing EXIF neutral', async () => {
    const raw = buildTexturedRgb(160, 160);
    const baseJpeg = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    const exifJpeg = injectCustomExifIntoJpeg(baseJpeg, {
      make: 'TestCam',
      model: 'TC-1',
      software: 'Adobe Photoshop 25.0',
      modifyDate: '2021:03:01 10:00:00',
      dateTimeOriginal: '2024:08:15 12:00:00',
      exifWidth: 640,
      exifHeight: 480,
    });

    const { status, json } = await analyzeBuffer(exifJpeg, 'exif_inconsistent.jpg', 'image/jpeg');
    expect(status).toBe(200);
    const meta = getModule<MetadataDetails>(json, 'metadata');
    expect(meta.exif_present).toBe(true);
    expect(meta.software).toContain('Photoshop');

    const chrono = meta.consistency_checks?.find((c) => c.check_id === 'META-CHRONOLOGY');
    const dims = meta.consistency_checks?.find((c) => c.check_id === 'META-DIMENSIONS');
    expect(chrono?.status).toBe('inconsistent');
    expect(dims?.status).toBe('inconsistent');

    // Missing EXIF neutral check on clean PNG
    const cleanPng = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } })
      .png()
      .toBuffer();
    const cleanRes = await analyzeBuffer(cleanPng, 'no_exif.png', 'image/png');
    const cleanMetaDomain = getModule<SynthesisDetails>(cleanRes.json, 'synthesis').domains.find(
      (d) => d.domain_id === 'metadata',
    );
    expect(cleanMetaDomain?.has_notable_variation).toBe(false);
  });

  it('abstains cleanly with INCONCLUSIVE assessment on uniform constant-color and tiny <32px images', async () => {
    const uniformJpg = await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 100, g: 120, b: 140 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const uRes = await analyzeBuffer(uniformJpg, 'uniform.jpg', 'image/jpeg');
    expect(uRes.status).toBe(200);
    expect(uRes.json.assessment.status).toBe('INCONCLUSIVE');
    const uSynth = getModule<SynthesisDetails>(uRes.json, 'synthesis');
    expect(uSynth.evidence_summary.relationship).toBe('insufficient_evidence');
    expect(uSynth.spatial_corroboration?.abstained).toBe(true);
    expect(JSON.stringify(uRes.json)).not.toContain('NaN');

    const tinyPng = await sharp(buildTexturedRgb(20, 20), {
      raw: { width: 20, height: 20, channels: 3 },
    })
      .png()
      .toBuffer();

    const tRes = await analyzeBuffer(tinyPng, 'tiny.png', 'image/png');
    expect(tRes.status).toBe(200);
    expect(tRes.json.assessment.status).toBe('INCONCLUSIVE');
    const tRobust = getModule<RobustnessDetails>(tRes.json, 'robustness');
    expect(tRobust.overall_stability).toBe('insufficient_evidence');
    const tSynth = getModule<SynthesisDetails>(tRes.json, 'synthesis');
    expect(tSynth.spatial_corroboration?.abstained).toBe(true);
  });

  it('completes 12MP (4000x3000) JPEG analysis while preserving exact original SHA-256 custody and export/import', async () => {
    const W = 4000;
    const H = 3000;
    const raw = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) {
      const val = Math.round((y / H) * 200) + 20;
      for (let x = 0; x < W; x += 1) {
        const idx = (y * W + x) * 3;
        raw[idx] = val;
        raw[idx + 1] = (val + (x & 31)) & 255;
        raw[idx + 2] = 130;
      }
    }
    const bigJpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 88 })
      .toBuffer();
    const expectedSha = computeSha256(bigJpeg);

    const t0 = Date.now();
    const { status, json } = await analyzeBuffer(bigJpeg, 'benchmark_12mp.jpg', 'image/jpeg');
    const elapsedMs = Date.now() - t0;

    expect(status).toBe(200);
    expect(json.sha256).toBe(expectedSha);
    expect(json.image_properties.pixel_count).toBe(12_000_000);
    expect(json.analyses.every((a) => a.status === 'completed')).toBe(true);
    expect(elapsedMs).toBeLessThan(20_000);
    console.info(`[Benchmark] 12MP (4000x3000) Tier A analysis completed in ${elapsedMs} ms`);

    const verifyRes = await fetch(`${baseUrl}/api/v1/cases/${String(json.case_id)}/verify`);
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      integrity: { valid: boolean; evidence_verifications: Array<{ actual_sha256: string }> };
    };
    expect(verifyBody.integrity.valid).toBe(true);
    expect(verifyBody.integrity.evidence_verifications[0].actual_sha256).toBe(expectedSha);
  }, 30_000);

  it('prevents false shifted-grid alarms on sharp foreground edges and ignores expected single-save ELA dips while detecting Q70->Q90 double compression', async () => {
    // 1. Natural sharp step edge in PNG must not trigger shifted_grid_detected
    const W = 256;
    const H = 256;
    const edgeRaw = buildSmoothGradientRgb(W, H);
    for (let y = 70; y < 122; y += 1) {
      for (let x = 70; x < 122; x += 1) {
        const idx = (y * W + x) * 3;
        edgeRaw[idx] = 245;
        edgeRaw[idx + 1] = 240;
        edgeRaw[idx + 2] = 235;
      }
    }
    const edgePng = await sharp(edgeRaw, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer();
    const edgeRes = await analyzeBuffer(edgePng, 'sharp_edge.png', 'image/png');
    const edgeRecomp = getModule<RecompressionDetails>(edgeRes.json, 'recompression');
    expect(edgeRecomp.pixel_block_grid.shifted_grid_detected).toBe(false);

    // 2. Single-saved Q70 JPEG should NOT trigger ela_curve_non_monotonic at its own Q=70 minimum,
    // whereas Q70 -> Q90 double-compression SHOULD flag a secondary inflection at Q=70.
    const rand = deterministicPrng(99);
    const texRaw = Buffer.alloc(W * H * 3);
    for (let i = 0; i < texRaw.length; i += 1) {
      texRaw[i] = Math.floor(80 + rand() * 100);
    }
    const singleQ70 = await sharp(texRaw, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 70 })
      .toBuffer();
    const singleRes = await analyzeBuffer(singleQ70, 'single_q70.jpg', 'image/jpeg');
    const singleRecomp = getModule<RecompressionDetails>(singleRes.json, 'recompression');
    expect(singleRecomp.jpeg_bitstream.estimated_ijg_quality).toBe(70);
    expect(singleRecomp.double_jpeg_indicators.ela_curve_non_monotonic).toBe(false);

    const doubleQ70Q90 = await sharp(singleQ70).jpeg({ quality: 90 }).toBuffer();
    const doubleRes = await analyzeBuffer(doubleQ70Q90, 'double_q70_q90.jpg', 'image/jpeg');
    const doubleRecomp = getModule<RecompressionDetails>(doubleRes.json, 'recompression');
    expect(doubleRecomp.jpeg_bitstream.estimated_ijg_quality).toBe(90);
    expect(doubleRecomp.double_jpeg_indicators.ela_curve_non_monotonic).toBe(true);
    expect(doubleRecomp.double_jpeg_indicators.ela_curve_inflection_quality).toBe(70);

    // 3. Boundary-straddling splice at (128,128) must not produce false flat_region_surprise on clean top row r0_c*
    const bndRaw = buildSmoothGradientRgb(W, H);
    const rand2 = deterministicPrng(11);
    for (let y = 112; y < 144; y += 1) {
      for (let x = 112; x < 144; x += 1) {
        const idx = (y * W + x) * 3;
        const jit = Math.round((rand2() - 0.5) * 90);
        bndRaw[idx] = Math.max(0, Math.min(255, bndRaw[idx] + jit));
        bndRaw[idx + 1] = Math.max(0, Math.min(255, bndRaw[idx + 1] - jit));
        bndRaw[idx + 2] = Math.max(0, Math.min(255, bndRaw[idx + 2] + jit));
      }
    }
    const bndJpg = await sharp(bndRaw, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const bndRes = await analyzeBuffer(bndJpg, 'boundary_splice.jpg', 'image/jpeg');
    const bndSynth = getModule<SynthesisDetails>(bndRes.json, 'synthesis');
    const cleanRowFlagged = (bndSynth.spatial_corroboration?.flat_surprise_regions ?? []).some((id) =>
      id.startsWith('r0_'),
    );
    expect(cleanRowFlagged).toBe(false);
  });
});
