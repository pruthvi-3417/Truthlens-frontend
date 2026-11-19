import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeInvestigation } from '../frontend/src/services/analysisAdapter.ts';
import {
  mapRelationshipOrCategoryToUiLabel,
  mapSynthesisRelationshipToCategory,
  validateAnalyzeResponse,
} from '../shared/validation.ts';

const samplePath = path.resolve('docs/samples/analyze_response.real.json');
const realSample = JSON.parse(fs.readFileSync(samplePath, 'utf-8')) as Record<string, unknown>;

describe('Phase 1 Data Contracts & Frontend Mapping', () => {
  it('validates docs/samples/analyze_response.real.json against the AnalyzeResponse v1 contract', () => {
    const result = validateAnalyzeResponse(realSample);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects malformed AnalyzeResponse objects', () => {
    const broken = { ...realSample, sha256: 'not-a-sha', assessment: { status: 'COMPLETE' } };
    const result = validateAnalyzeResponse(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sha256'))).toBe(true);
    expect(result.errors.some((e) => e.includes('assessment.summary'))).toBe(true);
  });

  it('maps synthesis relationships to categories and UI labels without losing summary or limitations', () => {
    const cases = [
      ['no_notable_variation', 'NO_NOTABLE_VARIATION', 'NO MAJOR INDICATORS'],
      ['isolated_observation', 'ISOLATED_OBSERVATION', 'REQUIRES REVIEW'],
      ['mixed_observations', 'MIXED_OBSERVATIONS', 'REQUIRES REVIEW'],
      ['converging_observations', 'CONVERGING_OBSERVATIONS', 'MULTIPLE ANOMALIES'],
      ['insufficient_evidence', 'INSUFFICIENT_EVIDENCE', 'INCONCLUSIVE'],
    ] as const;

    for (const [rel, expectedCategory, expectedUiLabel] of cases) {
      expect(mapSynthesisRelationshipToCategory(rel)).toBe(expectedCategory);
      expect(mapRelationshipOrCategoryToUiLabel(rel)).toBe(expectedUiLabel);
      expect(mapRelationshipOrCategoryToUiLabel(expectedCategory)).toBe(expectedUiLabel);
    }
  });

  it('normalizes docs/samples/analyze_response.real.json without dropping assessment summary, limitations, regional, frequency, or synthesis fields', () => {
    const normalized = normalizeInvestigation(realSample);

    expect(normalized.id).toBe(`TL-${String(realSample.sha256).slice(0, 12)}`);
    expect(normalized.sha256).toEqual([realSample.sha256]);
    expect(normalized.filenames).toEqual(['hero.png']);
    expect(normalized.assessment).toBe('REQUIRES REVIEW');
    expect(normalized.assessmentDetail).toBeDefined();
    expect(normalized.assessmentDetail?.status).toBe('COMPLETE');
    expect(normalized.assessmentDetail?.summary).toContain('Noise & Texture domain');
    expect(normalized.assessmentDetail?.limitations.length).toBeGreaterThanOrEqual(4);
    expect(normalized.assessmentDetail?.calibration.label).toBe(
      'Uncalibrated — qualitative indicator only',
    );

    // Metadata fields preserved
    expect(normalized.imageEvidence?.exif?.exifPresent).toBe(true);
    expect(normalized.imageEvidence?.exif?.fieldsMissing).toEqual([
      'camera_make',
      'camera_model',
      'capture_datetime',
      'software',
      'orientation',
    ]);
    expect(normalized.imageEvidence?.exif?.formatNotes).toContain('PNG commonly lacks');

    // Noise fields preserved
    expect(normalized.imageEvidence?.noise?.regionalSummary?.std_max).toBeCloseTo(19.7631, 4);
    expect(normalized.imageEvidence?.noise?.regional?.[0]?.std).toBeCloseTo(10.6133, 4);

    // Frequency fields preserved
    expect(normalized.imageEvidence?.frequency?.windowFunction).toBe('hann');
    expect(normalized.imageEvidence?.frequency?.analysisWidth).toBe(343);
    expect(normalized.imageEvidence?.frequency?.totalNonDcPower).toBeGreaterThan(0);

    // Regional fields preserved
    expect(normalized.imageEvidence?.regional?.analyzedFeatures?.length).toBeGreaterThan(0);
    expect(normalized.imageEvidence?.regional?.regional?.[0]?.neighborDeviation).toBeDefined();
    expect(normalized.imageEvidence?.regional?.regional?.[0]?.zScores).toBeDefined();
    expect(normalized.imageEvidence?.regional?.regional?.[0]?.observation).toBeTruthy();

    // Synthesis fields preserved
    expect(normalized.imageEvidence?.evidence?.evidenceSummary?.relationship).toBe(
      'isolated_observation',
    );
    expect(normalized.imageEvidence?.evidence?.regionalSynthesis?.tiles).toHaveLength(16);
    expect(normalized.imageEvidence?.evidence?.methodology?.version).toBe('3.0');
  });

  it('preserves rich JPEG EXIF and ELA fields in normalizeInvestigation', () => {
    const jpegFixture = {
      ...realSample,
      image_properties: {
        ...(realSample.image_properties as Record<string, unknown>),
        filename: 'camera_sample.jpg',
        format: 'JPEG',
        mime_type: 'image/jpeg',
      },
      analyses: [
        {
          name: 'metadata',
          status: 'completed',
          observations: ['EXIF present'],
          metrics: { exif_present: true, field_count: 6, gps_present: true, parse_error_count: 0 },
          limitations: ['GPS withheld'],
          details: {
            exif_present: true,
            camera_make: 'Canon',
            camera_model: 'EOS R5',
            lens: 'RF 24-70mm',
            orientation: 1,
            capture_datetime: '2025-05-01T12:00:00Z',
            digitized_datetime: '2025-05-01T12:00:00Z',
            color_space: 'sRGB',
            exif_version: '0232',
            software: 'Adobe Photoshop 25.0',
            gps_present: true,
            gps_fields_present: ['GPSLatitude', 'GPSLongitude'],
            fields_found: ['camera_make', 'camera_model', 'lens', 'orientation'],
            fields_missing: [],
            parse_errors: [],
            format_notes: 'JPEG EXIF notes',
          },
        },
        {
          name: 'ela',
          status: 'completed',
          observations: ['ELA evaluated'],
          metrics: {},
          limitations: ['ELA limitation'],
          details: {
            recompression_quality: 90,
            scale_factor: 15,
            mean_difference: 1.25,
            median_difference: 1.0,
            max_difference: 17,
            p95_difference: 3.0,
            p99_difference: 6.0,
            threshold_percentages: { above_5: 2.5, above_10: 0.4 },
            channel_means: { red: 1.2, green: 1.1, blue: 1.4 },
            channel_maxes: { red: 15, green: 16, blue: 17 },
            regional_metrics: [
              {
                region_id: 'r0_c0',
                row: 0,
                col: 0,
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                mean_difference: 1.1,
                variance: 0.85,
                max_difference: 12,
              },
            ],
            regional_summary: { mean_min: 0.9, mean_max: 1.8, mean_spread: 0.9 },
            difference_image_data_url: 'data:image/png;base64,AAAA',
          },
        },
        ...(realSample.analyses as Array<Record<string, unknown>>).filter(
          (a) => a.name !== 'metadata' && a.name !== 'ela',
        ),
      ],
    };

    const normalized = normalizeInvestigation(jpegFixture);
    expect(normalized.imageEvidence?.exif?.lens).toBe('RF 24-70mm');
    expect(normalized.imageEvidence?.exif?.orientation).toBe(1);
    expect(normalized.imageEvidence?.exif?.colorSpace).toBe('sRGB');
    expect(normalized.imageEvidence?.exif?.exifVersion).toBe('0232');
    expect(normalized.imageEvidence?.exif?.gpsFieldsPresent).toEqual([
      'GPSLatitude',
      'GPSLongitude',
    ]);
    expect(normalized.imageEvidence?.ela?.thresholdPercentages).toEqual({
      above_5: 2.5,
      above_10: 0.4,
    });
    expect(normalized.imageEvidence?.ela?.channelMaxes?.blue).toBe(17);
    expect(normalized.imageEvidence?.ela?.regional?.[0]?.variance).toBe(0.85);
    expect(normalized.imageEvidence?.ela?.regionalSummary?.mean_spread).toBe(0.9);
  });
});
