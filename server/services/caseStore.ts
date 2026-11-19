import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUDIT_GENESIS_HASH,
  EPHEMERAL_STORAGE_NOTICE,
  TRUTHLENS_CONTRACT_VERSION,
  UNCALIBRATED_QUALITATIVE_INFO,
  type AnalysisRunRecord,
  type AnalyzeResponse,
  type AuditChainVerificationResult,
  type AuditEventRecord,
  type AuditEventType,
  type CalibrationInfo,
  type CaseIntegrityReport,
  type CaseRecord,
  type CaseStatus,
  type EvidenceItemRecord,
  type EvidenceVerificationResult,
  type MaturityTier,
  type Modality,
} from '../../shared/contracts.ts';
import { TruthLensError, ValidationFailedError } from '../errors.ts';
import { createAuditEvent, verifyAuditChain } from './auditLog.ts';
import {
  computeCanonicalJsonSha256,
  computeSha256,
  sniffMimeAndFormat,
  verifySha256,
} from './hashing.ts';

export interface CreateCaseInput {
  caseId?: string;
  title?: string | null;
  contextText?: string | null;
  actor?: string;
}

export interface IngestEvidenceInput {
  evidenceId?: string;
  buffer: Buffer;
  filename?: string | null;
  declaredMime?: string | null;
  modality?: Modality;
  contextNote?: string | null;
  actor?: string;
}

export interface RecordAnalysisInput {
  analysisId?: string;
  evidenceId: string;
  modality: Modality;
  toolVersion: string;
  maturityTier: MaturityTier;
  calibration?: CalibrationInfo;
  parameters: Record<string, unknown>;
  result: AnalyzeResponse;
  actor?: string;
}

export interface CaseStorageAdapter {
  readonly storageBackend: 'local_workspace';
  readonly ephemeralNotice: string;
  createCase(input?: CreateCaseInput): CaseRecord;
  getCase(caseId: string): CaseRecord | null;
  listCases(): CaseRecord[];
  updateCaseStatus(caseId: string, status: CaseStatus): CaseRecord;
  ingestEvidence(caseId: string, input: IngestEvidenceInput): EvidenceItemRecord;
  readOriginalEvidence(caseId: string, evidenceId: string): Buffer;
  recordAnalysisRun(caseId: string, input: RecordAnalysisInput): AnalysisRunRecord;
  readAnalysisArtifact(caseId: string, analysisId: string): AnalyzeResponse | null;
  appendAuditEvent(
    caseId: string,
    input: {
      eventType: AuditEventType;
      actor?: string;
      evidenceId?: string | null;
      analysisId?: string | null;
      details?: Record<string, unknown>;
    },
  ): AuditEventRecord;
  getAuditLog(caseId: string): AuditEventRecord[];
  verifyAuditLog(caseId: string): AuditChainVerificationResult;
  verifyCaseIntegrity(caseId: string): CaseIntegrityReport;
  restoreImportedCase(params: {
    caseRecord: CaseRecord;
    auditLog: AuditEventRecord[];
    originals: Map<string, Buffer>;
    artifacts: Map<string, AnalyzeResponse>;
    importDetails: Record<string, unknown>;
  }): { caseRecord: CaseRecord; auditLog: AuditEventRecord[] };
}

function assertSafeId(id: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(id)) {
    throw new ValidationFailedError(`Invalid ${label} identifier.`, 'invalid_identifier');
  }
  return id;
}

function sanitizeFilename(filename: string | null | undefined, fallbackExt: string): string {
  const base = path.basename((filename ?? '').trim() || `evidence.${fallbackExt}`);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return (cleaned || `evidence.${fallbackExt}`).slice(0, 120);
}

export class WorkspaceCaseStore implements CaseStorageAdapter {
  readonly storageBackend = 'local_workspace' as const;
  readonly ephemeralNotice = EPHEMERAL_STORAGE_NOTICE;
  readonly baseDir: string;

  constructor(baseDir = path.resolve('workspace/cases')) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private caseDir(caseId: string): string {
    assertSafeId(caseId, 'case_id');
    return path.join(this.baseDir, caseId);
  }

  private caseJsonPath(caseId: string): string {
    return path.join(this.caseDir(caseId), 'case.json');
  }

  private auditLogPath(caseId: string): string {
    return path.join(this.caseDir(caseId), 'audit_log.jsonl');
  }

  private originalsDir(caseId: string): string {
    return path.join(this.caseDir(caseId), 'originals');
  }

