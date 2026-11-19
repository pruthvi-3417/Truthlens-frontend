import type {
  AnalysisItem,
  CrossDomainRelationship,
  ELADetails,
  EvidenceDomainItem,
  EvidenceSummary,
  FrequencyDetails,
  KeyObservation,
  MetadataDetails,
  MethodologyInfo,
  NoiseDetails,
  RecompressionDetails,
  RegionalAnomalyDetails,
  RegionalSynthesis,
  RegionalSynthesisTile,
  RobustnessDetails,
  SpatialCorroborationPair,
  SynthesisDetails,
} from '../types.ts';
import { computeTopKCellAgreement } from './gridNormalization.ts';

const SYNTHESIS_VERSION = '3.1';

const KNOWN_EDITING_SOFTWARE_KEYWORDS = [
  'photoshop',
  'gimp',
  'lightroom',
  'canva',
  'snapseed',
  'paint.net',
  'pixlr',
  'affinity',
  'vsco',
  'facetune',
  'picsart',
  'coreldraw',
] as const;

function round(val: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function evaluateMetadataDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'metadata',
      domain_name: 'Metadata & Provenance',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Metadata extraction was unavailable for this image.',
      metrics: {},
      observations: ['No metadata extraction was performed.'],
    };
  }

  if (item.status === 'failed') {
    return {
      domain_id: 'metadata',
      domain_name: 'Metadata & Provenance',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Metadata extraction encountered an unhandled error.',
      metrics: {},
      observations: item.observations.length ? item.observations : ['Metadata extraction failed.'],
    };
  }

  const details = item.details as MetadataDetails | null;
  if (!details) {
    return {
      domain_id: 'metadata',
      domain_name: 'Metadata & Provenance',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Metadata details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  const isEditingSoftware = Boolean(
    details.software &&
      KNOWN_EDITING_SOFTWARE_KEYWORDS.some((kw) => details.software!.toLowerCase().includes(kw)),
  );
  const inconsistentChecks = (details.consistency_checks ?? []).filter(
    (c) => c.status === 'inconsistent',
  );
  const hasCameraInfo = Boolean(details.camera_make || details.camera_model);
  const hasNotableVariation =
    isEditingSoftware || details.parse_errors.length > 0 || inconsistentChecks.length > 0;

  let summary: string;
  if (inconsistentChecks.length > 0) {
    summary = `Metadata consistency check flagged ${inconsistentChecks.map((c) => c.name).join(', ')}.`;
  } else if (!details.exif_present) {
    summary =
      'No EXIF metadata was detected. Metadata absence is common across web uploads, messaging platforms, screenshots, and stripped exports; it does not indicate manipulation.';
  } else if (isEditingSoftware) {
    summary = `EXIF metadata indicates image editing or export software (${details.software}). This confirms software-assisted processing or export.`;
  } else if (hasCameraInfo) {
    summary = `Camera hardware provenance metadata detected (${details.camera_make ?? ''} ${details.camera_model ?? ''}). Standard capture metadata fields are populated.`;
  } else {
    summary = 'EXIF metadata is present with basic capture or format properties.';
  }

  return {
    domain_id: 'metadata',
    domain_name: 'Metadata & Provenance',
    status: 'available',
    has_notable_variation: hasNotableVariation,
    summary,
    metrics: {
      exif_present: details.exif_present,
      has_camera_info: hasCameraInfo,
      camera_make: details.camera_make,
      camera_model: details.camera_model,
      software: details.software,
      is_editing_software_indicated: isEditingSoftware,
      capture_datetime: details.capture_datetime,
      gps_present: details.gps_present,
      fields_found_count: details.fields_found.length,
      fields_missing_count: details.fields_missing.length,
      parse_error_count: details.parse_errors.length,
      inconsistent_check_count: inconsistentChecks.length,
      inconsistent_check_names: inconsistentChecks.map((c) => c.name),
    },
    observations: item.observations,
  };
}

function evaluateCompressionDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'compression',
      domain_name: 'Compression & Recompression',
      status: 'unavailable',
      has_notable_variation: false,
      summary:
        'Error Level Analysis is unavailable for this image format. ELA is specifically designed for JPEG lossy DCT compression artifacts.',
      metrics: {},
      observations: ['Compression analysis skipped: non-JPEG format.'],
    };
  }

  if (item.status === 'failed') {
    return {
      domain_id: 'compression',
      domain_name: 'Compression & Recompression',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Error Level Analysis failed to compute.',
      metrics: {},
      observations: item.observations.length ? item.observations : ['ELA computation failed.'],
    };
  }

  const details = item.details as ELADetails | null;
  if (!details) {
    return {
      domain_id: 'compression',
      domain_name: 'Compression & Recompression',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'ELA details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  const meanSpread = details.regional_summary.mean_spread ?? 0;
  const above20Pct = details.threshold_percentages.above_20 ?? 0;
  const maxGridZ = Math.max(0, ...(details.region_grid_scores ?? []).map((r) => r.robust_z));
  const hasNotableVariation =
    (meanSpread >= 4.0 && above20Pct >= 5.0) ||
    details.mean_difference >= 18.0 ||
    (maxGridZ >= 3.0 && meanSpread >= 1.5);

  const summary = hasNotableVariation
    ? `Spatial variation in recompression error levels observed (regional spread: ${meanSpread.toFixed(2)}, global mean difference: ${details.mean_difference.toFixed(2)}). Error levels reflect differing edge density or compression histories.`
    : `Recompression error levels are relatively uniform across the image (mean difference: ${details.mean_difference.toFixed(2)}, regional spread: ${meanSpread.toFixed(2)}).`;

  return {
    domain_id: 'compression',
    domain_name: 'Compression & Recompression',
    status: 'available',
    has_notable_variation: hasNotableVariation,
    summary,
    metrics: {
      recompression_quality: details.recompression_quality,
      mean_difference: round(details.mean_difference, 4),
      max_difference: round(details.max_difference, 4),
      p95_difference: round(details.p95_difference, 4),
      p99_difference: round(details.p99_difference, 4),
      regional_mean_spread: round(meanSpread, 4),
      pixels_above_threshold_20_pct: round(above20Pct, 2),
      max_region_z: round(maxGridZ, 4),
    },
    observations: item.observations,
  };
}

function evaluateRecompressionDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'recompression',
      domain_name: 'Quantization & 8x8 Block Grid',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Recompression and 8x8 block-grid analysis was unavailable.',
      metrics: {},
      observations: [],
    };
  }
  if (item.status === 'failed') {
    return {
      domain_id: 'recompression',
      domain_name: 'Quantization & 8x8 Block Grid',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Recompression and 8x8 block-grid analysis failed.',
      metrics: {},
      observations: item.observations,
    };
  }
  const details = item.details as RecompressionDetails | null;
  if (!details) {
    return {
      domain_id: 'recompression',
      domain_name: 'Quantization & 8x8 Block Grid',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Recompression details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  if (details.double_jpeg_indicators.status === 'insufficient_contrast') {
    return {
      domain_id: 'recompression',
      domain_name: 'Quantization & 8x8 Block Grid',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary:
        'Insufficient image size or luminance contrast to evaluate pixel-domain 8x8 block-grid periodicity.',
      metrics: {},
      observations: item.observations,
    };
  }

  // Flag notable variation on structural recompression indicators (shifted 8x8 grid, prior-JPEG blockiness in lossless pixels, non-monotonic ELA curve)
  // Avoid triggering solely on custom camera/Adobe DQT tables without structural evidence
  const hasStructuralIndicator =
    details.pixel_block_grid.shifted_grid_detected ||
    details.double_jpeg_indicators.ela_curve_non_monotonic ||
    (details.format !== 'JPEG' && details.pixel_block_grid.aligned_blockiness_ratio >= 1.12);

  const summary = hasStructuralIndicator
    ? `Structural recompression or 8x8 block-grid periodicity indicators observed: ${details.double_jpeg_indicators.indicators.join(' ')}`
    : `8x8 block-grid scan (${details.pixel_block_grid.aligned_blockiness_ratio.toFixed(2)} aligned ratio) shows no strong shifted grid or multi-generation inflection indicators.`;

  return {
    domain_id: 'recompression',
    domain_name: 'Quantization & 8x8 Block Grid',
    status: 'available',
    has_notable_variation: hasStructuralIndicator,
    summary,
    metrics: {
      estimated_ijg_quality: details.jpeg_bitstream.estimated_ijg_quality,
      custom_or_nonstandard_tables: details.jpeg_bitstream.custom_or_nonstandard_tables,
      aligned_blockiness_ratio: details.pixel_block_grid.aligned_blockiness_ratio,
      max_shifted_blockiness_ratio: details.pixel_block_grid.max_shifted_blockiness_ratio,
      shifted_grid_detected: details.pixel_block_grid.shifted_grid_detected,
      ela_curve_non_monotonic: details.double_jpeg_indicators.ela_curve_non_monotonic,
      indicators: details.double_jpeg_indicators.indicators,
    },
    observations: item.observations,
  };
}

function evaluateNoiseDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'noise',
      domain_name: 'Noise & Texture',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Noise residual analysis was unavailable.',
      metrics: {},
      observations: [],
    };
  }

  if (item.status === 'failed') {
    return {
      domain_id: 'noise',
      domain_name: 'Noise & Texture',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Noise residual analysis failed to compute.',
      metrics: {},
      observations: item.observations.length
        ? item.observations
        : ['Noise residual computation failed.'],
    };
  }

  const details = item.details as NoiseDetails | null;
  if (!details) {
    return {
      domain_id: 'noise',
      domain_name: 'Noise & Texture',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Noise details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  const stdMin = details.regional_summary.std_min ?? 0;
  const stdMax = details.regional_summary.std_max ?? 0;
  const stdMean = details.regional_summary.std_mean ?? 0;
  const stdSpread = round(stdMax - stdMin, 4);
  const heterogeneity = stdMean > 0 ? stdSpread / Math.max(1.0, stdMean) : 0;
  const maxGridZ = Math.max(0, ...(details.region_grid_scores ?? []).map((r) => r.robust_z));
  const hasNotableVariation =
    (stdSpread >= 3.0 && heterogeneity >= 0.5) ||
    (maxGridZ >= 2.5 && stdSpread >= 1.2 && details.residual_std >= 0.4);

  const summary = hasNotableVariation
    ? `Regional variation in high-frequency residual distribution observed (residual std spread: ${stdSpread.toFixed(2)}, heterogeneity ratio: ${heterogeneity.toFixed(2)}).`
    : `High-frequency residual patterns are spatially consistent (residual std: ${details.residual_std.toFixed(2)}, regional std spread: ${stdSpread.toFixed(2)}).`;

  return {
    domain_id: 'noise',
    domain_name: 'Noise & Texture',
    status: 'available',
    has_notable_variation: hasNotableVariation,
    summary,
    metrics: {
      residual_std: round(details.residual_std, 4),
      residual_mean: round(details.residual_mean, 4),
      mean_absolute_residual: round(details.mean_absolute_residual, 4),
      p95_absolute_residual: round(details.p95_absolute_residual, 4),
      flat_pixel_residual_std: details.flat_pixel_residual_std ?? null,
      edge_pixel_residual_std: details.edge_pixel_residual_std ?? null,
      regional_std_spread: stdSpread,
      regional_noise_heterogeneity: round(heterogeneity, 4),
      max_region_z: round(maxGridZ, 4),
    },
    observations: item.observations,
  };
}

function evaluateFrequencyDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'frequency',
      domain_name: 'Frequency Spectrum',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Frequency domain analysis was unavailable.',
      metrics: {},
      observations: [],
    };
  }

  if (item.status === 'failed') {
    return {
      domain_id: 'frequency',
      domain_name: 'Frequency Spectrum',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Frequency domain analysis failed to compute.',
      metrics: {},
      observations: item.observations.length ? item.observations : ['Frequency analysis failed.'],
    };
  }

  const details = item.details as FrequencyDetails | null;
  if (!details) {
    return {
      domain_id: 'frequency',
      domain_name: 'Frequency Spectrum',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Frequency details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  const isHighHeavy = details.high_frequency_energy_pct >= 55.0;
  const isLowHeavy = details.low_frequency_energy_pct >= 85.0;
  const isLowEntropy = details.spectral_entropy <= 0.4 && details.total_non_dc_power > 0;
  const hasAzimuthalSpikes = (details.azimuthal_spike_ratio ?? 1) >= 25.0;
  const hasNotableVariation = isHighHeavy || isLowHeavy || isLowEntropy || hasAzimuthalSpikes;

  let summary: string;
  if (details.total_non_dc_power === 0) {
    summary =
      'Zero non-DC spectral energy detected; image has completely uniform constant luminance.';
  } else if (hasAzimuthalSpikes) {
    summary = `Elevated periodic azimuthal spectral spikes detected (peak-to-median ratio: ${details.azimuthal_spike_ratio?.toFixed(2)}); can indicate resampling, halftone patterns, or upsampling periodicity.`;
  } else if (isHighHeavy) {
    summary = `Elevated concentration of high-frequency spectral power (${details.high_frequency_energy_pct.toFixed(1)}%); consistent with fine texture, sharp boundaries, or high-frequency grain.`;
  } else if (isLowHeavy) {
    summary = `Predominant concentration of low-frequency spectral power (${details.low_frequency_energy_pct.toFixed(1)}%); typical of smooth gradients, broad structural content, or blur.`;
  } else {
    summary = `Balanced frequency spectrum distribution (low: ${details.low_frequency_energy_pct.toFixed(1)}%, mid: ${details.mid_frequency_energy_pct.toFixed(1)}%, high: ${details.high_frequency_energy_pct.toFixed(1)}%, centroid: ${details.spectral_centroid.toFixed(3)}).`;
  }

  return {
    domain_id: 'frequency',
    domain_name: 'Frequency Spectrum',
    status: 'available',
    has_notable_variation: hasNotableVariation,
    summary,
    metrics: {
      total_non_dc_power: round(details.total_non_dc_power, 4),
      low_frequency_energy_pct: round(details.low_frequency_energy_pct, 2),
      mid_frequency_energy_pct: round(details.mid_frequency_energy_pct, 2),
      high_frequency_energy_pct: round(details.high_frequency_energy_pct, 2),
      spectral_centroid: round(details.spectral_centroid, 4),
      spectral_entropy: round(details.spectral_entropy, 4),
      spectral_rolloff_85: details.spectral_rolloff_85 ?? null,
      azimuthal_spike_ratio: details.azimuthal_spike_ratio ?? null,
      is_downsampled: details.is_downsampled,
    },
    observations: item.observations,
  };
}

function evaluateSpatialDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'spatial',
      domain_name: 'Spatial Consistency',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Regional anomaly analysis was unavailable.',
      metrics: {},
      observations: [],
    };
  }

  if (item.status === 'failed') {
    return {
      domain_id: 'spatial',
      domain_name: 'Spatial Consistency',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Regional anomaly analysis failed to compute.',
      metrics: {},
      observations: item.observations.length ? item.observations : ['Regional analysis failed.'],
    };
  }

  const details = item.details as RegionalAnomalyDetails | null;
  if (!details) {
    return {
      domain_id: 'spatial',
      domain_name: 'Spatial Consistency',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Regional anomaly details were not returned.',
      metrics: {},
      observations: [],
    };
  }

  const elevatedCount = details.regional_anomalies.filter((r) => r.deviation_score >= 1.5).length;
  const flatSurpriseRegions = details.regional_anomalies
    .filter((r) => r.flat_region_surprise)
    .map((r) => r.region_id);
  const hasNotableVariation = details.max_deviation_score >= 2.0 || flatSurpriseRegions.length > 0;

  let summary: string;
  if (hasNotableVariation) {
    summary = `Localized statistical deviation observed across spatial partitions (peak deviation: ${details.max_deviation_score.toFixed(2)} in region ${details.highest_deviation_region_id}, mean deviation: ${details.mean_deviation_score.toFixed(2)}); provides supporting spatial localization.`;
  } else if (details.max_deviation_score < 1.0) {
    summary = 'Spatial properties are highly homogeneous across all grid partitions.';
  } else {
    summary = `Mild spatial variation observed within expected distribution (peak deviation: ${details.max_deviation_score.toFixed(2)}, mean deviation: ${details.mean_deviation_score.toFixed(2)}); provides supporting spatial localization.`;
  }

  return {
    domain_id: 'spatial',
    domain_name: 'Spatial Consistency',
    status: 'available',
    has_notable_variation: hasNotableVariation,
    summary,
    metrics: {
      grid_total_regions: details.total_regions,
      max_deviation_score: round(details.max_deviation_score, 4),
      mean_deviation_score: round(details.mean_deviation_score, 4),
      highest_deviation_region_id: details.highest_deviation_region_id,
      elevated_regions_count: elevatedCount,
      flat_surprise_regions: flatSurpriseRegions,
    },
    observations: item.observations,
  };
}

