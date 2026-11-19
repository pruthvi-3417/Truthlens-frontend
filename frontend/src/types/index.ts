import type {
  AssessmentCategory,
  CalibrationInfo,
  CrossDomainRelationship,
  ELAMultiQualityPoint,
  EvidenceDomainItem,
  EvidenceSummary,
  KeyObservation,
  MaturityTier,
  MetadataConsistencyCheck,
  MethodologyInfo,
  Modality,
  NormalizedRegionScore,
  RecompressionDetails,
  RegionalSynthesis,
  RobustnessDetails,
  SpatialCorroborationPair,
  SynthesisDetails,
  SynthesisRelationship,
} from '../../../shared/contracts.ts';
import type { LegacyAssessmentUiLabel } from '../../../shared/validation.ts';

export type {
  AssessmentCategory,
  CalibrationInfo,
  CrossDomainRelationship,
  ELAMultiQualityPoint,
  EvidenceDomainItem,
  EvidenceSummary,
  KeyObservation,
  MaturityTier,
  MetadataConsistencyCheck,
  MethodologyInfo,
  NormalizedRegionScore,
  RecompressionDetails,
  RegionalSynthesis,
  RobustnessDetails,
  SpatialCorroborationPair,
  SynthesisRelationship,
};

export type MediaType = Modality;
export type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unavailable';
export type Assessment = LegacyAssessmentUiLabel;
export type Severity = 'low' | 'medium' | 'high' | 'informational';

export interface AssessmentDetail {
  status: 'INCOMPLETE' | 'INCONCLUSIVE' | 'COMPLETE';
  label: Assessment;
  category: AssessmentCategory;
  relationship?: SynthesisRelationship;
  summary: string;
  limitations: string[];
  maturityTier: MaturityTier;
  calibration: CalibrationInfo;
}

export interface MediaFile {
  file: globalThis.File;
  type: MediaType;
  previewUrl?: string;
}

export interface RGBMeasurements {
  red?: number;
  green?: number;
  blue?: number;
  r?: number;
  g?: number;
  b?: number;
  mean?: number;
  [key: string]: number | undefined;
}

export interface RegionalMeasurement {
  row?: number;
  column?: number;
  region?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  value?: number;
  variance?: number;
  std?: number;
  maxDifference?: number;
  meanLuminance?: number;
  stdLuminance?: number;
  minLuminance?: number;
  maxLuminance?: number;
  meanGradient?: number;
  stdGradient?: number;
  edgeDensity?: number;
  noiseResidualStd?: number | null;
  noiseMeanAbs?: number | null;
  elaMean?: number | null;
  elaVariance?: number | null;
  regionalFftHighFreqRatio?: number | null;
  deviationScore?: number;
  neighborDeviation?: number;
  zScores?: Record<string, number>;
  familyZScores?: Record<string, number>;
  corroboratingFamiliesCount?: number;
  flatRegionSurprise?: boolean;
  observation?: string;
  measurements?: RGBMeasurements | Record<string, number>;
  [key: string]: unknown;
}

export interface EXIFMetadata {
  exifPresent?: boolean;
  cameraManufacturer?: string;
  cameraModel?: string;
  lens?: string;
  orientation?: number | string;
  originalTimestamp?: string;
  modificationTimestamp?: string;
  colorSpace?: string;
  exifVersion?: string;
  editingSoftware?: string;
  gpsPresent?: boolean;
  gpsFieldsPresent?: string[];
  fieldsFound?: string[];
  fieldsMissing?: string[];
  parseErrors?: string[];
  formatNotes?: string;
  embeddedThumbnailPresent?: boolean;
  embeddedThumbnailWidth?: number | null;
  embeddedThumbnailHeight?: number | null;
  exifImageWidth?: number | null;
  exifImageHeight?: number | null;
  consistencyChecks?: MetadataConsistencyCheck[];
  unavailable?: string[];
  [key: string]: unknown;
}

export interface ELAProvisionalResult {
  status: AnalysisStatus;
  visualizationUrl?: string;
  recompressionQuality?: number;
  scaleFactor?: number;
  difference?: Record<string, number>;
  thresholdPercentages?: Record<string, number>;
  rgb?: RGBMeasurements;
  channelMaxes?: RGBMeasurements;
  regionalSummary?: Record<string, number>;
  regional?: RegionalMeasurement[];
  multiQualityCurve?: ELAMultiQualityPoint[];
  regionGridScores?: NormalizedRegionScore[];
  observations?: string[];
  limitations?: string[];
}

export interface NoiseResidualProvisionalResult {
  status: AnalysisStatus;
  visualizationUrl?: string;
  smoothingSigma?: number;
  gaussianSmoothing?: string | Record<string, unknown>;
  statistics?: Record<string, number>;
  rgb?: RGBMeasurements;
  channelResidualMeans?: RGBMeasurements;
  channelResidualStds?: RGBMeasurements;
  flatPixelResidualStd?: number;
  edgePixelResidualStd?: number;
  flatToEdgeNoiseRatio?: number;
  regionalSummary?: Record<string, number>;
  regional?: RegionalMeasurement[];
  regionGridScores?: NormalizedRegionScore[];
  observations?: string[];
  limitations?: string[];
}

export interface RecompressionProvisionalResult {
  status: AnalysisStatus;
  details?: RecompressionDetails;
  observations?: string[];
  limitations?: string[];
}

export interface RobustnessProvisionalResult {
  status: AnalysisStatus;
  details?: RobustnessDetails;
  observations?: string[];
  limitations?: string[];
}

