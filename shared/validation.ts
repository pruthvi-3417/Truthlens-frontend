import type {
  AnalysisItem,
  AnalyzeResponse,
  AssessmentCategory,
  CaseManifestV1,
  SynthesisDetails,
  SynthesisRelationship,
} from './contracts.ts';
import {
  TRUTHLENS_CONTRACT_VERSION,
  TRUTHLENS_MANIFEST_VERSION,
} from './contracts.ts';

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

const VALID_ITEM_STATUSES = new Set([
  'ok',
  'completed',
  'skipped',
  'failed',
  'unavailable',
  'not_implemented',
]);

const VALID_ASSESSMENT_STATUSES = new Set(['INCOMPLETE', 'INCONCLUSIVE', 'COMPLETE']);

const VALID_RELATIONSHIPS = new Set<SynthesisRelationship>([
  'converging_observations',
  'isolated_observation',
  'mixed_observations',
  'insufficient_evidence',
  'no_notable_variation',
]);

export function mapSynthesisRelationshipToCategory(
  relationship?: SynthesisRelationship | string | null,
): AssessmentCategory {
  if (relationship === 'no_notable_variation') return 'NO_NOTABLE_VARIATION';
  if (relationship === 'isolated_observation') return 'ISOLATED_OBSERVATION';
  if (relationship === 'mixed_observations') return 'MIXED_OBSERVATIONS';
  if (relationship === 'converging_observations') return 'CONVERGING_OBSERVATIONS';
  return 'INSUFFICIENT_EVIDENCE';
}

export type LegacyAssessmentUiLabel =
  | 'NO MAJOR INDICATORS'
  | 'REQUIRES REVIEW'
  | 'MULTIPLE ANOMALIES'
  | 'INCONCLUSIVE';

export function mapRelationshipOrCategoryToUiLabel(
  relationshipOrCategory?: string | null,
): LegacyAssessmentUiLabel {
  switch (relationshipOrCategory) {
    case 'no_notable_variation':
    case 'NO_NOTABLE_VARIATION':
      return 'NO MAJOR INDICATORS';
    case 'converging_observations':
    case 'CONVERGING_OBSERVATIONS':
      return 'MULTIPLE ANOMALIES';
    case 'insufficient_evidence':
    case 'INSUFFICIENT_EVIDENCE':
      return 'INCONCLUSIVE';
    case 'isolated_observation':
    case 'ISOLATED_OBSERVATION':
    case 'mixed_observations':
    case 'MIXED_OBSERVATIONS':
    default:
      return 'REQUIRES REVIEW';
  }
}