function evaluateRobustnessDomain(item: AnalysisItem | undefined): EvidenceDomainItem {
  if (!item || item.status === 'unavailable') {
    return {
      domain_id: 'robustness',
      domain_name: 'Perturbation Robustness',
      status: 'unavailable',
      has_notable_variation: false,
      summary: 'Robustness stress testing was not executed.',
      metrics: {},
      observations: [],
    };
  }
  if (item.status === 'failed') {
    return {
      domain_id: 'robustness',
      domain_name: 'Perturbation Robustness',
      status: 'failed',
      has_notable_variation: false,
      summary: 'Robustness stress testing failed.',
      metrics: {},
      observations: item.observations,
    };
  }
  const details = item.details as RobustnessDetails | null;
  if (!details) {
    return {
      domain_id: 'robustness',
      domain_name: 'Perturbation Robustness',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary: 'Robustness details were not returned.',
      metrics: {},
      observations: [],
    };
  }
  if (!details.baseline_valid) {
    return {
      domain_id: 'robustness',
      domain_name: 'Perturbation Robustness',
      status: 'insufficient_data',
      has_notable_variation: false,
      summary:
        details.insufficient_contrast_reason ??
        'Baseline spatial contrast was below the stability tracking floor.',
      metrics: {
        overall_stability: details.overall_stability,
        duration_ms: details.duration_ms,
      },
      observations: item.observations,
    };
  }

  return {
    domain_id: 'robustness',
    domain_name: 'Perturbation Robustness',
    status: 'available',
    has_notable_variation: details.overall_stability === 'fragile',
    summary: `Perturbation stability under JPEG Q85, JPEG Q70, and 0.75x resampling classified as '${details.overall_stability}'.`,
    metrics: {
      overall_stability: details.overall_stability,
      duration_ms: details.duration_ms,
      transforms: details.transforms.map((t) => ({
        transform_id: t.transform_id,
        retention_ratio: t.noise_retention_ratio,
        regional_pearson_corr: t.regional_pearson_corr,
        signal_retained: t.signal_retained,
      })),
    },
    observations: item.observations,
  };
}

