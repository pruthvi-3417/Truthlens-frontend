# TruthLens Data Contracts & Evidence/Audit Foundation (v1.0.0)

**Contract Version:** `1.0.0`  
**Manifest Version:** `1.0.0`  
**Source of Truth (Image API Baseline):** `docs/samples/analyze_response.real.json`  
**Shared TypeScript Definitions:** `shared/contracts.ts`, `shared/validation.ts`

---

## 1. Ephemeral Storage & Legal Immutability Notice

> **IMPORTANT:** Current case/evidence storage under `workspace/cases/` is **ephemeral local container storage** intended for prototype investigation, read-only separation of originals from derived artifacts, and cryptographic integrity verification. It is **not** permanent cloud/WORM storage and is **not** legally certified immutable storage. Users and operators should export portable JSON case manifests (`GET /api/v1/cases/:caseId/export`) to preserve custody records outside container lifecycles.

---

## 2. Synchronous Forensic Image API Contracts

### 2.1 `GET /health`
- **Response `200 OK`:**
  ```json
  {
    "application": "TruthLens",
    "status": "healthy",
    "version": "1.0.0"
  }
  ```

### 2.2 `POST /api/v1/analyze`
- **Request (`multipart/form-data`):**
  - `media` or `file` (required): Binary image bytes (`JPEG`, `PNG`, or `WEBP`). Format is verified via content decoding (`sharp`), not filename extension.
  - `mediaType` (optional, defaults to `"image"`): Currently only `"image"` is supported; `"video"`, `"audio"`, and `"text"` return `400 unsupported_media_type` until Tier B/C phases.
  - `caseId` (optional): Attach evidence and analysis run to an existing or named Case ID.
  - `contextText` (optional): Submitter-supplied contextual note stored with the case/evidence record.
- **Preservation & Audit Side Effects:**
  1. Original bytes are preserved read-only (`0o444`) under `workspace/cases/<caseId>/originals/<evidenceId>/<filename>` and verified via SHA-256 readback.
  2. Derived analysis JSON artifacts are written separately under `workspace/cases/<caseId>/artifacts/<analysisId>.json`.
  3. Original evidence bytes are re-verified via SHA-256 after analysis to ensure zero mutation.
  4. Sequence-numbered, SHA-256 hash-chained events (`CASE_CREATED`, `EVIDENCE_INGESTED`, `HASH_VERIFIED`, `ANALYSIS_STARTED`, `ANALYSIS_COMPLETED`, `HASH_VERIFIED`) are appended to `workspace/cases/<caseId>/audit_log.jsonl`.
- **Response `200 OK` (`AnalyzeResponse`):**
  - Preserves all fields from `docs/samples/analyze_response.real.json`:
    - `success`: `true`
    - `application`: `"TruthLens"`
    - `phase`: `"phase_3"`
    - `image_properties`: `{ filename, format, mime_type, size_bytes, size_readable, width, height, aspect_ratio, pixel_count, mode, has_transparency }`
    - `sha256`: 64-char lowercase hex digest of exact uploaded bytes
    - `analyses`: Array of `AnalysisItem` objects for `metadata`, `ela`, `noise`, `frequency`, `recompression` (Phase 2 additive), `robustness` (Phase 2 additive), `regional`, and `synthesis`, each containing `{ name, status, observations, metrics, limitations, details }` plus additive `{ tier, calibration }`. Optional Phase 2 additive fields inside `details` include `method_info`, `region_grid_scores` (normalized NxN scores), `consistency_checks` (metadata), `multi_quality_curve` (ELA), `flat_pixel_residual_std`/`edge_pixel_residual_std` (noise), `spectral_rolloff_85`/`azimuthal_spike_ratio` (frequency), `family_z_scores`/`flat_region_surprise` (regional), and `spatial_corroboration` (synthesis).
    - `assessment`: `{ status: "COMPLETE" | "INCOMPLETE" | "INCONCLUSIVE", summary, limitations }` plus additive `{ category, relationship, maturity_tier, calibration }`. When input luminance is uniform/constant or below minimum spatial contrast thresholds, synthesis explicitly abstains (`relationship: "insufficient_evidence"`) and `assessment.status` is `"INCONCLUSIVE"`.
  - Additive versioned fields on root:
    - `schema_version`: `"1.0.0"`
    - `case_id`, `evidence_id`, `audit_head_hash`, `analysis_timestamp` (UTC ISO-8601)
    - `maturity_tier`: `"A"`
    - `calibration`: `{ status: "uncalibrated", label: "Uncalibrated — qualitative indicator only", notes }`

### 2.3 Module & Assessment Status Contracts
- **`AnalysisItemStatus` (backend):** `'ok' | 'completed' | 'skipped' | 'failed' | 'unavailable' | 'not_implemented'`
- **`AnalysisStatus` (frontend normalized):** `'pending' | 'running' | 'completed' | 'failed' | 'unavailable'`
- **`SynthesisRelationship` → `AssessmentCategory` → Frontend `Assessment` Mapping:**

