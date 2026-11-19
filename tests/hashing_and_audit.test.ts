import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH, type AuditEventRecord } from '../shared/contracts.ts';
import { createAuditEvent, verifyAuditChain } from '../server/services/auditLog.ts';
import { computeSha256, sniffMimeAndFormat, verifySha256 } from '../server/services/hashing.ts';

describe('SHA-256 Hashing, Content Sniffing & Hash-Chained Audit Log', () => {
  it('computes and verifies SHA-256 digests and rejects mismatched hashes', () => {
    const buf = Buffer.from('TruthLens forensic bytes', 'utf-8');
    const digest = computeSha256(buf);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySha256(buf, digest).valid).toBe(true);

    const mutated = Buffer.from('TruthLens forensic bytez', 'utf-8');
    const badCheck = verifySha256(mutated, digest);
    expect(badCheck.valid).toBe(false);
    expect(badCheck.actual_sha256).not.toBe(digest);
  });

  it('sniffs image MIME types from magic bytes regardless of extension', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const sniffed = sniffMimeAndFormat(pngBytes, 'spoofed.jpg', 'image/jpeg');
    expect(sniffed.sniffed_mime).toBe('image/png');
    expect(sniffed.detected_format).toBe('PNG');
    expect(sniffed.inferred_modality).toBe('image');
  });

  function buildSampleChain(): AuditEventRecord[] {
    const events: AuditEventRecord[] = [];
    events.push(
      createAuditEvent(
        { caseId: 'case_test_01', eventType: 'CASE_CREATED', details: { title: 'Test' } },
        events,
      ),
    );
    events.push(
      createAuditEvent(
        {
          caseId: 'case_test_01',
          eventType: 'EVIDENCE_INGESTED',
          evidenceId: 'ev_1',
          details: { sha256: 'a'.repeat(64) },
        },
        events,
      ),
    );
    events.push(
      createAuditEvent(
        {
          caseId: 'case_test_01',
          eventType: 'ANALYSIS_COMPLETED',
          evidenceId: 'ev_1',
          analysisId: 'ana_1',
          details: { status: 'COMPLETE' },
        },
        events,
      ),
    );
    return events;
  }

  it('generates and verifies a valid sequence-numbered hash chain', () => {
    const events = buildSampleChain();
    expect(events[0].prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(events[1].prev_hash).toBe(events[0].event_hash);
    expect(events[2].prev_hash).toBe(events[1].event_hash);

    const verification = verifyAuditChain(events, { expectedCaseId: 'case_test_01' });
    expect(verification.valid).toBe(true);
    expect(verification.event_count).toBe(3);
    expect(verification.head_hash).toBe(events[2].event_hash);
    expect(verification.errors).toEqual([]);
  });

  it('detects tampered/modified audit event fields', () => {
    const events = buildSampleChain();
    const tampered = structuredClone(events);
    tampered[1].details = { sha256: 'b'.repeat(64) };

    const verification = verifyAuditChain(tampered, { expectedCaseId: 'case_test_01' });
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((e) => e.reason === 'HASH_MISMATCH' && e.seq === 2)).toBe(true);
  });

  it('detects deleted middle, first, and tail audit events', () => {
    const events = buildSampleChain();

    // Middle event deleted
    const missingMiddle = [events[0], events[2]];
    const midCheck = verifyAuditChain(missingMiddle);
    expect(midCheck.valid).toBe(false);
    expect(midCheck.errors.some((e) => e.reason === 'SEQUENCE_GAP')).toBe(true);
    expect(midCheck.errors.some((e) => e.reason === 'PREV_HASH_MISMATCH')).toBe(true);

    // First event deleted
    const missingFirst = [events[1], events[2]];
    const firstCheck = verifyAuditChain(missingFirst);
    expect(firstCheck.valid).toBe(false);
    expect(firstCheck.errors.some((e) => e.reason === 'SEQUENCE_GAP')).toBe(true);
    expect(firstCheck.errors.some((e) => e.reason === 'PREV_HASH_MISMATCH')).toBe(true);

    // Tail event deleted when verified against expected head/count
    const missingTail = [events[0], events[1]];
    const tailCheck = verifyAuditChain(missingTail, {
      expectedEventCount: 3,
      expectedHeadHash: events[2].event_hash,
    });
    expect(tailCheck.valid).toBe(false);
    expect(tailCheck.errors.some((e) => e.reason === 'SEQUENCE_GAP')).toBe(true);
    expect(tailCheck.errors.some((e) => e.reason === 'HASH_MISMATCH')).toBe(true);
  });

  it('detects reordered audit events', () => {
    const events = buildSampleChain();
    const reordered = [events[0], events[2], events[1]];

    const verification = verifyAuditChain(reordered);
    expect(verification.valid).toBe(false);
    expect(
      verification.errors.some((e) => e.reason === 'OUT_OF_ORDER' || e.reason === 'SEQUENCE_GAP'),
    ).toBe(true);
    expect(verification.errors.some((e) => e.reason === 'PREV_HASH_MISMATCH')).toBe(true);
  });

  it('detects inserted rogue audit events', () => {
    const events = buildSampleChain();
    const injected = createAuditEvent(
      { caseId: 'case_test_01', eventType: 'HASH_VERIFIED', details: { injected: true } },
      [events[0]],
    );
    const withInsertion = [events[0], injected, events[1], events[2]];

    const verification = verifyAuditChain(withInsertion);
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((e) => e.reason === 'DUPLICATE_SEQUENCE')).toBe(true);
    expect(verification.errors.some((e) => e.reason === 'PREV_HASH_MISMATCH')).toBe(true);
  });
});
