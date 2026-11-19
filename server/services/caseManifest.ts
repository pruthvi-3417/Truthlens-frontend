import {
  EPHEMERAL_STORAGE_NOTICE,
  TRUTHLENS_CONTRACT_VERSION,
  TRUTHLENS_MANIFEST_VERSION,
  UNCALIBRATED_QUALITATIVE_INFO,
  type AnalyzeResponse,
  type AuditChainVerificationResult,
  type CaseManifestV1,
  type CaseRecord,
  type FindingRecord,
  type ManifestAnalysisEntry,
  type ManifestEvidenceEntry,
  type SynthesisDetails,
} from '../../shared/contracts.ts';
import { validateCaseManifestStructure } from '../../shared/validation.ts';
import { TruthLensError, ValidationFailedError } from '../errors.ts';
import { verifyAuditChain } from './auditLog.ts';
import type { CaseStorageAdapter } from './caseStore.ts';
import { computeCanonicalJsonSha256, verifySha256 } from './hashing.ts';

export interface ExportManifestOptions {
  includeOriginalEvidence?: boolean;
  includeAnalysisResults?: boolean;
  exporterName?: string;
  exporterVersion?: string;
  actor?: string;
}

export interface ManifestEvidenceCheck {
  evidence_id: string;
  original_filename: string | null;
  expected_sha256: string;
  actual_sha256: string | null;
  original_bytes_included: boolean;
  valid: boolean;
  error?: string;
}

export interface ManifestVerificationReport {
  valid: boolean;
  manifest_hash_valid: boolean;
  audit_verification: AuditChainVerificationResult;
  evidence_checks: ManifestEvidenceCheck[];
  analysis_checks: Array<{
    analysis_id: string;
    result_included: boolean;
    valid: boolean;
    error?: string;
  }>;
  missing_original_evidence_ids: string[];
  errors: string[];
}

export interface ImportManifestOptions {
  requireOriginalEvidence?: boolean;
  actor?: string;
}

export function extractFindingsFromAnalyzeResponse(
  result: AnalyzeResponse,
  sourceFilename: string | null,
  evidenceId: string,
): FindingRecord[] {
  const synthesis = result.analyses.find((a) => a.name === 'synthesis');
  const synthDetails = (synthesis?.details ?? null) as SynthesisDetails | null;
  const keyObs = synthDetails?.key_observations ?? [];
  const tier = result.maturity_tier ?? 'A';
  const calibrationLabel =
    result.calibration?.label ??
    result.assessment.calibration?.label ??
    UNCALIBRATED_QUALITATIVE_INFO.label;

  return keyObs.map((ko) => {
    const regionTrace = ko.region_ids.length
      ? `Regions: ${ko.region_ids.join(', ')}`
      : 'Image-wide measurement';
    const domainList = ko.relevant_domains.join(', ');
    return {
      id: ko.observation_id,
      title: ko.title,
      module: domainList || 'synthesis',
      tier,
      severity: 'informational',
      flagged_evidence: `${sourceFilename ?? 'Uploaded image'} (${regionTrace})`,
      indicator: ko.description,
      cross_modal_context:
        synthDetails?.evidence_summary?.synthesis_statement ??
        'Single-image multi-domain synthesis only; cross-modal correlation unavailable for single-item image submission.',
      confidence: `${calibrationLabel} (heuristic threshold check)`,
      calibration_label: calibrationLabel,
      source_trace: `evidence:${evidenceId} | sha256:${result.sha256.slice(0, 16)}…`,
      summary: `${ko.neutral_interpretation} Recommended check: review flagged region(s) alongside source context.`,
      limitations: [...ko.limitations],
    };
  });
}

function computeManifestSha256(manifest: Omit<CaseManifestV1, 'verification'> & {
  verification: Omit<CaseManifestV1['verification'], 'manifest_sha256'>;
}): string {
  return computeCanonicalJsonSha256({
    manifest_version: manifest.manifest_version,
    schema_version: manifest.schema_version,
    exported_at_utc: manifest.exported_at_utc,
    exporter_tool: manifest.exporter_tool,
    storage_notice: manifest.storage_notice,
    export_options: manifest.export_options,
    case: manifest.case,
    evidence_items: manifest.evidence_items,
    analyses: manifest.analyses,
    findings: manifest.findings,
    audit_log: manifest.audit_log,
    verification: {
      audit_chain_valid: manifest.verification.audit_chain_valid,
      audit_event_count: manifest.verification.audit_event_count,
      audit_head_hash: manifest.verification.audit_head_hash,
      evidence_hashes: manifest.verification.evidence_hashes,
    },
  });
}