export function validateAnalyzeResponse(input: unknown): ContractValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { valid: false, errors: ['Response root must be an object.'] };
  }

  if (input.success !== true) {
    errors.push('Field "success" must be true.');
  }
  if (!isNonEmptyString(input.application)) {
    errors.push('Field "application" must be a non-empty string.');
  }
  if (!isNonEmptyString(input.phase)) {
    errors.push('Field "phase" must be a non-empty string.');
  }
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    errors.push('Field "sha256" must be a 64-character hex SHA-256 digest.');
  }

  // Validate image_properties
  if (!isObject(input.image_properties)) {
    errors.push('Field "image_properties" must be an object.');
  } else {
    const props = input.image_properties;
    if (props.filename !== null && typeof props.filename !== 'string') {
      errors.push('image_properties.filename must be string or null.');
    }
    for (const key of ['format', 'mime_type', 'size_readable', 'mode'] as const) {
      if (!isNonEmptyString(props[key])) {
        errors.push(`image_properties.${key} must be a non-empty string.`);
      }
    }
    for (const key of ['size_bytes', 'width', 'height', 'aspect_ratio', 'pixel_count'] as const) {
      if (typeof props[key] !== 'number' || !Number.isFinite(props[key] as number)) {
        errors.push(`image_properties.${key} must be a finite number.`);
      }
    }
    if (typeof props.has_transparency !== 'boolean') {
      errors.push('image_properties.has_transparency must be boolean.');
    }
  }

  // Validate analyses[]
  if (!Array.isArray(input.analyses) || input.analyses.length === 0) {
    errors.push('Field "analyses" must be a non-empty array.');
  } else {
    const names = new Set<string>();
    input.analyses.forEach((item, idx) => {
      if (!isObject(item)) {
        errors.push(`analyses[${idx}] must be an object.`);
        return;
      }
      if (!isNonEmptyString(item.name)) {
        errors.push(`analyses[${idx}].name must be a non-empty string.`);
      } else {
        names.add(item.name);
      }
      if (!isNonEmptyString(item.status) || !VALID_ITEM_STATUSES.has(item.status)) {
        errors.push(`analyses[${idx}].status is invalid.`);
      }
      if (!isStringArray(item.observations)) {
        errors.push(`analyses[${idx}].observations must be an array of strings.`);
      }
      if (!isObject(item.metrics)) {
        errors.push(`analyses[${idx}].metrics must be an object.`);
      }
      if (!isStringArray(item.limitations)) {
        errors.push(`analyses[${idx}].limitations must be an array of strings.`);
      }
      if (item.details !== null && !isObject(item.details)) {
        errors.push(`analyses[${idx}].details must be an object or null.`);
      } else if (item.details && isObject(item.details) && Array.isArray(item.details.region_grid_scores)) {
        for (let gIdx = 0; gIdx < item.details.region_grid_scores.length; gIdx += 1) {
          const tile = item.details.region_grid_scores[gIdx];
          if (
            !isObject(tile) ||
            !isNonEmptyString(tile.region_id) ||
            typeof tile.raw_value !== 'number' ||
            typeof tile.robust_z !== 'number' ||
            typeof tile.normalized_score !== 'number'
          ) {
            errors.push(`analyses[${idx}].details.region_grid_scores[${gIdx}] is malformed.`);
          }
        }
      }
    });

    for (const requiredModule of ['metadata', 'ela', 'noise', 'frequency', 'regional', 'synthesis']) {
      if (!names.has(requiredModule)) {
        errors.push(`analyses[] is missing required module "${requiredModule}".`);
      }
    }

    const synthesis = (input.analyses as AnalysisItem[]).find((a) => a.name === 'synthesis');
    if (synthesis && synthesis.status === 'completed') {
      const details = synthesis.details as SynthesisDetails | null;
      if (!details || !isObject(details)) {
        errors.push('synthesis.details must be an object when synthesis is completed.');
      } else {
        if (!isObject(details.evidence_summary)) {
          errors.push('synthesis.details.evidence_summary must be an object.');
        } else if (!VALID_RELATIONSHIPS.has(details.evidence_summary.relationship)) {
          errors.push('synthesis.details.evidence_summary.relationship is invalid.');
        }
        if (!Array.isArray(details.domains)) {
          errors.push('synthesis.details.domains must be an array.');
        }
        if (!Array.isArray(details.key_observations)) {
          errors.push('synthesis.details.key_observations must be an array.');
        }
        if (!isObject(details.regional_synthesis)) {
          errors.push('synthesis.details.regional_synthesis must be an object.');
        }
        if (!isObject(details.methodology)) {
          errors.push('synthesis.details.methodology must be an object.');
        }
      }
    }
  }

  // Validate assessment
  if (!isObject(input.assessment)) {
    errors.push('Field "assessment" must be an object.');
  } else {
    if (
      !isNonEmptyString(input.assessment.status) ||
      !VALID_ASSESSMENT_STATUSES.has(input.assessment.status)
    ) {
      errors.push('assessment.status must be INCOMPLETE, INCONCLUSIVE, or COMPLETE.');
    }
    if (!isNonEmptyString(input.assessment.summary)) {
      errors.push('assessment.summary must be a non-empty string.');
    }
    if (!isStringArray(input.assessment.limitations)) {
      errors.push('assessment.limitations must be an array of strings.');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isAnalyzeResponse(input: unknown): input is AnalyzeResponse {
  return validateAnalyzeResponse(input).valid;
}

export function validateCaseManifestStructure(input: unknown): ContractValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) {
    return { valid: false, errors: ['Case manifest root must be a JSON object.'] };
  }

  if (input.manifest_version !== TRUTHLENS_MANIFEST_VERSION) {
    errors.push(
      `Unsupported manifest_version "${String(input.manifest_version)}"; expected "${TRUTHLENS_MANIFEST_VERSION}".`,
    );
  }
  if (input.schema_version !== TRUTHLENS_CONTRACT_VERSION) {
    errors.push(
      `Unsupported schema_version "${String(input.schema_version)}"; expected "${TRUTHLENS_CONTRACT_VERSION}".`,
    );
  }
  if (!isNonEmptyString(input.exported_at_utc)) {
    errors.push('manifest.exported_at_utc must be a non-empty UTC ISO string.');
  }
  if (!isNonEmptyString(input.storage_notice)) {
    errors.push('manifest.storage_notice must be provided.');
  }
  if (!isObject(input.export_options)) {
    errors.push('manifest.export_options must be an object.');
  } else {
    if (typeof input.export_options.include_original_evidence !== 'boolean') {
      errors.push('manifest.export_options.include_original_evidence must be boolean.');
    }
    if (typeof input.export_options.include_analysis_results !== 'boolean') {
      errors.push('manifest.export_options.include_analysis_results must be boolean.');
    }
  }

  if (!isObject(input.case)) {
    errors.push('manifest.case must be an object.');
  } else {
    for (const k of ['case_id', 'created_at_utc', 'updated_at_utc', 'title', 'status'] as const) {
      if (!isNonEmptyString(input.case[k])) {
        errors.push(`manifest.case.${k} must be a non-empty string.`);
      }
    }
  }

  if (!Array.isArray(input.evidence_items)) {
    errors.push('manifest.evidence_items must be an array.');
  } else {
    input.evidence_items.forEach((ev, idx) => {
      if (!isObject(ev)) {
        errors.push(`manifest.evidence_items[${idx}] must be an object.`);
        return;
      }
      if (!isNonEmptyString(ev.evidence_id)) {
        errors.push(`manifest.evidence_items[${idx}].evidence_id is required.`);
      }
      if (typeof ev.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(ev.sha256)) {
        errors.push(`manifest.evidence_items[${idx}].sha256 must be a valid SHA-256 hex digest.`);
      }
      if (typeof ev.size_bytes !== 'number' || ev.size_bytes < 0) {
        errors.push(`manifest.evidence_items[${idx}].size_bytes must be a non-negative number.`);
      }
      if (typeof ev.original_bytes_included !== 'boolean') {
        errors.push(`manifest.evidence_items[${idx}].original_bytes_included must be boolean.`);
      }
    });
  }

  if (!Array.isArray(input.analyses)) {
    errors.push('manifest.analyses must be an array.');
  }
  if (!Array.isArray(input.findings)) {
    errors.push('manifest.findings must be an array.');
  }
  if (!Array.isArray(input.audit_log)) {
    errors.push('manifest.audit_log must be an array.');
  }

  if (!isObject(input.verification)) {
    errors.push('manifest.verification must be an object.');
  } else {
    if (
      typeof input.verification.manifest_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(input.verification.manifest_sha256)
    ) {
      errors.push('manifest.verification.manifest_sha256 must be a 64-character hex SHA-256.');
    }
    if (typeof input.verification.audit_chain_valid !== 'boolean') {
      errors.push('manifest.verification.audit_chain_valid must be boolean.');
    }
    if (typeof input.verification.audit_event_count !== 'number') {
      errors.push('manifest.verification.audit_event_count must be a number.');
    }
    if (!isNonEmptyString(input.verification.audit_head_hash)) {
      errors.push('manifest.verification.audit_head_hash must be a non-empty string.');
    }
    if (!isObject(input.verification.evidence_hashes)) {
      errors.push('manifest.verification.evidence_hashes must be an object.');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isCaseManifestV1(input: unknown): input is CaseManifestV1 {
  return validateCaseManifestStructure(input).valid;
}
