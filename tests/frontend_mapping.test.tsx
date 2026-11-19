// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Results from '../frontend/src/pages/Results.tsx';
import { normalizeInvestigation } from '../frontend/src/services/analysisAdapter.ts';

const realSample = JSON.parse(
  fs.readFileSync(path.resolve('docs/samples/analyze_response.real.json'), 'utf-8'),
) as Record<string, unknown>;

describe('Results & ImageEvidenceDashboard Rendering of Mapped Backend Fields', () => {
  it('renders assessment summary, maturity tier, calibration tag, investigation ID, and preserved synthesis details', () => {
    const normalized = normalizeInvestigation(realSample);

    render(
      <MemoryRouter initialEntries={[{ pathname: '/results', state: { result: normalized } }]}>
        <Routes>
          <Route path="/results" element={<Results />} />
        </Routes>
      </MemoryRouter>,
    );

    // Assessment summary & calibration rendered instead of hardcoded placeholder
    expect(screen.getByText(/ASSESSMENT · TIER A/i)).toBeTruthy();
    expect(screen.getByText('REQUIRES REVIEW')).toBeTruthy();
    expect(screen.getByText(/Uncalibrated — qualitative indicator only/i)).toBeTruthy();
    expect(
      screen.getAllByText(/isolated statistical observation was identified in the Noise & Texture domain/i)
        .length,
    ).toBeGreaterThanOrEqual(2);

    // Investigation ID rendered cleanly (not hardcoded Unavailable)
    expect(screen.getAllByText(`TL-${String(realSample.sha256).slice(0, 12)}`).length).toBeGreaterThanOrEqual(1);

    // Preserved EXIF, Frequency, Regional, and Synthesis sections
    expect(screen.getByText(/PNG commonly lacks classic EXIF camera metadata/i)).toBeTruthy();
    expect(screen.getByText('hann')).toBeTruthy();
    expect(screen.getByText(/Evaluated 16 spatial partitions/i)).toBeTruthy();
    expect(screen.getByText(/Methodology \(v3\.0\)/i)).toBeTruthy();
  });

  it('renders Phase 2 Tier A sections (Double-JPEG & 8x8 block-grid, Perturbation robustness, Spatial corroboration, and Alternative explanations)', () => {
    const phase2Fixture: Record<string, unknown> = {
      ...realSample,
      analyses: [
        ...(realSample.analyses as Array<Record<string, unknown>>).map((a) => {
          if (a.name === 'metadata') {
            return {
              ...a,
              details: {
                ...(a.details as Record<string, unknown>),
                consistency_checks: [
                  {
                    check_id: 'META-CHRONOLOGY',
                    name: 'Timestamp chronology',
                    status: 'consistent',
                    observation: 'Populated EXIF timestamps show internally coherent chronological ordering.',
                    limitations: [],
                  },
                ],
              },
            };
          }
          if (a.name === 'synthesis') {
            return {
              ...a,
              details: {
                ...(a.details as Record<string, unknown>),
                spatial_corroboration: {
                  pairs: [
                    {
                      method_a: 'ela',
                      method_b: 'noise',
                      top_k: 3,
                      iou: 0.5,
                      overlap_regions: ['r1_c1'],
                      status: 'corroborated',
                    },
                  ],
                  edge_coupled_regions: [],
                  flat_surprise_regions: ['r1_c1'],
                  abstained: false,
                  abstention_reason: null,
                  alternative_explanations: ['Natural scene texture can elevate local contrast.'],
                  recommended_human_checks: ['Compare r1_c1 visually in ELA and noise maps.'],
                },
              },
            };
          }
          return a;
        }),
        {
          name: 'recompression',
          status: 'completed',
          tier: 'A',
          observations: ['DQT parsed'],
          metrics: {},
          limitations: [],
          details: {
            format: 'JPEG',
            jpeg_bitstream: {
              available: true,
              is_progressive: false,
              chroma_subsampling: '4:2:0',
              dqt_table_count: 2,
              estimated_ijg_quality: 88,
              ijg_table_rmse: 0,
              custom_or_nonstandard_tables: false,
              tables: [],
              notes: 'Parsed 2 DQT tables',
            },
            pixel_block_grid: {
              available: true,
              aligned_blockiness_ratio: 1.05,
              max_shifted_blockiness_ratio: 1.02,
              dominant_offset: [0, 0],
              shifted_grid_detected: false,
              regional_block_grid: [],
              region_grid_scores: [],
            },
            double_jpeg_indicators: {
              status: 'no_strong_indicator',
              ela_curve_inflection_quality: null,
              ela_curve_non_monotonic: false,
              indicators: [],
            },
            method_info: {
              what_it_measures: 'DQT + 8x8 grid',
              assumptions: [],
              limitations: [],
              parameters: {},
            },
          },
        },
        {
          name: 'robustness',
          status: 'completed',
          tier: 'A',
          observations: ['Stable under Q85/Q70'],
          metrics: {},
          limitations: [],
          details: {
            baseline_valid: true,
            insufficient_contrast_reason: null,
            analysis_resolution: { width: 256, height: 256 },
            overall_stability: 'stable',
            duration_ms: 42,
            transforms: [
              {
                transform_id: 'jpeg_q85',
                label: 'JPEG re-encode (Q=85)',
                noise_mean_abs_baseline: 2.0,
                noise_mean_abs_perturbed: 1.8,
                noise_retention_ratio: 0.9,
                regional_pearson_corr: 0.92,
                regional_top_k_iou: 1.0,
                signal_retained: 'stable',
              },
            ],
            method_info: {
              what_it_measures: 'Perturbation stability',
              assumptions: [],
              limitations: [],
              parameters: {},
            },
          },
        },
      ],
    };

    const normalized = normalizeInvestigation(phase2Fixture);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/results', state: { result: normalized } }]}>
        <Routes>
          <Route path="/results" element={<Results />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Double-JPEG & 8×8 block-grid/i)).toBeTruthy();
    expect(screen.getAllByText(/Perturbation robustness/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Metadata consistency checks/i)).toBeTruthy();
    expect(screen.getByText(/Cross-method spatial corroboration/i)).toBeTruthy();
    expect(screen.getByText(/Alternative explanations/i)).toBeTruthy();
    expect(screen.getByText(/Recommended human checks/i)).toBeTruthy();
  });
});
