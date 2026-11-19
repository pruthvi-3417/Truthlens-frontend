export const TRUTHLENS_CONTRACT_VERSION = '1.0.0' as const;
export const TRUTHLENS_MANIFEST_VERSION = '1.0.0' as const;
export const AUDIT_GENESIS_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000' as const;

export const EPHEMERAL_STORAGE_NOTICE =
  'Workspace case storage (workspace/cases/) is ephemeral local container storage for prototype investigation and audit verification. It is not permanent or legally certified immutable WORM storage; export portable case manifests for retention.' as const;

export type MaturityTier = 'A' | 'B' | 'C';
export type Modality = 'image' | 'video' | 'audio' | 'text';
export type CalibrationStatus = 'uncalibrated' | 'calibrated';

export interface CalibrationInfo {
  status: CalibrationStatus;
  label: string;
  sample_count?: number;
  ece?: number;
  notes?: string;
}

export const UNCALIBRATED_QUALITATIVE_INFO: CalibrationInfo = {
  status: 'uncalibrated',
  label: 'Uncalibrated — qualitative indicator only',
  notes:
    'No held-out calibration curve is attached to this indicator; treat observations qualitatively.',
};

export type AnalysisItemStatus =
  | 'ok'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'unavailable'
  | 'not_implemented';

export type AssessmentCategory =
  | 'NO_NOTABLE_VARIATION'
  | 'ISOLATED_OBSERVATION'
  | 'MIXED_OBSERVATIONS'
  | 'CONVERGING_OBSERVATIONS'
  | 'INSUFFICIENT_EVIDENCE';