function synthesizeRegionalTiles(regItem: AnalysisItem | undefined) {
  const empty = {
    tiles: [] as RegionalSynthesisTile[],
    elevatedRegions: [] as string[],
    lowVariationRegions: [] as string[],
    multiDomainRegions: [] as string[],
    singleDomainRegions: [] as string[],
    edgeCoupledRegions: [] as string[],
    flatSurpriseRegions: [] as string[],
  };
  if (!regItem || !regItem.details) return empty;
  const details = regItem.details as RegionalAnomalyDetails;
  const anomalies = details.regional_anomalies ?? [];
  if (!anomalies.length) return empty;

  const tiles: RegionalSynthesisTile[] = [];
  const elevatedRegions: string[] = [];
  const lowVariationRegions: string[] = [];
  const multiDomainRegions: string[] = [];
  const singleDomainRegions: string[] = [];
  const edgeCoupledRegions: string[] = [];
  const flatSurpriseRegions: string[] = [];

  for (const reg of anomalies) {
    const zDict = reg.z_scores ?? {};
    const domainZScores: Record<string, number> = {};

    const textureKeys = ['mean_gradient', 'std_gradient', 'edge_density'].filter(
      (k) => zDict[k] !== undefined,
    );
    if (textureKeys.length) {
      domainZScores.Texture = mean(textureKeys.map((k) => zDict[k]));
    }

    const lumKeys = ['std_luminance', 'mean_luminance'].filter((k) => zDict[k] !== undefined);
    if (lumKeys.length) {
      domainZScores.Luminance = mean(lumKeys.map((k) => zDict[k]));
    }

    const noiseKeys = ['noise_residual_std', 'noise_mean_abs'].filter(
      (k) => zDict[k] !== undefined,
    );
    if (noiseKeys.length) {
      domainZScores.Noise = mean(noiseKeys.map((k) => zDict[k]));
    }

    const elaKeys = ['ela_mean', 'ela_variance'].filter((k) => zDict[k] !== undefined);
    if (elaKeys.length) {
      domainZScores.Compression = mean(elaKeys.map((k) => zDict[k]));
    }

    if (zDict.regional_fft_high_freq_ratio !== undefined) {
      domainZScores.Frequency = zDict.regional_fft_high_freq_ratio;
    }

    if (reg.family_z_scores?.block_grid !== undefined) {
      domainZScores.BlockGrid = reg.family_z_scores.block_grid;
    }

    const domainValues = Object.values(domainZScores);
    const compDev = round(
      domainValues.length ? mean(domainValues) : reg.deviation_score,
      4,
    );

    const contributing = Object.entries(domainZScores)
      .filter(([, zVal]) => zVal >= 1.8)
      .map(([dName]) => dName);
    const domainCount = contributing.length;
    const isMultiDomain = domainCount >= 2;

    if (reg.flat_region_surprise) {
      flatSurpriseRegions.push(reg.region_id);
    } else if (
      (domainZScores.Texture ?? 0) >= 1.5 &&
      contributing.some((c) => ['Noise', 'Compression', 'Frequency', 'BlockGrid'].includes(c))
    ) {
      edgeCoupledRegions.push(reg.region_id);
    }

    let varLevel: RegionalSynthesisTile['variation_level'];
    if (domainCount >= 3 || compDev >= 3.0) {
      varLevel = 'divergent';
    } else if (isMultiDomain || compDev >= 1.5 || reg.flat_region_surprise) {
      varLevel = 'elevated';
    } else if (domainCount === 0 && compDev <= 0.4) {
      varLevel = 'low';
    } else {
      varLevel = 'typical';
    }

    let contrast: RegionalSynthesisTile['neighbor_contrast'];
    if (reg.neighbor_deviation >= 1.8) contrast = 'sharp';
    else if (reg.neighbor_deviation >= 0.9) contrast = 'moderate';
    else contrast = 'consistent';

    let summary: string;
    if (reg.flat_region_surprise) {
      summary = `Flat-region forensic surprise (${contributing.join(', ') || 'forensic family'}); elevated signal without proportional edge/texture density.`;
    } else if (isMultiDomain) {
      summary = `Multi-domain statistical variation (${contributing.join(', ')}); composite deviation: ${compDev.toFixed(2)}, neighbor contrast: ${contrast}.`;
    } else if (domainCount === 1) {
      if (compDev >= 1.5) {
        summary = `Isolated variation in ${contributing[0]} domain (z=${domainZScores[contributing[0]].toFixed(2)}); composite deviation: ${compDev.toFixed(2)}, neighbor contrast: ${contrast}.`;
      } else {
        summary = `Isolated variation in ${contributing[0]} domain (z=${domainZScores[contributing[0]].toFixed(2)}); other properties align with image medians.`;
      }
    } else if (varLevel === 'low') {
      summary = 'Measurements are highly uniform and match image-wide medians.';
    } else {
      summary = `Measurements are consistent with expected spatial distribution (deviation: ${compDev.toFixed(2)}).`;
    }

    tiles.push({
      region_id: reg.region_id,
      row: reg.row,
      col: reg.col,
      variation_level: varLevel,
      contributing_domains: contributing,
      domain_count_with_variation: domainCount,
      is_multi_domain_variation: isMultiDomain,
      neighbor_contrast: contrast,
      summary,
    });

    if (varLevel === 'elevated' || varLevel === 'divergent') {
      elevatedRegions.push(reg.region_id);
    } else if (varLevel === 'low') {
      lowVariationRegions.push(reg.region_id);
    }

    if (isMultiDomain) multiDomainRegions.push(reg.region_id);
    else if (domainCount === 1) singleDomainRegions.push(reg.region_id);
  }

  return {
    tiles,
    elevatedRegions,
    lowVariationRegions,
    multiDomainRegions,
    singleDomainRegions,
    edgeCoupledRegions,
    flatSurpriseRegions,
  };
}