export interface EvidenceInterpretation {
  observedIndicators?: string[];
  supportingEvidence?: string[];
  potentialAnomalies?: string[];
  limitations?: string[];
  interpretationNotes?: string[];
  evidenceSummary?: EvidenceSummary;
  domains?: EvidenceDomainItem[];
  crossDomainRelationships?: CrossDomainRelationship[];
  keyObservations?: KeyObservation[];
  regionalSynthesis?: RegionalSynthesis;
  methodology?: MethodologyInfo;
  spatialCorroboration?: SynthesisDetails['spatial_corroboration'];
}

export interface FrequencyProvisionalResult {
  status: AnalysisStatus;
  visualizationUrl?: string;
  analysisWidth?: number;
  analysisHeight?: number;
  originalWidth?: number;
  originalHeight?: number;
  windowFunction?: string;
  totalNonDcPower?: number;
  lowFrequencyPower?: number;
  midFrequencyPower?: number;
  highFrequencyPower?: number;
  bandBoundaries?: Record<string, number[]>;
  statistics?: Record<string, number | boolean>;
  observations?: string[];
  limitations?: string[];
}

export interface RegionalProvisionalResult {
  status: AnalysisStatus;
  visualizationUrl?: string;
  gridRows?: number;
  gridCols?: number;
  analyzedFeatures?: string[];
  activeModulesUsed?: string[];
  regionalSummary?: Record<string, number>;
  statistics?: Record<string, number | string | null>;
  regional?: RegionalMeasurement[];
  observations?: string[];
  limitations?: string[];
}

export interface ImageForensicEvidence {
  status: AnalysisStatus;
  caseId?: string;
  evidenceId?: string;
  auditHeadHash?: string;
  originalImageUrl?: string;
  fileFormat?: string;
  mimeType?: string;
  fileSize?: number;
  sizeReadable?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  pixelCount?: number;
  mode?: string;
  hasTransparency?: boolean;
  resolution?: string;
  sha256?: string;
  exif?: EXIFMetadata;
  ela?: ELAProvisionalResult;
  noise?: NoiseResidualProvisionalResult;
  frequency?: FrequencyProvisionalResult;
  recompression?: RecompressionProvisionalResult;
  robustness?: RobustnessProvisionalResult;
  regional?: RegionalProvisionalResult;
  frequencyStatus?: AnalysisStatus;
  recompressionStatus?: AnalysisStatus;
  robustnessStatus?: AnalysisStatus;
  regionalStatus?: AnalysisStatus;
  evidenceStatus?: AnalysisStatus;
  evidence?: EvidenceInterpretation;
}

export interface ImageProperties {
  width?: number;
  height?: number;
  format?: string;
  size?: number;
  mimeType?: string;
  sizeReadable?: string;
  aspectRatio?: number;
  pixelCount?: number;
  mode?: string;
  hasTransparency?: boolean;
}

export interface VideoProperties {
  width?: number;
  height?: number;
  duration?: number;
  frameRate?: number;
}
export interface AudioProperties {
  duration?: number;
  sampleRate?: number;
  channels?: number;
}
export interface TextInput {
  content: string;
  sourceName?: string;
}
export interface ModuleStatus {
  name: string;
  status: AnalysisStatus;
  tier?: MaturityTier;
}
export interface MetadataResult {
  exif?: Record<string, unknown>;
  observations?: string[];
}
export interface ELAResult {
  status: AnalysisStatus;
  observations?: string[];
  evidenceUrl?: string;
}
export interface NoiseResult {
  status: AnalysisStatus;
  observations?: string[];
}
export interface FrequencyResult {
  status: AnalysisStatus;
  observations?: string[];
}
export interface VideoAnalysisResult {
  status: AnalysisStatus;
  frameObservations?: string[];
  temporalObservations?: string[];
  synchronizationObservations?: string[];
}
export interface AudioAnalysisResult {
  status: AnalysisStatus;
  metadata?: Record<string, unknown>;
  waveformUrl?: string;
  spectrogramUrl?: string;
  observations?: string[];
}
export interface TextAnalysisResult {
  status: AnalysisStatus;
  linguisticObservations?: string[];
  manipulationIndicators?: string[];
}
export interface CrossModalResult {
  status: AnalysisStatus;
  observations?: string[];
}
export interface Finding {
  id: string;
  title: string;
  severity?: Severity;
  module: string;
  tier?: MaturityTier;
  observation: string;
  interpretation?: string;
  evidenceReference?: string;
  limitations?: string;
  flaggedEvidence?: string;
  indicator?: string;
  crossModalContext?: string;
  confidence?: string;
  calibrationLabel?: string;
  sourceTrace?: string;
  summary?: string;
  limitationsList?: string[];
}

export interface InvestigationResult {
  id?: string;
  schemaVersion?: string;
  caseId?: string;
  evidenceId?: string;
  auditHeadHash?: string;
  maturityTier?: MaturityTier;
  calibration?: CalibrationInfo;
  filenames: string[];
  mediaTypes: MediaType[];
  timestamp?: string;
  imageProperties?: ImageProperties;
  videoProperties?: VideoProperties;
  audioProperties?: AudioProperties;
  sha256?: string[];
  fileFormat?: string;
  fileSize?: number;
  analysisStatus?: AnalysisStatus;
  imageEvidence?: ImageForensicEvidence;
  assessment?: Assessment;
  assessmentDetail?: AssessmentDetail;
  modules: ModuleStatus[];
  findings: Finding[];
  metadata?: MetadataResult;
  ela?: ELAResult;
  noise?: NoiseResult;
  frequency?: FrequencyResult;
  video?: VideoAnalysisResult;
  audio?: AudioAnalysisResult;
  text?: TextAnalysisResult;
  crossModal?: CrossModalResult;
}

export interface Report {
  id: string;
  investigationId: string;
  generatedAt: string;
  filenames: string[];
  assessment?: Assessment;
  downloadUrl?: string;
}