export interface HealthResponse {
  application: string;
  status: 'healthy';
  version: string;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ImageProperties {
  filename: string | null;
  format: string;
  mime_type: string;
  size_bytes: number;
  size_readable: string;
  width: number;
  height: number;
  aspect_ratio: number;
  pixel_count: number;
  mode: string;
  has_transparency: boolean;
}

export interface MethodDocumentation {
  what_it_measures: string;
  assumptions: string[];
  limitations: string[];
  parameters: Record<string, string | number | boolean>;
}

export interface NormalizedRegionScore {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  raw_value: number;
  robust_z: number;
  signed_z: number;
  percentile_rank: number;
  normalized_score: number;
  flag_level: 'typical' | 'mild' | 'elevated';
}

export interface MetadataConsistencyCheck {
  check_id: string;
  name: string;
  status: 'consistent' | 'inconsistent' | 'informational' | 'unavailable';
  observation: string;
  limitations: string[];
}

export interface MetadataDetails {
  exif_present: boolean;
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  orientation: number | string | null;
  capture_datetime: string | null;
  digitized_datetime: string | null;
  color_space: string | null;
  exif_version: string | null;
  software: string | null;
  gps_present: boolean;
  gps_fields_present: string[];
  fields_found: string[];
  fields_missing: string[];
  parse_errors: string[];
  format_notes: string | null;
  embedded_thumbnail_present?: boolean;
  embedded_thumbnail_width?: number | null;
  embedded_thumbnail_height?: number | null;
  exif_image_width?: number | null;
  exif_image_height?: number | null;
  png_text_tags?: Record<string, string>;
  consistency_checks?: MetadataConsistencyCheck[];
  method_info?: MethodDocumentation;
}

export interface RegionalMetric {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mean_difference: number;
  variance: number;
  max_difference: number;
}

export interface RegionalNoiseMetric {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mean_difference: number;
  std: number;
  max_difference: number;
  flat_noise_std?: number | null;
}

export interface ELAMultiQualityPoint {
  quality: number;
  mean_difference: number;
  regional_mean_spread: number;
}

export interface ELADetails {
  recompression_quality: number;
  scale_factor: number;
  mean_difference: number;
  median_difference: number;
  max_difference: number;
  p95_difference: number;
  p99_difference: number;
  threshold_percentages: Record<string, number>;
  channel_means: Record<string, number>;
  channel_maxes: Record<string, number>;
  regional_metrics: RegionalMetric[];
  regional_summary: Record<string, number>;
  difference_image_data_url: string | null;
  multi_quality_curve?: ELAMultiQualityPoint[];
  region_grid_scores?: NormalizedRegionScore[];
  method_info?: MethodDocumentation;
}

export interface NoiseDetails {
  smoothing_sigma: number;
  residual_mean: number;
  residual_std: number;
  mean_absolute_residual: number;
  median_absolute_residual: number;
  max_absolute_residual: number;
  p95_absolute_residual: number;
  p99_absolute_residual: number;
  channel_residual_means: Record<string, number>;
  channel_residual_stds: Record<string, number>;
  channel_mean_absolute_residuals: Record<string, number>;
  regional_metrics: RegionalNoiseMetric[];
  regional_summary: Record<string, number>;
  visualization_data_url: string | null;
  flat_pixel_residual_std?: number;
  edge_pixel_residual_std?: number;
  flat_to_edge_noise_ratio?: number;
  region_grid_scores?: NormalizedRegionScore[];
  method_info?: MethodDocumentation;
}

export interface FrequencyDetails {
  analysis_width: number;
  analysis_height: number;
  original_width: number;
  original_height: number;
  is_downsampled: boolean;
  window_function: string;
  total_non_dc_power: number;
  low_frequency_power: number;
  mid_frequency_power: number;
  high_frequency_power: number;
  low_frequency_energy_pct: number;
  mid_frequency_energy_pct: number;
  high_frequency_energy_pct: number;
  spectral_centroid: number;
  spectral_entropy: number;
  band_boundaries: Record<string, number[]>;
  visualization_data_url: string | null;
  high_to_low_ratio?: number;
  spectral_rolloff_85?: number;
  azimuthal_spike_ratio?: number;
  region_grid_scores?: NormalizedRegionScore[];
  method_info?: MethodDocumentation;
}

export interface RecompressionQuantTableSummary {
  table_id: number;
  precision_bits: number;
  dc_value: number;
  ac_mean: number;
  high_freq_mean: number;
}

export interface RegionalBlockGridMetric {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  aligned_blockiness: number;
  dominant_offset: [number, number];
  aligned_vs_shifted_ratio: number;
}

export interface RecompressionDetails {
  format: string;
  jpeg_bitstream: {
    available: boolean;
    is_progressive: boolean | null;
    chroma_subsampling: string | null;
    dqt_table_count: number;
    estimated_ijg_quality: number | null;
    ijg_table_rmse: number | null;
    custom_or_nonstandard_tables: boolean | null;
    tables: RecompressionQuantTableSummary[];
    notes: string;
  };
  pixel_block_grid: {
    available: boolean;
    aligned_blockiness_ratio: number;
    max_shifted_blockiness_ratio: number;
    dominant_offset: [number, number];
    shifted_grid_detected: boolean;
    regional_block_grid: RegionalBlockGridMetric[];
    region_grid_scores: NormalizedRegionScore[];
  };
  double_jpeg_indicators: {
    status: 'not_applicable' | 'insufficient_contrast' | 'no_strong_indicator' | 'indicators_present';
    ela_curve_inflection_quality: number | null;
    ela_curve_non_monotonic: boolean;
    indicators: string[];
  };
  method_info: MethodDocumentation;
}

export interface RobustnessTransformResult {
  transform_id: string;
  label: string;
  noise_mean_abs_baseline: number;
  noise_mean_abs_perturbed: number;
  noise_retention_ratio: number;
  regional_pearson_corr: number;
  regional_top_k_iou: number;
  signal_retained: 'stable' | 'attenuated' | 'fragile' | 'insufficient_contrast';
}

export interface RobustnessDetails {
  baseline_valid: boolean;
  insufficient_contrast_reason: string | null;
  analysis_resolution: { width: number; height: number };
  overall_stability: 'stable' | 'moderately_sensitive' | 'fragile' | 'insufficient_evidence';
  duration_ms: number;
  transforms: RobustnessTransformResult[];
  method_info: MethodDocumentation;
}

export interface RegionalAnomalyItem {
  region_id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mean_luminance: number;
  std_luminance: number;
  min_luminance: number;
  max_luminance: number;
  mean_gradient: number;
  std_gradient: number;
  edge_density: number;
  noise_residual_std: number | null;
  noise_mean_abs: number | null;
  ela_mean: number | null;
  ela_variance: number | null;
  regional_fft_high_freq_ratio: number | null;
  deviation_score: number;
  neighbor_deviation: number;
  z_scores: Record<string, number>;
  observation: string;
  family_z_scores?: Record<string, number>;
  corroborating_families_count?: number;
  flat_region_surprise?: boolean;
}

export interface RegionalAnomalyDetails {
  grid_rows: number;
  grid_cols: number;
  total_regions: number;
  analyzed_features: string[];
  active_modules_used: string[];
  max_deviation_score: number;
  mean_deviation_score: number;
  highest_deviation_region_id: string | null;
  regional_anomalies: RegionalAnomalyItem[];
  regional_summary: Record<string, number>;
  visualization_data_url: string | null;
  region_grid_scores?: NormalizedRegionScore[];
  method_info?: MethodDocumentation;
}

export type SynthesisRelationship =
  | 'converging_observations'
  | 'isolated_observation'
  | 'mixed_observations'
  | 'insufficient_evidence'
  | 'no_notable_variation';

export interface EvidenceSummary {
  relationship: SynthesisRelationship;
  domains_available: number;
  domains_with_observations: number;
  primary_contributing_domains: string[];
  synthesis_statement: string;
}

export interface EvidenceDomainItem {
  domain_id: string;
  domain_name: string;
  status: 'available' | 'unavailable' | 'failed' | 'insufficient_data';
  has_notable_variation: boolean;
  summary: string;
  metrics: Record<string, unknown>;
  observations: string[];
}

export interface KeyObservation {
  observation_id: string;
  title: string;
  description: string;
  relevant_domains: string[];
  supporting_metrics: Record<string, unknown>;
  region_ids: string[];
  neutral_interpretation: string;
  limitations: string[];
}

export interface CrossDomainRelationship {
  domains: string[];
  relationship_type: 'converging' | 'diverging' | 'independent' | 'isolated';
  description: string;
  supporting_evidence: string[];
}

export interface RegionalSynthesisTile {
  region_id: string;
  row: number;
  col: number;
  variation_level: 'low' | 'typical' | 'elevated' | 'divergent';
  contributing_domains: string[];
  domain_count_with_variation: number;
  is_multi_domain_variation: boolean;
  neighbor_contrast: 'consistent' | 'moderate' | 'sharp';
  summary: string;
}

export interface RegionalSynthesis {
  grid_rows: number;
  grid_cols: number;
  total_regions: number;
  elevated_regions: string[];
  low_variation_regions: string[];
  multi_domain_regions: string[];
  single_domain_regions: string[];
  tiles: RegionalSynthesisTile[];
  summary: string;
}

export interface MethodologyInfo {
  version: string;
  correlated_feature_policy: string;
  aggregation_approach: string;
  disclaimer: string;
}

export interface SpatialCorroborationPair {
  method_a: string;
  method_b: string;
  top_k: number;
  iou: number;
  overlap_regions: string[];
  status: 'corroborated' | 'divergent' | 'insufficient_contrast';
}

export interface SynthesisDetails {
  evidence_summary: EvidenceSummary;
  domains: EvidenceDomainItem[];
  cross_domain_relationships: CrossDomainRelationship[];
  key_observations: KeyObservation[];
  regional_synthesis: RegionalSynthesis;
  limitations: string[];
  methodology: MethodologyInfo;
  spatial_corroboration?: {
    pairs: SpatialCorroborationPair[];
    edge_coupled_regions: string[];
    flat_surprise_regions: string[];
    abstained: boolean;
    abstention_reason: string | null;
    alternative_explanations: string[];
    recommended_human_checks: string[];
  };
}

export type AnalysisDetails =
  | MetadataDetails
  | ELADetails
  | NoiseDetails
  | FrequencyDetails
  | RecompressionDetails
  | RobustnessDetails
  | RegionalAnomalyDetails
  | SynthesisDetails
  | Record<string, unknown>
  | null;

export interface AnalysisItem {
  name: string;
  status: AnalysisItemStatus;
  tier?: MaturityTier;
  calibration?: CalibrationInfo;
  observations: string[];
  metrics: Record<string, unknown>;
  limitations: string[];
  details: AnalysisDetails;
}

export interface AssessmentPayload {
  status: 'INCOMPLETE' | 'INCONCLUSIVE' | 'COMPLETE';
  summary: string;
  limitations: string[];
  category?: AssessmentCategory;
  relationship?: SynthesisRelationship;
  maturity_tier?: MaturityTier;
  calibration?: CalibrationInfo;
}

export interface AnalyzeResponse {
  success: true;
  application: string;
  phase: 'phase_3';
  schema_version?: string;
  case_id?: string;
  evidence_id?: string;
  audit_head_hash?: string;
  analysis_timestamp?: string;
  maturity_tier?: MaturityTier;
  calibration?: CalibrationInfo;
  image_properties: ImageProperties;
  sha256: string;
  analyses: AnalysisItem[];
  assessment: AssessmentPayload;
}

// =============================================================================
// Phase 1 Evidence Preservation, Case, Analysis Run & Audit Chain Models
// =============================================================================

export type CaseStatus = 'open' | 'analyzed' | 'exported' | 'archived';

export interface EvidenceStorageRef {
  backend: 'local_workspace' | 'memory' | 'external';
  relative_path: string;
  read_only_mode: boolean;
  ephemeral_notice: string;
}

export interface EvidenceItemRecord {
  schema_version: string;
  evidence_id: string;
  case_id: string;
  modality: Modality;
  original_filename: string | null;
  declared_mime: string | null;
  sniffed_mime: string;
  detected_format: string;
  size_bytes: number;
  sha256: string;
  ingest_timestamp_utc: string;
  context_note: string | null;
  storage_ref: EvidenceStorageRef;
  hash_verified_at_utc: string;
}

export interface AnalysisRunRecord {
  schema_version: string;
  analysis_id: string;
  case_id: string;
  evidence_id: string;
  modality: Modality;
  tool_version: string;
  maturity_tier: MaturityTier;
  calibration: CalibrationInfo;
  created_at_utc: string;
  parameters: Record<string, unknown>;
  artifact_ref: string;
  result_sha256: string;
}

export interface FindingRecord {
  id: string;
  title: string;
  module: string;
  tier: MaturityTier;
  severity: 'low' | 'medium' | 'high' | 'informational';
  flagged_evidence: string;
  indicator: string;
  cross_modal_context: string;
  confidence: string;
  calibration_label: string;
  source_trace: string;
  summary: string;
  limitations: string[];
}

export type AuditEventType =
  | 'CASE_CREATED'
  | 'EVIDENCE_INGESTED'
  | 'HASH_VERIFIED'
  | 'ANALYSIS_STARTED'
  | 'ANALYSIS_COMPLETED'
  | 'ANALYSIS_FAILED'
  | 'CASE_EXPORTED'
  | 'CASE_IMPORTED'
  | 'INTEGRITY_CHECK';

export interface AuditEventPayload {
  schema_version: string;
  event_id: string;
  case_id: string;
  seq: number;
  timestamp_utc: string;
  event_type: AuditEventType;
  actor: string;
  evidence_id: string | null;
  analysis_id: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
}

export interface AuditEventRecord extends AuditEventPayload {
  event_hash: string;
}

export type AuditErrorReason =
  | 'INVALID_SCHEMA'
  | 'CASE_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'DUPLICATE_SEQUENCE'
  | 'OUT_OF_ORDER'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH';

export interface AuditVerificationError {
  index: number;
  seq: number | null;
  event_id: string | null;
  reason: AuditErrorReason;
  message: string;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  event_count: number;
  head_hash: string;
  errors: AuditVerificationError[];
}

export interface EvidenceVerificationResult {
  evidence_id: string;
  original_filename: string | null;
  expected_sha256: string;
  actual_sha256: string | null;
  expected_size_bytes: number;
  actual_size_bytes: number | null;
  file_present: boolean;
  valid: boolean;
  error?: string;
}

export interface CaseIntegrityReport {
  schema_version: string;
  case_id: string;
  verified_at_utc: string;
  valid: boolean;
  ephemeral_storage_notice: string;
  audit_verification: AuditChainVerificationResult;
  evidence_verifications: EvidenceVerificationResult[];
}

export interface CaseRecord {
  schema_version: string;
  case_id: string;
  created_at_utc: string;
  updated_at_utc: string;
  title: string;
  context_text: string | null;
  status: CaseStatus;
  storage_ephemeral_notice: string;
  evidence_items: EvidenceItemRecord[];
  analyses: AnalysisRunRecord[];
}

export interface ManifestEvidenceEntry extends EvidenceItemRecord {
  original_bytes_included: boolean;
  original_bytes_base64?: string;
}

export interface ManifestAnalysisEntry extends AnalysisRunRecord {
  result?: AnalyzeResponse;
}

export interface CaseManifestV1 {
  manifest_version: typeof TRUTHLENS_MANIFEST_VERSION;
  schema_version: typeof TRUTHLENS_CONTRACT_VERSION;
  exported_at_utc: string;
  exporter_tool: {
    name: string;
    version: string;
  };
  storage_notice: string;
  export_options: {
    include_original_evidence: boolean;
    include_analysis_results: boolean;
  };
  case: {
    case_id: string;
    created_at_utc: string;
    updated_at_utc: string;
    title: string;
    context_text: string | null;
    status: CaseStatus;
  };
  evidence_items: ManifestEvidenceEntry[];
  analyses: ManifestAnalysisEntry[];
  findings: FindingRecord[];
  audit_log: AuditEventRecord[];
  verification: {
    manifest_sha256: string;
    audit_chain_valid: boolean;
    audit_event_count: number;
    audit_head_hash: string;
    evidence_hashes: Record<string, string>;
  };
}