function buildKeyObservations(
  domains: EvidenceDomainItem[],
  convergingRegions: string[],
  numIndependentWithObs: number,
  flatSurpriseRegions: string[],
): KeyObservation[] {
  const observations: KeyObservation[] = [];
  const byId = new Map(domains.map((d) => [d.domain_id, d]));

  const metaDom = byId.get('metadata');
  if (metaDom && metaDom.status === 'available') {
    const m = metaDom.metrics;
    const inconsistentCount = Number(m.inconsistent_check_count ?? 0);
    if (inconsistentCount > 0) {
      observations.push({
        observation_id: 'OBS-META-003',
        title: 'Metadata Internal Consistency Discrepancy',
        description: `Metadata consistency checks flagged: ${(m.inconsistent_check_names as string[] | undefined)?.join(', ') ?? 'header fields'}.`,
        relevant_domains: ['metadata'],
        supporting_metrics: {
          inconsistent_check_count: inconsistentCount,
          inconsistent_check_names: m.inconsistent_check_names,
        },
        region_ids: [],
        neutral_interpretation:
          'Metadata discrepancies often arise when resize or export pipelines rewrite pixels without updating EXIF dimension tags, timestamps, or IFD1 thumbnails.',
        limitations: [
          'EXIF headers can be partially stripped or desynchronized by benign gallery, OS, or messaging software.',
        ],
      });
    } else if (m.is_editing_software_indicated) {
      observations.push({
        observation_id: 'OBS-META-001',
        title: 'Editing Software Signature Detected in EXIF',
        description: `Image metadata indicates post-capture processing or export via ${m.software}.`,
        relevant_domains: ['metadata'],
        supporting_metrics: { software: m.software },
        region_ids: [],
        neutral_interpretation:
          'Software tags confirm that the file underwent export or editing in an image processing application.',
        limitations: [
          'Software tags can indicate innocent format conversion, cropping, or color adjustment, and can be forged or stripped.',
        ],
      });
    } else if (!m.exif_present) {
      observations.push({
        observation_id: 'OBS-META-002',
        title: 'Absence of Camera EXIF Metadata',
        description: 'No EXIF metadata was detected in the file structure.',
        relevant_domains: ['metadata'],
        supporting_metrics: { exif_present: false },
        region_ids: [],
        neutral_interpretation:
          'The absence of EXIF metadata is standard across social media, messaging apps, and web pipelines.',
        limitations: [
          'Absence of metadata does not indicate image manipulation, synthetic generation, or authenticity.',
        ],
      });
    }
  }

  const compDom = byId.get('compression');
  if (compDom && compDom.status === 'available' && compDom.has_notable_variation) {
    const m = compDom.metrics;
    observations.push({
      observation_id: 'OBS-ELA-001',
      title: 'Spatial Variation in JPEG Recompression Error',
      description: `Regional mean difference spread of ${Number(m.regional_mean_spread ?? 0).toFixed(2)} observed at recompression quality ${m.recompression_quality}.`,
      relevant_domains: ['compression'],
      supporting_metrics: {
        mean_difference: m.mean_difference,
        regional_mean_spread: m.regional_mean_spread,
      },
      region_ids: [],
      neutral_interpretation:
        'Non-uniform error levels can stem from varying edge density, detailed textures, or differing compression histories.',
      limitations: [
        'Error Level Analysis measures relative error to an arbitrary baseline; it does not establish tampering.',
      ],
    });
  }

  const recompDom = byId.get('recompression');
  if (recompDom && recompDom.status === 'available' && recompDom.has_notable_variation) {
    const m = recompDom.metrics;
    const indList = Array.isArray(m.indicators) ? m.indicators.map(String) : [];
    observations.push({
      observation_id: 'OBS-RECOMP-001',
      title: 'Recompression or 8x8 Block-Grid Indicator Observed',
      description:
        indList[0] ??
        `8x8 block-grid scan detected structural periodicity (aligned ratio=${Number(m.aligned_blockiness_ratio ?? 1).toFixed(2)}, shifted max=${Number(m.max_shifted_blockiness_ratio ?? 1).toFixed(2)}).`,
      relevant_domains: ['recompression'],
      supporting_metrics: {
        aligned_blockiness_ratio: m.aligned_blockiness_ratio,
        max_shifted_blockiness_ratio: m.max_shifted_blockiness_ratio,
        shifted_grid_detected: m.shifted_grid_detected,
        ela_curve_non_monotonic: m.ela_curve_non_monotonic,
      },
      region_ids: [],
      neutral_interpretation:
        'Shifted 8x8 block boundaries or prior-JPEG block periodicity in lossless files are consistent with cropping, transcoding, or multi-generation saving.',
      limitations: [
        'Cropping, social-media re-encoding, and pixel-aligned UI graphics produce 8x8 block discontinuities without malicious splicing.',
      ],
    });
  }

  const noiseDom = byId.get('noise');
  if (noiseDom && noiseDom.status === 'available' && noiseDom.has_notable_variation) {
    const m = noiseDom.metrics;
    observations.push({
      observation_id: 'OBS-NOISE-001',
      title: 'Elevated Dispersion in High-Frequency Residuals',
      description: `Regional residual standard deviation varies by ${Number(m.regional_std_spread ?? 0).toFixed(2)} (heterogeneity ratio: ${Number(m.regional_noise_heterogeneity ?? 0).toFixed(2)}).`,
      relevant_domains: ['noise'],
      supporting_metrics: {
        residual_std: m.residual_std,
        regional_std_spread: m.regional_std_spread,
      },
      region_ids: [],
      neutral_interpretation:
        'Spatial variations in high-frequency residuals naturally track detailed foreground subjects and sharp contours.',
      limitations: [
        'Gaussian low-pass residuals measure high-frequency image structure rather than pure hardware sensor noise.',
      ],
    });
  }

  const freqDom = byId.get('frequency');
  if (freqDom && freqDom.status === 'available' && freqDom.has_notable_variation) {
    const m = freqDom.metrics;
    observations.push({
      observation_id: 'OBS-FREQ-001',
      title: 'Distinct Spectral Energy Concentration',
      description: `2D FFT frequency distribution exhibits high-frequency power of ${Number(m.high_frequency_energy_pct ?? 0).toFixed(1)}% and low-frequency power of ${Number(m.low_frequency_energy_pct ?? 0).toFixed(1)}%.`,
      relevant_domains: ['frequency'],
      supporting_metrics: {
        high_frequency_energy_pct: m.high_frequency_energy_pct,
        low_frequency_energy_pct: m.low_frequency_energy_pct,
        spectral_centroid: m.spectral_centroid,
        azimuthal_spike_ratio: m.azimuthal_spike_ratio,
      },
      region_ids: [],
      neutral_interpretation:
        'Frequency roll-off reflects global scene sharpness, fine texture density, and compression history.',
      limitations: [
        'Fourier spectral energy reflects photographic scene content and does not isolate localized editing.',
      ],
    });
  }

  if (flatSurpriseRegions.length > 0) {
    observations.push({
      observation_id: 'OBS-FLAT-001',
      title: 'Flat-Region Forensic Contrast Without Proportional Edge Density',
      description: `Forensic residual or compression differences exceeded typical grid baselines inside low-gradient regions: ${flatSurpriseRegions.join(', ')}.`,
      relevant_domains: ['spatial', 'noise', 'compression'],
      supporting_metrics: { flat_surprise_regions: flatSurpriseRegions },
      region_ids: flatSurpriseRegions,
      neutral_interpretation:
        'Unlike edge-coupled contrast along sharp object boundaries, variation inside smooth/flat regions warrants closer visual inspection of local grain or compression seams.',
      limitations: [
        'Localized shadow noise, sensor high-ISO banding, or smooth-gradient quantization can elevate flat-region noise/ELA without tampering.',
      ],
    });
  }

  const spatDom = byId.get('spatial');
  if (spatDom && spatDom.status === 'available' && spatDom.has_notable_variation) {
    const m = spatDom.metrics;
    const regId = m.highest_deviation_region_id ? String(m.highest_deviation_region_id) : null;
    observations.push({
      observation_id: 'OBS-SPAT-001',
      title: 'Localized Regional Statistical Outlier Detected',
      description: `Region ${regId} exhibits peak statistical deviation of ${Number(m.max_deviation_score ?? 0).toFixed(2)} from image-wide medians.`,
      relevant_domains: ['spatial'],
      supporting_metrics: {
        max_deviation_score: m.max_deviation_score,
        highest_deviation_region_id: m.highest_deviation_region_id,
        elevated_regions_count: m.elevated_regions_count,
      },
      region_ids: regId ? [regId] : [],
      neutral_interpretation:
        'The identified region demonstrates significant statistical contrast in measured properties against the overall image.',
      limitations: [
        'Regional contrast occurs naturally in photographic compositions due to depth of field, lighting, and focus.',
      ],
    });
  }

  if (numIndependentWithObs >= 2 && convergingRegions.length > 0) {
    observations.push({
      observation_id: 'OBS-CROSS-001',
      title: 'Coincident Multi-Domain Spatial Variation',
      description: `Multiple independent feature domains exhibit coincident statistical variation in region(s): ${convergingRegions.join(', ')}.`,
      relevant_domains: ['spatial', 'noise', 'compression', 'frequency', 'recompression'],
      supporting_metrics: {
        multi_domain_region_count: convergingRegions.length,
        regions: convergingRegions,
      },
      region_ids: convergingRegions,
      neutral_interpretation:
        'When multiple analytical domains show simultaneous variation in the same spatial tiles, it highlights concentrated localized contrast. This typically coincides with intricate foreground subjects or localized processing transitions.',
      limitations: [
        'Multi-domain coincidence reflects concentrated physical contrast, not diagnostic proof of image manipulation.',
      ],
    });
  }

  return observations;
}