  private artifactsDir(caseId: string): string {
    return path.join(this.caseDir(caseId), 'artifacts');
  }

  private writeCaseJson(record: CaseRecord): void {
    fs.writeFileSync(this.caseJsonPath(record.case_id), JSON.stringify(record, null, 2), 'utf-8');
  }

  private requireCase(caseId: string): CaseRecord {
    const existing = this.getCase(caseId);
    if (!existing) {
      throw new TruthLensError(`Case '${caseId}' not found.`, 404, 'case_not_found');
    }
    return existing;
  }

  createCase(input: CreateCaseInput = {}): CaseRecord {
    const caseId = input.caseId ? assertSafeId(input.caseId, 'case_id') : `case_${randomUUID()}`;
    const dir = this.caseDir(caseId);
    if (fs.existsSync(dir)) {
      throw new TruthLensError(`Case '${caseId}' already exists.`, 409, 'case_exists');
    }

    fs.mkdirSync(this.originalsDir(caseId), { recursive: true });
    fs.mkdirSync(this.artifactsDir(caseId), { recursive: true });

    const now = new Date().toISOString();
    const record: CaseRecord = {
      schema_version: TRUTHLENS_CONTRACT_VERSION,
      case_id: caseId,
      created_at_utc: now,
      updated_at_utc: now,
      title: input.title?.trim() || `Investigation ${caseId}`,
      context_text: input.contextText?.trim() || null,
      status: 'open',
      storage_ephemeral_notice: this.ephemeralNotice,
      evidence_items: [],
      analyses: [],
    };

    this.writeCaseJson(record);
    this.appendAuditEvent(caseId, {
      eventType: 'CASE_CREATED',
      actor: input.actor ?? 'api',
      details: {
        title: record.title,
        has_context_text: Boolean(record.context_text),
        storage_backend: this.storageBackend,
      },
    });

    return record;
  }

  getCase(caseId: string): CaseRecord | null {
    try {
      const filePath = this.caseJsonPath(caseId);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CaseRecord;
    } catch (err) {
      if (err instanceof TruthLensError) throw err;
      return null;
    }
  }