export function exportCaseManifest(
  store: CaseStorageAdapter,
  caseId: string,
  options: ExportManifestOptions = {},
): CaseManifestV1 {
  const caseRecord = store.getCase(caseId);
  if (!caseRecord) {
    throw new TruthLensError(`Case '${caseId}' not found.`, 404, 'case_not_found');
  }

  const integrity = store.verifyCaseIntegrity(caseId);
  if (!integrity.audit_verification.valid) {
    throw new TruthLensError(
      'Cannot export case manifest: local audit chain failed integrity verification.',
      409,
      'audit_chain_corrupted',
    );
  }
  const corruptedEvidence = integrity.evidence_verifications.find((ev) => !ev.valid);
  if (corruptedEvidence) {
    throw new TruthLensError(
      `Cannot export case manifest: evidence '${corruptedEvidence.evidence_id}' failed integrity verification (${corruptedEvidence.error ?? 'hash mismatch'}).`,
      409,
      'evidence_integrity_error',
    );
  }

  const includeOriginalEvidence = options.includeOriginalEvidence ?? false;
  const includeAnalysisResults = options.includeAnalysisResults ?? true;

  const evidenceEntries: ManifestEvidenceEntry[] = caseRecord.evidence_items.map((item) => {
    if (!includeOriginalEvidence) {
      return {
        ...item,
        original_bytes_included: false,
      };
    }
    const rawBytes = store.readOriginalEvidence(caseId, item.evidence_id);
    return {
      ...item,
      original_bytes_included: true,
      original_bytes_base64: rawBytes.toString('base64'),
    };
  });

  const findings: FindingRecord[] = [];
  const analysisEntries: ManifestAnalysisEntry[] = caseRecord.analyses.map((run) => {
    const artifact = store.readAnalysisArtifact(caseId, run.analysis_id);
    const ev = caseRecord.evidence_items.find((e) => e.evidence_id === run.evidence_id);
    if (artifact) {
      findings.push(
        ...extractFindingsFromAnalyzeResponse(
          artifact,
          ev?.original_filename ?? null,
          run.evidence_id,
        ),
      );
    }
    return includeAnalysisResults && artifact ? { ...run, result: artifact } : { ...run };
  });

  const auditLog = store.getAuditLog(caseId);
  const evidenceHashes: Record<string, string> = {};
  for (const item of caseRecord.evidence_items) {
    evidenceHashes[item.evidence_id] = item.sha256;
  }

  const baseManifest = {
    manifest_version: TRUTHLENS_MANIFEST_VERSION,
    schema_version: TRUTHLENS_CONTRACT_VERSION,
    exported_at_utc: new Date().toISOString(),
    exporter_tool: {
      name: options.exporterName ?? 'TruthLens',
      version: options.exporterVersion ?? '1.0.0',
    },
    storage_notice: EPHEMERAL_STORAGE_NOTICE,
    export_options: {
      include_original_evidence: includeOriginalEvidence,
      include_analysis_results: includeAnalysisResults,
    },
    case: {
      case_id: caseRecord.case_id,
      created_at_utc: caseRecord.created_at_utc,
      updated_at_utc: caseRecord.updated_at_utc,
      title: caseRecord.title,
      context_text: caseRecord.context_text,
      status: caseRecord.status,
    },
    evidence_items: evidenceEntries,
    analyses: analysisEntries,
    findings,
    audit_log: auditLog,
    verification: {
      audit_chain_valid: integrity.audit_verification.valid,
      audit_event_count: integrity.audit_verification.event_count,
      audit_head_hash: integrity.audit_verification.head_hash,
      evidence_hashes: evidenceHashes,
    },
  };

  const manifestSha256 = computeManifestSha256(baseManifest);
  const manifest: CaseManifestV1 = {
    ...baseManifest,
    verification: {
      ...baseManifest.verification,
      manifest_sha256: manifestSha256,
    },
  };

  store.appendAuditEvent(caseId, {
    eventType: 'CASE_EXPORTED',
    actor: options.actor ?? 'api',
    details: {
      manifest_sha256: manifestSha256,
      include_original_evidence: includeOriginalEvidence,
      include_analysis_results: includeAnalysisResults,
      evidence_count: evidenceEntries.length,
      analysis_count: analysisEntries.length,
    },
  });

  return manifest;
}