export function buildSynthesisAnalysis(analyses: AnalysisItem[]): AnalysisItem {
  const analysisMap = new Map(analyses.map((a) => [a.name, a]));

  const metaItem = analysisMap.get('metadata');
  const elaItem = analysisMap.get('ela');
  const noiseItem = analysisMap.get('noise');
  const freqItem = analysisMap.get('frequency');
  const recompItem = analysisMap.get('recompression');
  const robustItem = analysisMap.get('robustness');
  const regionalItem = analysisMap.get('regional');

  const domMeta = evaluateMetadataDomain(metaItem);
  const domComp = evaluateCompressionDomain(elaItem);
  const domRecomp = evaluateRecompressionDomain(recompItem);
  const domNoise = evaluateNoiseDomain(noiseItem);
  const domFreq = evaluateFrequencyDomain(freqItem);
  const domSpat = evaluateSpatialDomain(regionalItem);
  const domRobust = evaluateRobustnessDomain(robustItem);

  const domains = [domMeta, domComp, domRecomp, domNoise, domFreq, domSpat, domRobust];
  const independentDomains = [domMeta, domComp, domRecomp, domNoise, domFreq];

  const availableIndependent = independentDomains.filter((d) => d.status === 'available');
  const independentWithObs = availableIndependent.filter((d) => d.has_notable_variation);
  const numAvailable = availableIndependent.length;
  const numWithObs = independentWithObs.length;
  const primaryContributing = independentWithObs.map((d) => d.domain_id);

  const {
    tiles,
    elevatedRegions,
    lowVariationRegions,
    multiDomainRegions,
    singleDomainRegions,
    edgeCoupledRegions,
    flatSurpriseRegions,
  } = synthesizeRegionalTiles(regionalItem);

  const domainIdToTileName: Record<string, string> = {
    compression: 'Compression',
    recompression: 'BlockGrid',
    noise: 'Noise',
    frequency: 'Frequency',
  };
  const spatialContributing = new Set(
    primaryContributing.map((d) => domainIdToTileName[d]).filter(Boolean),
  );

  const convergingRegions: string[] = [];
  if (spatialContributing.size >= 2) {
    for (const tile of tiles) {
      const matched = tile.contributing_domains.filter((cd) => spatialContributing.has(cd));
      if (matched.length >= 2) convergingRegions.push(tile.region_id);
    }
  }

  // Pairwise normalized spatial grid corroboration (Top-3 IoU)
  const elaGrid = (elaItem?.details as ELADetails | null)?.region_grid_scores ?? [];
  const noiseGrid = (noiseItem?.details as NoiseDetails | null)?.region_grid_scores ?? [];
  const freqGrid = (freqItem?.details as FrequencyDetails | null)?.region_grid_scores ?? [];
  const blockGrid =
    (recompItem?.details as RecompressionDetails | null)?.pixel_block_grid?.region_grid_scores ?? [];

  const gridPairsInput: Array<[string, string, typeof elaGrid, typeof elaGrid]> = [
    ['ela', 'noise', elaGrid, noiseGrid],
    ['ela', 'frequency', elaGrid, freqGrid],
    ['noise', 'frequency', noiseGrid, freqGrid],
    ['noise', 'block_grid', noiseGrid, blockGrid],
    ['ela', 'block_grid', elaGrid, blockGrid],
  ];

  const corroborationPairs: SpatialCorroborationPair[] = [];
  for (const [methodA, methodB, gridA, gridB] of gridPairsInput) {
    if (gridA.length > 0 && gridB.length > 0) {
      const res = computeTopKCellAgreement(gridA, gridB, 3, 1.2);
      corroborationPairs.push({
        method_a: methodA,
        method_b: methodB,
        top_k: res.top_k,
        iou: res.iou,
        overlap_regions: res.overlap_regions,
        status: res.status,
      });
    }
  }

  for (const pair of corroborationPairs) {
    if (pair.status === 'corroborated') {
      for (const rId of pair.overlap_regions) {
        if (!convergingRegions.includes(rId) && numWithObs >= 2) {
          convergingRegions.push(rId);
        }
      }
    }
  }

  // Abstention check for uniform constant images or tiny < 32px dimensions
  const freqDetails = freqItem?.details as FrequencyDetails | null;
  const robustDetails = robustItem?.details as RobustnessDetails | null;
  const isZeroEnergyUniform =
    freqDetails !== null &&
    freqDetails !== undefined &&
    freqDetails.total_non_dc_power <= 1e-6;
  const isTinyOrUniformAbstention =
    robustDetails !== null &&
    robustDetails !== undefined &&
    !robustDetails.baseline_valid &&
    robustDetails.transforms.length === 0;

  let abstained = false;
  let abstentionReason: string | null = null;
  if (numAvailable < 2) {
    abstained = true;
    abstentionReason =
      'Fewer than two independent analytical domains were available to cross-correlate.';
  } else if (isZeroEnergyUniform || isTinyOrUniformAbstention) {
    abstained = true;
    abstentionReason =
      robustDetails?.insufficient_contrast_reason ??
      'Input image contains uniform constant pixel intensity with zero non-DC spectral energy; spatial anomaly and corroboration scoring abstained.';
  }

  const regionalSynthesis: RegionalSynthesis = {
    grid_rows: (regionalItem?.details as RegionalAnomalyDetails | null)?.grid_rows ?? 4,
    grid_cols: (regionalItem?.details as RegionalAnomalyDetails | null)?.grid_cols ?? 4,
    total_regions: tiles.length,
    elevated_regions: elevatedRegions,
    low_variation_regions: lowVariationRegions,
    multi_domain_regions: multiDomainRegions,
    single_domain_regions: singleDomainRegions,
    tiles,
    summary: `Evaluated ${tiles.length} spatial partitions. Elevated variation found in ${elevatedRegions.length} region(s); ${multiDomainRegions.length} region(s) exhibited multi-domain coincidence.`,
  };

  const crossRelationships: CrossDomainRelationship[] = [];

  if (domComp.status === 'available' && domNoise.status === 'available') {
    if (domComp.has_notable_variation && domNoise.has_notable_variation) {
      crossRelationships.push({
        domains: ['compression', 'noise'],
        relationship_type: 'converging',
        description:
          'Both compression error levels and residual noise statistics exhibit non-uniform spatial patterns.',
        supporting_evidence: [
          `ELA regional mean spread: ${Number(domComp.metrics.regional_mean_spread ?? 0).toFixed(2)}`,
          `Noise residual std spread: ${Number(domNoise.metrics.regional_std_spread ?? 0).toFixed(2)}`,
        ],
      });
    } else if (domComp.has_notable_variation !== domNoise.has_notable_variation) {
      crossRelationships.push({
        domains: ['compression', 'noise'],
        relationship_type: 'diverging',
        description:
          'Compression error and residual noise distributions show divergent uniformity characteristics.',
        supporting_evidence: [
          `Compression variation: ${domComp.has_notable_variation}`,
          `Noise residual variation: ${domNoise.has_notable_variation}`,
        ],
      });
    } else {
      crossRelationships.push({
        domains: ['compression', 'noise'],
        relationship_type: 'independent',
        description:
          'Both compression error and residual noise distributions are spatially homogeneous.',
        supporting_evidence: ['Low regional dispersion across both domains.'],
      });
    }
  }

  const corroboratedPairs = corroborationPairs.filter((p) => p.status === 'corroborated');
  if (corroboratedPairs.length > 0) {
    crossRelationships.push({
      domains: Array.from(new Set(corroboratedPairs.flatMap((p) => [p.method_a, p.method_b]))),
      relationship_type: 'converging',
      description: `Top-K spatial grid corroboration identified overlap across ${corroboratedPairs.length} method pair(s).`,
      supporting_evidence: corroboratedPairs.map(
        (p) => `${p.method_a} vs ${p.method_b}: IoU=${p.iou.toFixed(2)} (${p.overlap_regions.join(', ')})`,
      ),
    });
  }

  if (convergingRegions.length > 0) {
    crossRelationships.push({
      domains: [
        'spatial',
        ...primaryContributing.filter((d) =>
          ['noise', 'compression', 'frequency', 'recompression'].includes(d),
        ),
      ],
      relationship_type: 'converging',
      description: `Spatial anomaly analysis detected multi-domain feature convergence across independent domains in ${convergingRegions.length} region(s).`,
      supporting_evidence: [`Regions: ${convergingRegions.join(', ')}`],
    });
  }

  let relationshipLabel: EvidenceSummary['relationship'];
  let synthesisStatement: string;

  if (abstained) {
    relationshipLabel = 'insufficient_evidence';
    synthesisStatement = abstentionReason!;
  } else if (numWithObs === 0 && flatSurpriseRegions.length === 0) {
    relationshipLabel = 'no_notable_variation';
    synthesisStatement = `All ${numAvailable} evaluated independent evidence domains exhibit uniform, expected statistical distributions. No notable statistical variation was detected across metadata, compression, recompression, noise, or frequency domains.`;
  } else if (numWithObs <= 1) {
    relationshipLabel = 'isolated_observation';
    const primaryLabel = independentWithObs[0]?.domain_name ?? 'Spatial Consistency';
    synthesisStatement = `An isolated statistical observation was identified in the ${primaryLabel} domain, while other independent domains show typical distributions.`;
    if (domSpat.has_notable_variation && domSpat.metrics.highest_deviation_region_id) {
      synthesisStatement += ` Supporting spatial analysis localized peak variation to region ${domSpat.metrics.highest_deviation_region_id}.`;
    }
  } else if (convergingRegions.length > 0 || corroboratedPairs.length > 0) {
    relationshipLabel = 'converging_observations';
    const regionPart = convergingRegions.length
      ? `, with spatial convergence observed in region(s): ${convergingRegions.join(', ')}`
      : '';
    synthesisStatement = `Multiple independent evidence domains (${primaryContributing.join(', ')}) exhibit coincident statistical observations${regionPart}.`;
  } else {
    relationshipLabel = 'mixed_observations';
    synthesisStatement = `Multiple evidence domains (${primaryContributing.join(', ')}) display statistical observations, but without spatial convergence across identical image regions.`;
  }

  const evidenceSummary: EvidenceSummary = {
    relationship: relationshipLabel,
    domains_available: numAvailable,
    domains_with_observations: numWithObs,
    primary_contributing_domains: primaryContributing,
    synthesis_statement: synthesisStatement,
  };

  const keyObservations = buildKeyObservations(
    domains,
    convergingRegions,
    numWithObs,
    flatSurpriseRegions,
  );

  // Build deterministic alternative explanations & recommended human checks
  const alternativeExplanations: string[] = [
    'Natural scene texture, depth-of-field blur, and sharp foreground boundaries produce coupled variations in ELA, noise residuals, and local FFT energy.',
    'Benign social-media, messaging, or gallery transcoding frequently strips EXIF metadata, alters quantization tables, and shifts 8x8 block boundaries upon cropping.',
  ];
  if (edgeCoupledRegions.length > 0) {
    alternativeExplanations.push(
      `Variations in region(s) ${edgeCoupledRegions.join(', ')} co-occur with elevated edge/gradient density, which is common in genuine high-detail subjects.`,
    );
  }
  if (domRobust.metrics.overall_stability === 'fragile') {
    alternativeExplanations.push(
      'Fragile signals that collapse under mild JPEG Q70 compression can arise from subtle single-generation sensor grain or benign post-processing.',
    );
  }

  const recommendedHumanChecks: string[] = [
    'Compare flagged regions visually against the ELA and noise residual maps at full zoom to distinguish natural subject contours from abrupt boundary seams.',
    'Verify provenance chain externally (original camera file, messaging export context, or source publication) rather than relying solely on pixel heuristics.',
  ];
  if (flatSurpriseRegions.length > 0) {
    recommendedHumanChecks.push(
      `Inspect low-gradient region(s) ${flatSurpriseRegions.join(', ')} closely for subtle texture smoothing, cloning, or mismatched grain floor.`,
    );
  }
  if (Number(domMeta.metrics.inconsistent_check_count ?? 0) > 0) {
    recommendedHumanChecks.push(
      'Review EXIF timestamp chronology, pixel-dimension tags, and embedded IFD1 thumbnail discrepancy against export history.',
    );
  }

  const limitations = [
    'Statistical variation across evidence domains reflects natural image characteristics (lighting, depth of field, scene texture, and camera processing) and does not establish image manipulation.',
    'TruthLens evidence synthesis provides explainable statistical observations and does not output authenticity percentages, manipulation confidence scores, or binary real/fake verdicts.',
    'Absence of metadata is standard across web, social media, and messaging pipelines and must never be interpreted as evidence of manipulation or AI generation.',
  ];
  if (domComp.status === 'unavailable') {
    limitations.push(
      'Compression domain analysis (ELA) was unavailable because the input format is not JPEG.',
    );
  }
  if (domains.some((d) => d.status === 'failed')) {
    limitations.push(
      'One or more analytical modules encountered execution errors; synthesis was performed on available domains only.',
    );
  }

  const methodology: MethodologyInfo = {
    version: SYNTHESIS_VERSION,
    correlated_feature_policy:
      'Correlated features (e.g. gradient statistics, noise residual mean/std) are aggregated into independent domain-level families to prevent multi-collinear overweighting. Spatial consistency and perturbation robustness serve as supporting localization/stability modifiers rather than independent anomaly votes.',
    aggregation_approach:
      'Rule-based deterministic synthesis evaluating domain-level variation, normalized NxN Top-K spatial corroboration (IoU), flat-vs-edge separation, and explicit abstention on uniform/low-contrast inputs without ML classifiers or calibrated probabilities.',
    disclaimer:
      'TruthLens is a forensic evidence analysis engine. Regional or cross-domain differences are descriptive observations, not proof of tampering, AI generation, or authenticity.',
  };

  const details: SynthesisDetails = {
    evidence_summary: evidenceSummary,
    domains,
    cross_domain_relationships: crossRelationships,
    key_observations: keyObservations,
    regional_synthesis: regionalSynthesis,
    limitations,
    methodology,
    spatial_corroboration: {
      pairs: corroborationPairs,
      edge_coupled_regions: edgeCoupledRegions,
      flat_surprise_regions: flatSurpriseRegions,
      abstained,
      abstention_reason: abstentionReason,
      alternative_explanations: alternativeExplanations,
      recommended_human_checks: recommendedHumanChecks,
    },
  };

  return {
    name: 'synthesis',
    status: 'completed',
    observations: [synthesisStatement, ...keyObservations.map((ko) => `${ko.title}: ${ko.description}`)],
    metrics: {
      domains_available: numAvailable,
      domains_with_observations: numWithObs,
      relationship: relationshipLabel,
      elevated_region_count: elevatedRegions.length,
      multi_domain_region_count: multiDomainRegions.length,
      flat_surprise_count: flatSurpriseRegions.length,
      abstained,
    },
    limitations,
    details,
  };
}
