import { randomUUID } from 'node:crypto';
import {
  AUDIT_GENESIS_HASH,
  TRUTHLENS_CONTRACT_VERSION,
  type AuditChainVerificationResult,
  type AuditEventPayload,
  type AuditEventRecord,
  type AuditEventType,
  type AuditVerificationError,
} from '../../shared/contracts.ts';
import { computeCanonicalJsonSha256 } from './hashing.ts';

export interface CreateAuditEventInput {
  caseId: string;
  eventType: AuditEventType;
  actor?: string;
  evidenceId?: string | null;
  analysisId?: string | null;
  details?: Record<string, unknown>;
  timestampUtc?: string;
  eventId?: string;
}

export function extractAuditPayload(event: AuditEventRecord): AuditEventPayload {
  return {
    schema_version: event.schema_version,
    event_id: event.event_id,
    case_id: event.case_id,
    seq: event.seq,
    timestamp_utc: event.timestamp_utc,
    event_type: event.event_type,
    actor: event.actor,
    evidence_id: event.evidence_id ?? null,
    analysis_id: event.analysis_id ?? null,
    details: event.details ?? {},
    prev_hash: event.prev_hash,
  };
}

export function computeAuditEventHash(payload: AuditEventPayload): string {
  return computeCanonicalJsonSha256(payload);
}

export function createAuditEvent(
  input: CreateAuditEventInput,
  previousEvents: readonly AuditEventRecord[],
): AuditEventRecord {
  const last = previousEvents.length > 0 ? previousEvents[previousEvents.length - 1] : null;
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.event_hash : AUDIT_GENESIS_HASH;

  const payload: AuditEventPayload = {
    schema_version: TRUTHLENS_CONTRACT_VERSION,
    event_id: input.eventId ?? `evt_${randomUUID()}`,
    case_id: input.caseId,
    seq,
    timestamp_utc: input.timestampUtc ?? new Date().toISOString(),
    event_type: input.eventType,
    actor: input.actor ?? 'system',
    evidence_id: input.evidenceId ?? null,
    analysis_id: input.analysisId ?? null,
    details: input.details ?? {},
    prev_hash: prevHash,
  };

  return {
    ...payload,
    event_hash: computeAuditEventHash(payload),
  };
}

export interface VerifyAuditChainOptions {
  expectedCaseId?: string;
  expectedEventCount?: number;
  expectedHeadHash?: string;
}

export function verifyAuditChain(
  events: readonly AuditEventRecord[],
  options: VerifyAuditChainOptions = {},
): AuditChainVerificationResult {
  const errors: AuditVerificationError[] = [];

  if (!Array.isArray(events)) {
    return {
      valid: false,
      event_count: 0,
      head_hash: AUDIT_GENESIS_HASH,
      errors: [
        {
          index: -1,
          seq: null,
          event_id: null,
          reason: 'INVALID_SCHEMA',
          message: 'Audit log must be an array of audit event records.',
        },
      ],
    };
  }

  const seenSeqs = new Set<number>();
  let expectedPrevHash: string = AUDIT_GENESIS_HASH;
  let lastSeq = 0;

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') {
      errors.push({
        index: i,
        seq: null,
        event_id: null,
        reason: 'INVALID_SCHEMA',
        message: `Audit event at index ${i} is not an object.`,
      });
      continue;
    }

    if (
      typeof ev.event_id !== 'string' ||
      typeof ev.case_id !== 'string' ||
      typeof ev.seq !== 'number' ||
      !Number.isInteger(ev.seq) ||
      typeof ev.timestamp_utc !== 'string' ||
      typeof ev.event_type !== 'string' ||
      typeof ev.prev_hash !== 'string' ||
      typeof ev.event_hash !== 'string'
    ) {
      errors.push({
        index: i,
        seq: typeof ev.seq === 'number' ? ev.seq : null,
        event_id: typeof ev.event_id === 'string' ? ev.event_id : null,
        reason: 'INVALID_SCHEMA',
        message: `Audit event at index ${i} is missing required fields.`,
      });
      continue;
    }

    if (options.expectedCaseId && ev.case_id !== options.expectedCaseId) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'CASE_MISMATCH',
        message: `Event ${ev.event_id} belongs to case "${ev.case_id}", expected "${options.expectedCaseId}".`,
      });
    }

    const expectedSeq = i + 1;
    if (seenSeqs.has(ev.seq)) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'DUPLICATE_SEQUENCE',
        message: `Duplicate sequence number ${ev.seq} detected at index ${i}.`,
      });
    } else if (ev.seq < lastSeq) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'OUT_OF_ORDER',
        message: `Event sequence ${ev.seq} at index ${i} is out of order (preceded by seq ${lastSeq}).`,
      });
    } else if (ev.seq !== expectedSeq) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'SEQUENCE_GAP',
        message: `Expected sequence ${expectedSeq} at index ${i}, found ${ev.seq} (missing or inserted event).`,
      });
    }
    seenSeqs.add(ev.seq);
    lastSeq = ev.seq;

    if (ev.prev_hash !== expectedPrevHash) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'PREV_HASH_MISMATCH',
        message: `Event seq ${ev.seq} prev_hash (${ev.prev_hash.slice(0, 12)}…) does not match expected link (${expectedPrevHash.slice(0, 12)}…).`,
      });
    }

    const recomputedHash = computeAuditEventHash(extractAuditPayload(ev));
    if (ev.event_hash !== recomputedHash) {
      errors.push({
        index: i,
        seq: ev.seq,
        event_id: ev.event_id,
        reason: 'HASH_MISMATCH',
        message: `Event seq ${ev.seq} hash mismatch: recorded ${ev.event_hash.slice(0, 12)}…, computed ${recomputedHash.slice(0, 12)}….`,
      });
    }

    expectedPrevHash = ev.event_hash;
  }

  const headHash =
    events.length > 0 && typeof events[events.length - 1]?.event_hash === 'string'
      ? events[events.length - 1].event_hash
      : AUDIT_GENESIS_HASH;

  if (
    typeof options.expectedEventCount === 'number' &&
    events.length !== options.expectedEventCount
  ) {
    errors.push({
      index: events.length - 1,
      seq: events.length > 0 ? (events[events.length - 1]?.seq ?? null) : null,
      event_id: null,
      reason: 'SEQUENCE_GAP',
      message: `Expected ${options.expectedEventCount} audit event(s), found ${events.length}.`,
    });
  }

  if (options.expectedHeadHash && headHash !== options.expectedHeadHash) {
    errors.push({
      index: events.length - 1,
      seq: events.length > 0 ? (events[events.length - 1]?.seq ?? null) : null,
      event_id: null,
      reason: 'HASH_MISMATCH',
      message: `Audit head hash (${headHash.slice(0, 12)}…) does not match expected head hash (${options.expectedHeadHash.slice(0, 12)}…).`,
    });
  }

  return {
    valid: errors.length === 0,
    event_count: events.length,
    head_hash: headHash,
    errors,
  };
}