export function verifyCaseManifest(
  rawManifest: unknown,
  options: { requireOriginalEvidence?: boolean } = {},
): {
  report: ManifestVerificationReport;
  originals: Map<string, Buffer>;
  artifacts: Map<string, AnalyzeResponse>;
} {
  const structure = validateCaseManifestStructure(rawManifest);
  if (!structure.valid) {
    return {
      report: {
        valid: false,
        manifest_hash_valid: false,
        audit_verification: {
          valid: false,
          event_count: 0,
          head_hash: '',
          errors: [
            {
              index: -1,
              seq: null,
              event_id: null,
              reason: 'INVALID_SCHEMA',
              message: structure.errors.join(' '),
            },
          ],
        },
        evidence_checks: [],
        analysis_checks: [],
        missing_original_evidence_ids: [],
        errors: structure.errors,
      },
      originals: new Map(),
      artifacts: new Map(),
    };
  }

  const manifest = rawManifest as CaseManifestV1;
  const errors: string[] = [];

  const expectedManifestHash = computeManifestSha256(manifest);
  const manifestHashValid = expectedManifestHash === manifest.verification.manifest_sha256;
  if (!manifestHashValid) {
    errors.push(
      `Manifest SHA-256 mismatch: expected ${manifest.verification.manifest_sha256}, computed ${expectedManifestHash}.`,
    );
  }

  const auditVerification = verifyAuditChain(manifest.audit_log, {
    expectedCaseId: manifest.case.case_id,
    expectedEventCount: manifest.verification.audit_event_count,
    expectedHeadHash: manifest.verification.audit_head_hash,
  });
  if (!auditVerification.valid) {
    errors.push(
      ...auditVerification.errors.map((e) => `Audit log error (${e.reason}): ${e.message}`),
    );
  }

  const originals = new Map<string, Buffer>();
  const evidenceChecks: ManifestEvidenceCheck[] = [];
  const missingOriginalIds: string[] = [];

  for (const ev of manifest.evidence_items) {
    const expectedFromMap = manifest.verification.evidence_hashes[ev.evidence_id];
    if (!expectedFromMap || expectedFromMap !== ev.sha256) {
      const msg = `Evidence '${ev.evidence_id}' hash missing or mismatched in manifest verification table.`;
      errors.push(msg);
      evidenceChecks.push({
        evidence_id: ev.evidence_id,
        original_filename: ev.original_filename,
        expected_sha256: ev.sha256,
        actual_sha256: null,
        original_bytes_included: ev.original_bytes_included,
        valid: false,
        error: msg,
      });
      continue;
    }

    if (ev.original_bytes_included) {
      if (typeof ev.original_bytes_base64 !== 'string' || !ev.original_bytes_base64.length) {
        const msg = `Evidence '${ev.evidence_id}' marks original_bytes_included=true but original_bytes_base64 is missing.`;
        errors.push(msg);
        evidenceChecks.push({
          evidence_id: ev.evidence_id,
          original_filename: ev.original_filename,
          expected_sha256: ev.sha256,
          actual_sha256: null,
          original_bytes_included: true,
          valid: false,
          error: msg,
        });
        continue;
      }

      const decoded = Buffer.from(ev.original_bytes_base64, 'base64');
      // Ensure base64 wasn't corrupted/non-base64 garbage by checking size & SHA-256
      const shaCheck = verifySha256(decoded, ev.sha256);
      const sizeValid = decoded.length === ev.size_bytes;
      const valid = shaCheck.valid && sizeValid;
      if (!valid) {
        const msg = !sizeValid
          ? `Evidence '${ev.evidence_id}' decoded size (${decoded.length}) does not match recorded size (${ev.size_bytes}).`
          : `Evidence '${ev.evidence_id}' SHA-256 mismatch after import decode.`;
        errors.push(msg);
        evidenceChecks.push({
          evidence_id: ev.evidence_id,
          original_filename: ev.original_filename,
          expected_sha256: ev.sha256,
          actual_sha256: shaCheck.actual_sha256,
          original_bytes_included: true,
          valid: false,
          error: msg,
        });
        continue;
      }

      originals.set(ev.evidence_id, decoded);
      evidenceChecks.push({
        evidence_id: ev.evidence_id,
        original_filename: ev.original_filename,
        expected_sha256: ev.sha256,
        actual_sha256: shaCheck.actual_sha256,
        original_bytes_included: true,
        valid: true,
      });
    } else {
      missingOriginalIds.push(ev.evidence_id);
      const msg = options.requireOriginalEvidence
        ? `Evidence '${ev.evidence_id}' original bytes were not included in manifest, and requireOriginalEvidence is enabled.`
        : undefined;
      if (msg) errors.push(msg);
      evidenceChecks.push({
        evidence_id: ev.evidence_id,
        original_filename: ev.original_filename,
        expected_sha256: ev.sha256,
        actual_sha256: null,
        original_bytes_included: false,
        valid: !options.requireOriginalEvidence,
        error: msg,
      });
    }
  }

  const artifacts = new Map<string, AnalyzeResponse>();
  const analysisChecks: ManifestVerificationReport['analysis_checks'] = [];
  for (const run of manifest.analyses) {
    if (run.result) {
      const computedResultSha = computeCanonicalJsonSha256(run.result);
      const valid = computedResultSha === run.result_sha256;
      if (!valid) {
        const msg = `Analysis '${run.analysis_id}' result hash mismatch.`;
        errors.push(msg);
        analysisChecks.push({
          analysis_id: run.analysis_id,
          result_included: true,
          valid: false,
          error: msg,
        });
      } else {
        artifacts.set(run.analysis_id, run.result);
        analysisChecks.push({
          analysis_id: run.analysis_id,
          result_included: true,
          valid: true,
        });
      }
    } else {
      analysisChecks.push({
        analysis_id: run.analysis_id,
        result_included: false,
        valid: true,
      });
    }
  }

  return {
    report: {
      valid: errors.length === 0,
      manifest_hash_valid: manifestHashValid,
      audit_verification: auditVerification,
      evidence_checks: evidenceChecks,
      analysis_checks: analysisChecks,
      missing_original_evidence_ids: missingOriginalIds,
      errors,
    },
    originals,
    artifacts,
  };
}

