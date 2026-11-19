import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../server/app.ts';
import { getSettings } from '../server/config.ts';

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: typeof Ajv2020Import }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: (ajv: unknown) => void }).default ??
  (addFormatsImport as unknown as (ajv: unknown) => void);

const analyzeSchema = JSON.parse(
  fs.readFileSync(path.resolve('docs/schemas/analyze_response.v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;
const manifestSchema = JSON.parse(
  fs.readFileSync(path.resolve('docs/schemas/case_manifest.v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;

const realSample = JSON.parse(
  fs.readFileSync(path.resolve('docs/samples/analyze_response.real.json'), 'utf-8'),
) as Record<string, unknown>;
const exampleManifest = JSON.parse(
  fs.readFileSync(path.resolve('docs/samples/case_manifest.example.json'), 'utf-8'),
) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateAnalyzeSchema = ajv.compile(analyzeSchema);
const validateManifestSchema = ajv.compile(manifestSchema);

let tempCasesDir = '';
let server: http.Server;
let baseUrl = '';

async function buildGradientRgbBuffer(width: number, height: number): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      buf[idx] = Math.round((x / Math.max(1, width - 1)) * 220) + 15;
      buf[idx + 1] = Math.round((y / Math.max(1, height - 1)) * 200) + 20;
      buf[idx + 2] = 128;
    }
  }
  return buf;
}

beforeAll(async () => {
  tempCasesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-schema-'));
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

describe('JSON Schema Validation (AJV Draft 2020-12)', () => {
  it('validates docs/samples/analyze_response.real.json against analyze_response.v1.schema.json', () => {
    const ok = validateAnalyzeSchema(realSample);
    expect(validateAnalyzeSchema.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('validates docs/samples/case_manifest.example.json against case_manifest.v1.schema.json', () => {
    const ok = validateManifestSchema(exampleManifest);
    expect(validateManifestSchema.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('validates live POST /api/v1/analyze and GET /export responses across JPEG, PNG, and WEBP against v1 JSON schemas', async () => {
    const raw = await buildGradientRgbBuffer(160, 160);
    const jpegBuf = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const pngBuf = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } })
      .png()
      .toBuffer();
    const webpBuf = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } })
      .webp({ quality: 88 })
      .toBuffer();

    const fixtures = [
      { buf: jpegBuf, mime: 'image/jpeg', name: 'gradient.jpg' },
      { buf: pngBuf, mime: 'image/png', name: 'gradient.png' },
      { buf: webpBuf, mime: 'image/webp', name: 'gradient.webp' },
    ];

    for (const fx of fixtures) {
      const form = new FormData();
      form.append('mediaType', 'image');
      form.append('media', new Blob([new Uint8Array(fx.buf)], { type: fx.mime }), fx.name);

      const res = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: form });
      expect(res.status).toBe(200);
      const analyzeJson = (await res.json()) as Record<string, unknown>;

      const validAnalyze = validateAnalyzeSchema(analyzeJson);
      expect(validateAnalyzeSchema.errors ?? []).toEqual([]);
      expect(validAnalyze).toBe(true);

      const exportRes = await fetch(
        `${baseUrl}/api/v1/cases/${String(analyzeJson.case_id)}/export?includeOriginals=true`,
      );
      expect(exportRes.status).toBe(200);
      const manifestJson = (await exportRes.json()) as Record<string, unknown>;

      const validManifest = validateManifestSchema(manifestJson);
      expect(validateManifestSchema.errors ?? []).toEqual([]);
      expect(validManifest).toBe(true);
    }
  });

  it('rejects malformed payloads failing required fields, SHA-256 regex, or enum constraints', () => {
    const badSha = { ...realSample, sha256: 'invalid-hash' };
    expect(validateAnalyzeSchema(badSha)).toBe(false);

    const tooFewAnalyses = {
      ...realSample,
      analyses: (realSample.analyses as unknown[]).slice(0, 2),
    };
    expect(validateAnalyzeSchema(tooFewAnalyses)).toBe(false);

    const badStatus = {
      ...realSample,
      assessment: { ...(realSample.assessment as Record<string, unknown>), status: 'AUTHENTIC' },
    };
    expect(validateAnalyzeSchema(badStatus)).toBe(false);

    const badManifest = {
      ...exampleManifest,
      verification: {
        ...(exampleManifest.verification as Record<string, unknown>),
        manifest_sha256: 'not-hex',
      },
    };
    expect(validateManifestSchema(badManifest)).toBe(false);
  });
});
