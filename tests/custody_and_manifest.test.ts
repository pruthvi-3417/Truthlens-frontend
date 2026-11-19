import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyzeResponse } from '../shared/contracts.ts';
import { exportCaseManifest, importCaseManifest, verifyCaseManifest } from '../server/services/caseManifest.ts';
import { WorkspaceCaseStore } from '../server/services/caseStore.ts';
import { computeSha256 } from '../server/services/hashing.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const realSample = JSON.parse(
  fs.readFileSync(path.resolve('docs/samples/analyze_response.real.json'), 'utf-8'),
) as AnalyzeResponse;
const heroBytes = fs.readFileSync(path.resolve('frontend/src/assets/hero.png'));

describe('Evidence Preservation, Integrity Verification & Portable Manifest Export/Import', () => {
  it('stores original evidence read-only separately from artifacts and detects missing or corrupted originals', () => {
    const root = makeTempDir();
    const store = new WorkspaceCaseStore(root);
    const created = store.createCase({ title: 'Custody Test', contextText: 'Claimed photo from May' });
    const ev = store.ingestEvidence(created.case_id, {
      buffer: heroBytes,
      filename: 'hero.png',
      declaredMime: 'image/png',
    });

    const expectedHash = computeSha256(heroBytes);
    expect(ev.sha256).toBe(expectedHash);
    expect(ev.storage_ref.relative_path.startsWith('originals/')).toBe(true);

    // Record analysis artifact separately
    const run = store.recordAnalysisRun(created.case_id, {
      evidenceId: ev.evidence_id,
      modality: 'image',
      toolVersion: '1.0.0',
      maturityTier: 'A',
      parameters: { ela_quality: 90 },
      result: realSample,
    });
    expect(run.artifact_ref.startsWith('artifacts/')).toBe(true);

    const integrityOk = store.verifyCaseIntegrity(created.case_id);
    expect(integrityOk.valid).toBe(true);
    expect(integrityOk.audit_verification.valid).toBe(true);
    expect(integrityOk.evidence_verifications[0].valid).toBe(true);

    // Tamper with original bytes on disk (make writable first to simulate external corruption)
    const originalAbs = path.join(root, created.case_id, ev.storage_ref.relative_path);
    fs.chmodSync(originalAbs, 0o644);
    fs.writeFileSync(originalAbs, Buffer.from('corrupted bytes'));

    const corruptedIntegrity = store.verifyCaseIntegrity(created.case_id);
    expect(corruptedIntegrity.valid).toBe(false);
    expect(corruptedIntegrity.evidence_verifications[0].valid).toBe(false);
    expect(corruptedIntegrity.evidence_verifications[0].file_present).toBe(true);

    // Delete original file on disk
    fs.unlinkSync(originalAbs);
    const missingIntegrity = store.verifyCaseIntegrity(created.case_id);
    expect(missingIntegrity.valid).toBe(false);
    expect(missingIntegrity.evidence_verifications[0].file_present).toBe(false);
  });

  it('round-trips portable JSON manifest WITH original evidence and verifies imported hashes and audit chain', () => {
    const srcRoot = makeTempDir();
    const dstRoot = makeTempDir();
    const srcStore = new WorkspaceCaseStore(srcRoot);
    const dstStore = new WorkspaceCaseStore(dstRoot);

    const created = srcStore.createCase({ title: 'Export With Originals' });
    const ev = srcStore.ingestEvidence(created.case_id, {
      buffer: heroBytes,
      filename: 'hero.png',
    });
    srcStore.recordAnalysisRun(created.case_id, {
      evidenceId: ev.evidence_id,
      modality: 'image',
      toolVersion: '1.0.0',
      maturityTier: 'A',
      parameters: { ela_quality: 90 },
      result: realSample,
    });

    const manifest = exportCaseManifest(srcStore, created.case_id, {
      includeOriginalEvidence: true,
      includeAnalysisResults: true,
    });

    expect(manifest.export_options.include_original_evidence).toBe(true);
    expect(manifest.evidence_items[0].original_bytes_included).toBe(true);
    expect(manifest.evidence_items[0].original_bytes_base64).toBeTruthy();
    expect(manifest.findings.length).toBeGreaterThan(0);

    const { caseRecord, verification } = importCaseManifest(dstStore, manifest, {
      requireOriginalEvidence: true,
    });
    expect(verification.valid).toBe(true);
    expect(verification.manifest_hash_valid).toBe(true);

    const importedIntegrity = dstStore.verifyCaseIntegrity(caseRecord.case_id);
    expect(importedIntegrity.valid).toBe(true);
    expect(importedIntegrity.evidence_verifications[0].valid).toBe(true);
    expect(dstStore.readOriginalEvidence(caseRecord.case_id, ev.evidence_id)).toEqual(heroBytes);

    // Imported audit log contains original events + CASE_IMPORTED cleanly chained
    const importedAudit = dstStore.getAuditLog(caseRecord.case_id);
    expect(importedAudit[importedAudit.length - 1].event_type).toBe('CASE_IMPORTED');
    expect(dstStore.verifyAuditLog(caseRecord.case_id).valid).toBe(true);
  });

  it('supports manifest export WITHOUT original bytes and enforces requireOriginalEvidence option', () => {
    const srcRoot = makeTempDir();
    const dstRoot = makeTempDir();
    const srcStore = new WorkspaceCaseStore(srcRoot);
    const dstStore = new WorkspaceCaseStore(dstRoot);

    const created = srcStore.createCase({ title: 'Metadata-Only Export' });
    srcStore.ingestEvidence(created.case_id, { buffer: heroBytes, filename: 'hero.png' });

    const manifest = exportCaseManifest(srcStore, created.case_id, {
      includeOriginalEvidence: false,
    });
    expect(manifest.export_options.include_original_evidence).toBe(false);
    expect(manifest.evidence_items[0].original_bytes_included).toBe(false);
    expect(manifest.evidence_items[0].original_bytes_base64).toBeUndefined();

    // Rejected if caller requires originals
    expect(() =>
      importCaseManifest(dstStore, manifest, { requireOriginalEvidence: true }),
    ).toThrow(/requireOriginalEvidence/i);

    // Allowed when originals are optional, and integrity report explicitly flags missing local bytes
    const { caseRecord } = importCaseManifest(dstStore, manifest, {
      requireOriginalEvidence: false,
    });
    const postCheck = dstStore.verifyCaseIntegrity(caseRecord.case_id);
    expect(postCheck.audit_verification.valid).toBe(true);
    expect(postCheck.evidence_verifications[0].file_present).toBe(false);
    expect(postCheck.valid).toBe(false);
  });

  it('rejects tampered, corrupted, or incomplete manifests on import', () => {
    const srcRoot = makeTempDir();
    const dstRoot = makeTempDir();
    const srcStore = new WorkspaceCaseStore(srcRoot);
    const dstStore = new WorkspaceCaseStore(dstRoot);

    const created = srcStore.createCase({ title: 'Tamper Rejection' });
    const ev = srcStore.ingestEvidence(created.case_id, { buffer: heroBytes, filename: 'hero.png' });
    srcStore.recordAnalysisRun(created.case_id, {
      evidenceId: ev.evidence_id,
      modality: 'image',
      toolVersion: '1.0.0',
      maturityTier: 'A',
      parameters: {},
      result: realSample,
    });

    const manifest = exportCaseManifest(srcStore, created.case_id, {
      includeOriginalEvidence: true,
    });

    // 1. Incomplete manifest
    expect(verifyCaseManifest({ manifest_version: '1.0.0' }).report.valid).toBe(false);

    // 2. Corrupted base64 evidence bytes
    const badBytesManifest = structuredClone(manifest);
    badBytesManifest.evidence_items[0].original_bytes_base64 = Buffer.from('wrong').toString('base64');
    expect(() => importCaseManifest(dstStore, badBytesManifest)).toThrow();

    // 3. Tampered audit log inside manifest
    const badAuditManifest = structuredClone(manifest);
    badAuditManifest.audit_log[0].details = { hacked: true };
    const auditReport = verifyCaseManifest(badAuditManifest).report;
    expect(auditReport.valid).toBe(false);
    expect(auditReport.manifest_hash_valid).toBe(false);
    expect(auditReport.audit_verification.valid).toBe(false);
  });

  it('validates the checked-in docs/samples/case_manifest.example.json fixture', () => {
    const exampleManifest = JSON.parse(
      fs.readFileSync(path.resolve('docs/samples/case_manifest.example.json'), 'utf-8'),
    );
    const { report } = verifyCaseManifest(exampleManifest);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.manifest_hash_valid).toBe(true);
    expect(report.audit_verification.valid).toBe(true);
  });
});