export function importCaseManifest(
  store: CaseStorageAdapter,
  rawManifest: unknown,
  options: ImportManifestOptions = {},
): {
  caseRecord: CaseRecord;
  verification: ManifestVerificationReport;
} {
  const { report, originals, artifacts } = verifyCaseManifest(rawManifest, {
    requireOriginalEvidence: options.requireOriginalEvidence,
  });

  if (!report.valid) {
    throw new ValidationFailedError(
      `Case manifest import rejected: ${report.errors[0] ?? 'Integrity verification failed.'}`,
      'manifest_verification_failed',
    );
  }

  const manifest = rawManifest as CaseManifestV1;
  const restoredCase: CaseRecord = {
    schema_version: manifest.schema_version,
    case_id: manifest.case.case_id,
    created_at_utc: manifest.case.created_at_utc,
    updated_at_utc: new Date().toISOString(),
    title: manifest.case.title,
    context_text: manifest.case.context_text,
    status: manifest.case.status,
    storage_ephemeral_notice: EPHEMERAL_STORAGE_NOTICE,
    evidence_items: manifest.evidence_items.map(({ original_bytes_included: _inc, original_bytes_base64: _b64, ...ev }) => ev),
    analyses: manifest.analyses.map(({ result: _res, ...run }) => run),
  };

  const { caseRecord } = store.restoreImportedCase({
    caseRecord: restoredCase,
    auditLog: manifest.audit_log,
    originals,
    artifacts,
    importDetails: {
      actor: options.actor ?? 'import',
      manifest_sha256: manifest.verification.manifest_sha256,
      originals_restored: originals.size,
      originals_omitted: report.missing_original_evidence_ids.length,
    },
  });

  // Post-import verification of restored originals on disk when originals were included
  if (originals.size > 0) {
    const postIntegrity = store.verifyCaseIntegrity(caseRecord.case_id);
    const failedEv = postIntegrity.evidence_verifications.find(
      (ev) => originals.has(ev.evidence_id) && !ev.valid,
    );
    if (failedEv) {
      throw new TruthLensError(
        `Post-import evidence verification failed for '${failedEv.evidence_id}': ${failedEv.error ?? 'hash mismatch'}.`,
        500,
        'post_import_verification_failed',
      );
    }
  }

  return {
    caseRecord,
    verification: report,
  };
}