  listCases(): CaseRecord[] {
    if (!fs.existsSync(this.baseDir)) return [];
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const cases: CaseRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const c = this.getCase(entry.name);
      if (c) cases.push(c);
    }
    return cases.sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc));
  }

  updateCaseStatus(caseId: string, status: CaseStatus): CaseRecord {
    const record = this.requireCase(caseId);
    record.status = status;
    record.updated_at_utc = new Date().toISOString();
    this.writeCaseJson(record);
    return record;
  }

  ingestEvidence(caseId: string, input: IngestEvidenceInput): EvidenceItemRecord {
    const record = this.requireCase(caseId);
    if (!input.buffer || input.buffer.length === 0) {
      throw new ValidationFailedError('Cannot ingest empty evidence buffer.', 'empty_file');
    }

    const evidenceId = input.evidenceId
      ? assertSafeId(input.evidenceId, 'evidence_id')
      : `ev_${randomUUID()}`;

    if (record.evidence_items.some((e) => e.evidence_id === evidenceId)) {
      throw new TruthLensError(`Evidence '${evidenceId}' already exists in case.`, 409, 'evidence_exists');
    }

    const sha256 = computeSha256(input.buffer);
    const sniffed = sniffMimeAndFormat(input.buffer, input.filename, input.declaredMime);
    const modality: Modality = input.modality ?? sniffed.inferred_modality ?? 'image';
    const ext = sniffed.detected_format.toLowerCase() || 'bin';
    const safeName = sanitizeFilename(input.filename, ext);
    const relPath = path.posix.join('originals', evidenceId, safeName);
    const absPath = path.join(this.caseDir(caseId), relPath);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    // Exclusive create ('wx') guarantees an original evidence file can never overwrite an existing one.
    fs.writeFileSync(absPath, input.buffer, { flag: 'wx', mode: 0o444 });
    try {
      fs.chmodSync(absPath, 0o444);
    } catch {
      // Non-POSIX filesystems may ignore chmod; read_only_mode remains enforced logically.
    }

    // Independent read-back verification immediately after write.
    const readBack = fs.readFileSync(absPath);
    const readBackVerification = verifySha256(readBack, sha256);
    if (!readBackVerification.valid) {
      throw new TruthLensError(
        'Original evidence write verification failed (SHA-256 mismatch).',
        500,
        'evidence_integrity_error',
      );
    }

    const now = new Date().toISOString();
    const item: EvidenceItemRecord = {
      schema_version: TRUTHLENS_CONTRACT_VERSION,
      evidence_id: evidenceId,
      case_id: caseId,
      modality,
      original_filename: input.filename ?? null,
      declared_mime: input.declaredMime ?? null,
      sniffed_mime: sniffed.sniffed_mime,
      detected_format: sniffed.detected_format,
      size_bytes: input.buffer.length,
      sha256,
      ingest_timestamp_utc: now,
      context_note: input.contextNote?.trim() || null,
      storage_ref: {
        backend: this.storageBackend,
        relative_path: relPath,
        read_only_mode: true,
        ephemeral_notice: this.ephemeralNotice,
      },
      hash_verified_at_utc: now,
    };

    record.evidence_items.push(item);
    record.updated_at_utc = now;
    this.writeCaseJson(record);

    this.appendAuditEvent(caseId, {
      eventType: 'EVIDENCE_INGESTED',
      actor: input.actor ?? 'api',
      evidenceId,
      details: {
        original_filename: item.original_filename,
        modality: item.modality,
        sniffed_mime: item.sniffed_mime,
        detected_format: item.detected_format,
        size_bytes: item.size_bytes,
        sha256: item.sha256,
        relative_path: relPath,
      },
    });

    this.appendAuditEvent(caseId, {
      eventType: 'HASH_VERIFIED',
      actor: 'system',
      evidenceId,
      details: {
        stage: 'post_ingest_readback',
        expected_sha256: sha256,
        actual_sha256: readBackVerification.actual_sha256,
        valid: readBackVerification.valid,
      },
    });

    return item;
  }

  readOriginalEvidence(caseId: string, evidenceId: string): Buffer {
    const record = this.requireCase(caseId);
    assertSafeId(evidenceId, 'evidence_id');
    const item = record.evidence_items.find((e) => e.evidence_id === evidenceId);
    if (!item) {
      throw new TruthLensError(`Evidence '${evidenceId}' not found in case '${caseId}'.`, 404, 'evidence_not_found');
    }
    const resolved = path.resolve(this.caseDir(caseId), item.storage_ref.relative_path);
    const originalsRoot = path.resolve(this.originalsDir(caseId));
    if (!resolved.startsWith(originalsRoot + path.sep)) {
      throw new ValidationFailedError('Evidence path escapes originals directory.', 'invalid_path');
    }
    if (!fs.existsSync(resolved)) {
      throw new TruthLensError(
        `Original evidence bytes missing on disk for '${evidenceId}'.`,
        404,
        'evidence_bytes_missing',
      );
    }
    return fs.readFileSync(resolved);
  }

  recordAnalysisRun(caseId: string, input: RecordAnalysisInput): AnalysisRunRecord {
    const record = this.requireCase(caseId);
    const evidence = record.evidence_items.find((e) => e.evidence_id === input.evidenceId);
    if (!evidence) {
      throw new TruthLensError(
        `Evidence '${input.evidenceId}' not found in case '${caseId}'.`,
        404,
        'evidence_not_found',
      );
    }

    const analysisId = input.analysisId
      ? assertSafeId(input.analysisId, 'analysis_id')
      : `ana_${randomUUID()}`;

    // Verify original evidence bytes are intact before recording analysis artifacts
    const preBytes = this.readOriginalEvidence(caseId, evidence.evidence_id);
    const preCheck = verifySha256(preBytes, evidence.sha256);
    if (!preCheck.valid) {
      throw new TruthLensError(
        'Original evidence integrity check failed before storing analysis artifacts.',
        500,
        'evidence_integrity_error',
      );
    }

    this.appendAuditEvent(caseId, {
      eventType: 'ANALYSIS_STARTED',
      actor: input.actor ?? 'api',
      evidenceId: evidence.evidence_id,
      analysisId,
      details: {
        modality: input.modality,
        maturity_tier: input.maturityTier,
        tool_version: input.toolVersion,
        parameters: input.parameters,
      },
    });

    const artifactRel = path.posix.join('artifacts', `${analysisId}.json`);
    const artifactAbs = path.join(this.caseDir(caseId), artifactRel);
    fs.mkdirSync(path.dirname(artifactAbs), { recursive: true });
    fs.writeFileSync(artifactAbs, JSON.stringify(input.result, null, 2), 'utf-8');

    const resultSha256 = computeCanonicalJsonSha256(input.result);
    const now = new Date().toISOString();
    const run: AnalysisRunRecord = {
      schema_version: TRUTHLENS_CONTRACT_VERSION,
      analysis_id: analysisId,
      case_id: caseId,
      evidence_id: evidence.evidence_id,
      modality: input.modality,
      tool_version: input.toolVersion,
      maturity_tier: input.maturityTier,
      calibration: input.calibration ?? UNCALIBRATED_QUALITATIVE_INFO,
      created_at_utc: now,
      parameters: input.parameters,
      artifact_ref: artifactRel,
      result_sha256: resultSha256,
    };

    record.analyses.push(run);
    record.status = 'analyzed';
    record.updated_at_utc = now;
    this.writeCaseJson(record);

    this.appendAuditEvent(caseId, {
      eventType: 'ANALYSIS_COMPLETED',
      actor: input.actor ?? 'system',
      evidenceId: evidence.evidence_id,
      analysisId,
      details: {
        artifact_ref: artifactRel,
        result_sha256: resultSha256,
        assessment_status: input.result.assessment.status,
        maturity_tier: input.maturityTier,
      },
    });

    // Post-analysis SHA-256 check on the preserved original bytes
    const postBytes = this.readOriginalEvidence(caseId, evidence.evidence_id);
    const postCheck = verifySha256(postBytes, evidence.sha256);
    if (!postCheck.valid) {
      throw new TruthLensError(
        'Original evidence integrity check failed after analysis.',
        500,
        'evidence_integrity_error',
      );
    }

    this.appendAuditEvent(caseId, {
      eventType: 'HASH_VERIFIED',
      actor: 'system',
      evidenceId: evidence.evidence_id,
      analysisId,
      details: {
        stage: 'post_analysis_original_check',
        expected_sha256: evidence.sha256,
        actual_sha256: postCheck.actual_sha256,
        valid: postCheck.valid,
      },
    });

    return run;
  }

  readAnalysisArtifact(caseId: string, analysisId: string): AnalyzeResponse | null {
    const record = this.requireCase(caseId);
    assertSafeId(analysisId, 'analysis_id');
    const run = record.analyses.find((a) => a.analysis_id === analysisId);
    if (!run) return null;
    const abs = path.resolve(this.caseDir(caseId), run.artifact_ref);
    const artifactsRoot = path.resolve(this.artifactsDir(caseId));
    if (!abs.startsWith(artifactsRoot + path.sep) || !fs.existsSync(abs)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(abs, 'utf-8')) as AnalyzeResponse;
  }

  appendAuditEvent(
    caseId: string,
    input: {
      eventType: AuditEventType;
      actor?: string;
      evidenceId?: string | null;
      analysisId?: string | null;
      details?: Record<string, unknown>;
    },
  ): AuditEventRecord {
    this.requireCase(caseId);
    const existing = this.getAuditLog(caseId);
    const event = createAuditEvent(
      {
        caseId,
        eventType: input.eventType,
        actor: input.actor,
        evidenceId: input.evidenceId,
        analysisId: input.analysisId,
        details: input.details,
      },
      existing,
    );
    fs.appendFileSync(this.auditLogPath(caseId), `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  getAuditLog(caseId: string): AuditEventRecord[] {
    this.requireCase(caseId);
    const logPath = this.auditLogPath(caseId);
    if (!fs.existsSync(logPath)) return [];
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map((line) => JSON.parse(line) as AuditEventRecord);
  }

  verifyAuditLog(caseId: string): AuditChainVerificationResult {
    const events = this.getAuditLog(caseId);
    return verifyAuditChain(events, { expectedCaseId: caseId });
  }

  verifyCaseIntegrity(caseId: string): CaseIntegrityReport {
    const record = this.requireCase(caseId);
    const auditVerification = this.verifyAuditLog(caseId);
    const evidenceVerifications: EvidenceVerificationResult[] = [];

    for (const item of record.evidence_items) {
      if (item.storage_ref.backend === 'external') {
        evidenceVerifications.push({
          evidence_id: item.evidence_id,
          original_filename: item.original_filename,
          expected_sha256: item.sha256,
          actual_sha256: null,
          expected_size_bytes: item.size_bytes,
          actual_size_bytes: null,
          file_present: false,
          valid: false,
          error: 'Original evidence bytes were omitted during manifest import (external reference only).',
        });
        continue;
      }

      const resolved = path.resolve(this.caseDir(caseId), item.storage_ref.relative_path);
      const originalsRoot = path.resolve(this.originalsDir(caseId));
      if (!resolved.startsWith(originalsRoot + path.sep) || !fs.existsSync(resolved)) {
        evidenceVerifications.push({
          evidence_id: item.evidence_id,
          original_filename: item.original_filename,
          expected_sha256: item.sha256,
          actual_sha256: null,
          expected_size_bytes: item.size_bytes,
          actual_size_bytes: null,
          file_present: false,
          valid: false,
          error: `Original evidence file missing at ${item.storage_ref.relative_path}.`,
        });
        continue;
      }

      const bytes = fs.readFileSync(resolved);
      const check = verifySha256(bytes, item.sha256);
      const sizeMatch = bytes.length === item.size_bytes;
      const valid = check.valid && sizeMatch;
      evidenceVerifications.push({
        evidence_id: item.evidence_id,
        original_filename: item.original_filename,
        expected_sha256: item.sha256,
        actual_sha256: check.actual_sha256,
        expected_size_bytes: item.size_bytes,
        actual_size_bytes: bytes.length,
        file_present: true,
        valid,
        error: valid
          ? undefined
          : !sizeMatch
            ? `Size mismatch: expected ${item.size_bytes} bytes, found ${bytes.length}.`
            : 'SHA-256 digest mismatch against preserved original evidence.',
      });
    }

    const allEvidenceValid = evidenceVerifications.every((ev) => ev.valid);
    return {
      schema_version: TRUTHLENS_CONTRACT_VERSION,
      case_id: caseId,
      verified_at_utc: new Date().toISOString(),
      valid: auditVerification.valid && allEvidenceValid,
      ephemeral_storage_notice: this.ephemeralNotice,
      audit_verification: auditVerification,
      evidence_verifications: evidenceVerifications,
    };
  }

  restoreImportedCase(params: {
    caseRecord: CaseRecord;
    auditLog: AuditEventRecord[];
    originals: Map<string, Buffer>;
    artifacts: Map<string, AnalyzeResponse>;
    importDetails: Record<string, unknown>;
  }): { caseRecord: CaseRecord; auditLog: AuditEventRecord[] } {
    const caseId = assertSafeId(params.caseRecord.case_id, 'case_id');
    const dir = this.caseDir(caseId);
    if (fs.existsSync(dir)) {
      throw new TruthLensError(
        `Cannot import case '${caseId}': a case with this ID already exists in workspace.`,
        409,
        'case_exists',
      );
    }

    fs.mkdirSync(this.originalsDir(caseId), { recursive: true });
    fs.mkdirSync(this.artifactsDir(caseId), { recursive: true });

    for (const item of params.caseRecord.evidence_items) {
      const bytes = params.originals.get(item.evidence_id);
      if (bytes) {
        const ext = item.detected_format.toLowerCase() || 'bin';
        const safeName = sanitizeFilename(item.original_filename, ext);
        const relPath = path.posix.join('originals', item.evidence_id, safeName);
        const absPath = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, bytes, { flag: 'wx', mode: 0o444 });
        try {
          fs.chmodSync(absPath, 0o444);
        } catch {
          // Ignore non-POSIX chmod errors
        }
        item.storage_ref = {
          backend: this.storageBackend,
          relative_path: relPath,
          read_only_mode: true,
          ephemeral_notice: this.ephemeralNotice,
        };
      } else {
        item.storage_ref = {
          backend: 'external',
          relative_path: item.storage_ref?.relative_path || '',
          read_only_mode: true,
          ephemeral_notice: this.ephemeralNotice,
        };
      }
    }

    for (const run of params.caseRecord.analyses) {
      const result = params.artifacts.get(run.analysis_id);
      if (result) {
        const rel = path.posix.join('artifacts', `${run.analysis_id}.json`);
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(result, null, 2), 'utf-8');
        run.artifact_ref = rel;
      }
    }

    params.caseRecord.storage_ephemeral_notice = this.ephemeralNotice;
    this.writeCaseJson(params.caseRecord);

    const logContent = params.auditLog.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(
      this.auditLogPath(caseId),
      logContent ? `${logContent}\n` : '',
      'utf-8',
    );

    const importEvent = this.appendAuditEvent(caseId, {
      eventType: 'CASE_IMPORTED',
      actor: 'import',
      details: {
        imported_event_count: params.auditLog.length,
        imported_head_hash:
          params.auditLog.length > 0
            ? params.auditLog[params.auditLog.length - 1].event_hash
            : AUDIT_GENESIS_HASH,
        ...params.importDetails,
      },
    });

    return {
      caseRecord: params.caseRecord,
      auditLog: [...params.auditLog, importEvent],
    };
  }
}
