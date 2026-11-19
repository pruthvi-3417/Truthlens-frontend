import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAnalyzeResponse } from '../shared/validation.ts';
import { createApiApp } from '../server/app.ts';
import { getSettings } from '../server/config.ts';
import { computeSha256 } from '../server/services/hashing.ts';

let tempCasesDir = '';
let tempCasesDir2 = '';
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  tempCasesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-api-'));
  tempCasesDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-api-import-'));
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
  fs.rmSync(tempCasesDir2, { recursive: true, force: true });
});

describe('API Behavior Regression & Custody Endpoint Integration', () => {
  it('returns healthy status on GET /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      application: 'TruthLens',
      status: 'healthy',
      version: '1.0.0',
    });
  });

  it('analyzes PNG image, preserves read-only original, creates valid audit chain, and satisfies AnalyzeResponse contract', async () => {
    const pngBytes = fs.readFileSync(path.resolve('frontend/src/assets/hero.png'));
    const form = new FormData();
    form.append('mediaType', 'image');
    form.append('media', new Blob([pngBytes], { type: 'image/png' }), 'hero.png');

    const res = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const json = await res.json();

    const validation = validateAnalyzeResponse(json);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(json.sha256).toBe(computeSha256(pngBytes));
    expect(json.schema_version).toBe('1.0.0');
    expect(json.case_id).toBeTruthy();
    expect(json.evidence_id).toBeTruthy();
    expect(json.audit_head_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(json.calibration.label).toBe('Uncalibrated — qualitative indicator only');

    // Verify ELA is unavailable for PNG while other modules completed
    const ela = json.analyses.find((a: { name: string }) => a.name === 'ela');
    expect(ela.status).toBe('unavailable');

    // Verify case integrity via custody endpoint
    const verifyRes = await fetch(`${baseUrl}/api/v1/cases/${json.case_id}/verify`);
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.integrity.valid).toBe(true);
    expect(verifyBody.integrity.audit_verification.valid).toBe(true);
    expect(verifyBody.integrity.evidence_verifications[0].expected_sha256).toBe(json.sha256);

    // Export manifest with originals and import into an independent second app/store
    const exportRes = await fetch(
      `${baseUrl}/api/v1/cases/${json.case_id}/export?includeOriginals=true`,
    );
    expect(exportRes.status).toBe(200);
    const manifest = await exportRes.json();

    const app2 = createApiApp({ settings: { ...getSettings(), casesDir: tempCasesDir2 } }).app;
    await new Promise<void>((resolve) => {
      const srv2 = app2.listen(0, '127.0.0.1', async () => {
        try {
          const addr = srv2.address() as { port: number };
          const importRes = await fetch(`http://127.0.0.1:${addr.port}/api/v1/cases/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(manifest),
          });
          expect(importRes.status).toBe(201);
          const importJson = await importRes.json();
          expect(importJson.verification.valid).toBe(true);
          expect(importJson.case.case_id).toBe(json.case_id);
        } finally {
          srv2.close(() => resolve());
        }
      });
    });
  });

  it('analyzes JPEG image with all 6 modules completed', async () => {
    const jpegBuffer = await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 90, g: 130, b: 170 } },
    })
      .jpeg({ quality: 88 })
      .toBuffer();

    const form = new FormData();
    form.append('mediaType', 'image');
    form.append('file', new Blob([new Uint8Array(jpegBuffer)], { type: 'image/jpeg' }), 'test.jpg');

    const res = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(validateAnalyzeResponse(json).valid).toBe(true);
    expect(json.analyses.every((a: { status: string }) => a.status === 'completed')).toBe(true);
  });

  it('rejects empty files, non-images, missing files, and unsupported mediaType with 400 error envelopes', async () => {
    // Missing file
    const missingForm = new FormData();
    missingForm.append('mediaType', 'image');
    const missingRes = await fetch(`${baseUrl}/api/v1/analyze`, {
      method: 'POST',
      body: missingForm,
    });
    expect(missingRes.status).toBe(400);
    expect((await missingRes.json()).error.code).toBe('missing_file');

    // Empty file
    const emptyForm = new FormData();
    emptyForm.append('mediaType', 'image');
    emptyForm.append('media', new Blob([], { type: 'image/png' }), 'empty.png');
    const emptyRes = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: emptyForm });
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()).error.code).toBe('empty_file');

    // Non-image bytes
    const txtForm = new FormData();
    txtForm.append('mediaType', 'image');
    txtForm.append('media', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
    const txtRes = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: txtForm });
    expect(txtRes.status).toBe(400);
    expect((await txtRes.json()).error.code).toBe('unrecognized_image');

    // Unsupported mediaType=video
    const vidForm = new FormData();
    vidForm.append('mediaType', 'video');
    vidForm.append('media', new Blob(['fakevideo'], { type: 'video/mp4' }), 'clip.mp4');
    const vidRes = await fetch(`${baseUrl}/api/v1/analyze`, { method: 'POST', body: vidForm });
    expect(vidRes.status).toBe(400);
    expect((await vidRes.json()).error.code).toBe('unsupported_media_type');
  });
});