| `synthesis.details.evidence_summary.relationship` | `assessment.category` | Frontend `Assessment` Badge |
|---|---|---|
| `no_notable_variation` | `NO_NOTABLE_VARIATION` | `NO MAJOR INDICATORS` |
| `isolated_observation` | `ISOLATED_OBSERVATION` | `REQUIRES REVIEW` |
| `mixed_observations` | `MIXED_OBSERVATIONS` | `REQUIRES REVIEW` |
| `converging_observations` | `CONVERGING_OBSERVATIONS` | `MULTIPLE ANOMALIES` |
| `insufficient_evidence` | `INSUFFICIENT_EVIDENCE` | `INCONCLUSIVE` |

Frontend normalization preserves `assessment.summary`, `assessment.limitations`, `maturity_tier`, and `calibration.label` in `InvestigationResult.assessmentDetail`. No asynchronous job polling endpoints exist in Phase 1/2; `/api/v1/analyze` is synchronous.

### 2.4 Error Envelope Contract
All `4xx`/`5xx` API errors return:
```json
{
  "success": false,
  "error": {
    "code": "validation_error",
    "message": "Human-readable error explanation",
    "details": {}
  }
}
```
Standard error codes:
- `400`: `missing_file`, `empty_file`, `unsupported_media_type`, `unrecognized_image`, `unsupported_format`, `image_too_large`, `invalid_identifier`, `invalid_path`, `manifest_verification_failed`, `validation_error`
- `404`: `case_not_found`, `evidence_not_found`, `evidence_bytes_missing`
- `409`: `case_exists`, `evidence_exists`, `audit_chain_corrupted`, `evidence_integrity_error`
- `413`: `payload_too_large`
- `500`: `internal_error`, `post_import_verification_failed`

---

## 3. Case, Evidence, Analysis & Audit Models

### 3.1 Storage Layout (`WorkspaceCaseStore`)
Abstracted via `CaseStorageAdapter` (`server/services/caseStore.ts`):
```
workspace/cases/<case_id>/
  ├── case.json
  ├── originals/<evidence_id>/<sanitized_filename>   # 0o444 read-only originals
  ├── artifacts/<analysis_id>.json                   # Derived analysis JSON
  └── audit_log.jsonl                                # Append-only hash-chained events
```

### 3.2 `AuditEventRecord` Hash Chain
- Genesis anchor: `AUDIT_GENESIS_HASH = "0".repeat(64)`
- Each event contains:
  `{ schema_version, event_id, case_id, seq, timestamp_utc, event_type, actor, evidence_id, analysis_id, details, prev_hash, event_hash }`
- `event_hash` = `SHA-256(canonicalizeJson({ schema_version, event_id, case_id, seq, timestamp_utc, event_type, actor, evidence_id, analysis_id, details, prev_hash }))`
- Canonical JSON recursively sorts object keys lexicographically before UTF-8 serialization.
- `verifyAuditChain` detects:
  - Modified event fields (`HASH_MISMATCH`)
  - Deleted/missing events (`SEQUENCE_GAP`, `PREV_HASH_MISMATCH`, tail count/head mismatch)
  - Reordered events (`OUT_OF_ORDER`, `SEQUENCE_GAP`, `PREV_HASH_MISMATCH`)
  - Inserted/duplicate events (`DUPLICATE_SEQUENCE`, `SEQUENCE_GAP`, `PREV_HASH_MISMATCH`)
  - Cross-case injection (`CASE_MISMATCH`)

### 3.3 Case & Custody HTTP Endpoints
- `POST /api/v1/cases` — Create empty case (`{ title?, context_text? }`) → `201`
- `GET /api/v1/cases` — List cases in workspace → `200`
- `GET /api/v1/cases/:caseId` — Fetch case metadata, evidence index, analysis index → `200`
- `POST /api/v1/cases/:caseId/evidence` — Ingest evidence file (`multipart/form-data`), write read-only, compute & verify SHA-256, sniff MIME → `201`
- `GET /api/v1/cases/:caseId/audit` — Return `audit_log` and `AuditChainVerificationResult` → `200`
- `GET /api/v1/cases/:caseId/verify` — Return `CaseIntegrityReport` verifying both audit chain and original evidence files on disk → `200`
- `GET /api/v1/cases/:caseId/export?includeOriginals=true|false&includeResults=true|false` — Export `CaseManifestV1` JSON → `200`
- `POST /api/v1/cases/import?requireOriginals=true|false` — Verify and import `CaseManifestV1` JSON → `201`

---

## 4. Portable JSON Case Manifest (`CaseManifestV1`)

- `manifest_version`: `"1.0.0"`, `schema_version`: `"1.0.0"`
- `export_options`: `{ include_original_evidence: boolean, include_analysis_results: boolean }`
  - Including raw base64 evidence bytes (`original_bytes_base64`) is an explicit opt-in (`includeOriginals=true`).
  - When omitted, `original_bytes_included: false` is recorded and `import` marks the evidence reference as `backend: "external"` (or rejects if `requireOriginals=true`).
- `verification`:
  - `manifest_sha256`: SHA-256 over canonical JSON of the manifest payload.
  - `audit_chain_valid`, `audit_event_count`, `audit_head_hash`
  - `evidence_hashes`: map of `evidence_id -> sha256`
- On import, `verifyCaseManifest` rejects:
  - Missing/unsupported `manifest_version` or `schema_version`
  - Tampered manifest body (`manifest_sha256` mismatch)
  - Corrupted/tampered/missing/reordered/inserted audit events
  - Mismatched or corrupted `original_bytes_base64` (size or SHA-256 mismatch)
  - Mismatched `result_sha256` in analysis entries
