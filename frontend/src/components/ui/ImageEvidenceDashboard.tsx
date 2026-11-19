import { useState } from 'react';
import { ChevronDown, Image as ImageIcon, Maximize2, ShieldAlert } from 'lucide-react';
import type { ImageForensicEvidence, RegionalMeasurement, RGBMeasurements } from '../../types';

function formatBytes(bytes?: number) {
  if (typeof bytes !== 'number') return 'Unavailable';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function rgbRows(rgb?: RGBMeasurements) {
  if (!rgb) return [];
  return [
    ['Red', rgb.red ?? rgb.r],
    ['Green', rgb.green ?? rgb.g],
    ['Blue', rgb.blue ?? rgb.b],
    ['Mean', rgb.mean],
  ].filter(([, value]) => typeof value === 'number') as [string, number][];
}

function EvidenceDetails({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="evidence-section">
      <summary>
        <div>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <ChevronDown size={18} />
      </summary>
      <div className="evidence-section-body">{children}</div>
    </details>
  );
}

function RegionalGrid({ regions }: { regions?: RegionalMeasurement[] }) {
  if (!regions?.length) {
    return <div className="unavailable-data">Regional measurements unavailable.</div>;
  }
  return (
    <div className="regional-grid" role="table" aria-label="4 by 4 regional measurements">
      {regions.map((region, index) => {
        const label =
          typeof region.region === 'string'
            ? region.region
            : `Region ${
                typeof region.row === 'number' && typeof region.column === 'number'
                  ? `${region.row + 1}.${region.column + 1}`
                  : index + 1
              }`;
        const value =
          typeof region.value === 'number'
            ? region.value
            : Object.values(region.measurements ?? {}).find((v) => typeof v === 'number');
        const extra =
          typeof region.neighborDeviation === 'number'
            ? `nbr ${region.neighborDeviation.toFixed(2)}`
            : typeof region.std === 'number'
              ? `std ${region.std.toFixed(2)}`
              : typeof region.variance === 'number'
                ? `var ${region.variance.toFixed(2)}`
                : undefined;
        return (
          <div className="regional-cell" role="cell" key={label} title={region.observation}>
            <span>{label}</span>
            <strong>{typeof value === 'number' ? value.toFixed(4) : 'N/A'}</strong>
            {extra && <span>{extra}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Visualization({ url, title, alt }: { url?: string; title: string; alt: string }) {
  const [open, setOpen] = useState(false);
  if (!url) {
    return (
      <div className="visualization-placeholder">
        <ImageIcon />
        <span>{title} unavailable</span>
      </div>
    );
  }
  return (
    <>
      <div className="visualization-card">
        <div className="visualization-toolbar">
          <span>{title}</span>
          <button
            className="icon-button"
            type="button"
            aria-label={`Expand ${title}`}
            onClick={() => setOpen(true)}
          >
            <Maximize2 size={16} />
          </button>
        </div>
        <img src={url} alt={alt} />
      </div>
      {open && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="image-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${title} enlarged view`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button dialog-close"
              type="button"
              aria-label="Close enlarged visualization"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <img src={url} alt={alt} />
          </div>
        </div>
      )}
    </>
  );
}

export default function ImageEvidenceDashboard({
  evidence,
  investigationId,
}: {
  evidence: ImageForensicEvidence;
  investigationId?: string;
}) {
  const exif = evidence.exif;
  const elaRgb = rgbRows(evidence.ela?.rgb);
  const elaMaxRgb = rgbRows(evidence.ela?.channelMaxes);
  const noiseRgb = rgbRows(evidence.noise?.rgb);
  const resolvedId =
    investigationId ??
    evidence.caseId ??
    evidence.evidenceId ??
    (evidence.sha256 ? `TL-${evidence.sha256.slice(0, 12)}` : 'Unavailable');

  const statusTone = (status?: string) =>
    status === 'completed'
      ? 'completed'
      : status === 'running'
        ? 'running'
        : status === 'pending'
          ? 'pending'
          : status === 'failed'
            ? 'failed'
            : status === 'unavailable'
              ? 'unavailable'
              : 'not-implemented';
  const moduleLabel = (status?: string) =>
    status === 'completed'
      ? 'Completed'
      : status === 'running' || status === 'pending'
        ? 'Analysis in progress'
        : status === 'failed'
          ? 'Failed'
          : status === 'unavailable'
            ? 'Unavailable'
            : 'Not yet implemented';

  return (
    <div className="image-evidence-dashboard">
      <EvidenceDetails title="Investigation summary" subtitle="File, custody, and analysis metadata">
        <div className="summary-grid">
          <div>
            <span>Investigation / Case ID</span>
            <strong>{resolvedId}</strong>
          </div>
          <div>
            <span>File format</span>
            <strong>{evidence.fileFormat ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>File size</span>
            <strong>{evidence.sizeReadable ?? formatBytes(evidence.fileSize)}</strong>
          </div>
          <div>
            <span>Image dimensions</span>
            <strong>
              {evidence.width && evidence.height
                ? `${evidence.width} × ${evidence.height} px`
                : evidence.width || evidence.height
                  ? `${evidence.width ?? evidence.height ?? 'Unavailable'} px`
                  : 'Unavailable'}
            </strong>
          </div>
          <div>
            <span>Color mode / transparency</span>
            <strong>
              {evidence.mode
                ? `${evidence.mode}${evidence.hasTransparency ? ' (alpha)' : ''}`
                : evidence.resolution ?? 'Unavailable'}
            </strong>
          </div>
          <div>
            <span>SHA-256</span>
            <strong className="hash-value">{evidence.sha256 ?? 'Unavailable'}</strong>
          </div>
          {evidence.evidenceId && (
            <div>
              <span>Evidence ID</span>
              <strong className="hash-value">{evidence.evidenceId}</strong>
            </div>
          )}
          {evidence.auditHeadHash && (
            <div>
              <span>Audit chain head hash</span>
              <strong className="hash-value">{evidence.auditHeadHash}</strong>
            </div>
          )}
        </div>
      </EvidenceDetails>

      <EvidenceDetails title="Metadata & EXIF" subtitle="Camera, timestamps, and provenance tags">
        <div className="metadata-grid">
          <div>
            <span>Camera manufacturer</span>
            <strong>{exif?.cameraManufacturer ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Camera model</span>
            <strong>{exif?.cameraModel ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Lens</span>
            <strong>{exif?.lens ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Orientation</span>
            <strong>{exif?.orientation !== undefined ? String(exif.orientation) : 'Unavailable'}</strong>
          </div>
          <div>
            <span>Original timestamp</span>
            <strong>{exif?.originalTimestamp ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Digitized / modified timestamp</span>
            <strong>{exif?.modificationTimestamp ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Editing software</span>
            <strong>{exif?.editingSoftware ?? 'Unavailable'}</strong>
          </div>
          <div>
            <span>Color space / EXIF version</span>
            <strong>
              {exif?.colorSpace || exif?.exifVersion
                ? [exif.colorSpace, exif.exifVersion].filter(Boolean).join(' · ')
                : 'Unavailable'}
            </strong>
          </div>
          <div>
            <span>GPS metadata presence</span>
            <strong>
              {exif?.gpsPresent === undefined
                ? 'Unavailable'
                : exif.gpsPresent
                  ? `Present (${exif.gpsFieldsPresent?.join(', ') || 'tags only'}) — coordinates withheld`
                  : 'Not present'}
            </strong>
          </div>
          <div>
            <span>Fields found / missing</span>
            <strong>
              {exif?.fieldsFound?.length || exif?.fieldsMissing?.length
                ? `${exif?.fieldsFound?.length ?? 0} found · ${exif?.fieldsMissing?.length ?? 0} missing`
                : 'Unavailable'}
            </strong>
          </div>
        </div>
        {exif?.formatNotes && (
          <div className="interpretation-block">
            <p>{exif.formatNotes}</p>
          </div>
        )}
        {exif?.embeddedThumbnailPresent && (
          <div className="interpretation-block">
            <p>
              Embedded EXIF thumbnail:{' '}
              {exif.embeddedThumbnailWidth && exif.embeddedThumbnailHeight
                ? `${exif.embeddedThumbnailWidth} × ${exif.embeddedThumbnailHeight} px`
                : 'Present (dimensions unavailable)'}
            </p>
          </div>
        )}
        {exif?.consistencyChecks && exif.consistencyChecks.length > 0 && (
          <section className="interpretation-block">
            <h3>Metadata consistency checks</h3>
            <ul>
              {exif.consistencyChecks.map((chk) => (
                <li key={chk.check_id}>
                  <strong>{chk.name}</strong> [{chk.status}]: {chk.observation}
                </li>
              ))}
            </ul>
          </section>
        )}
      </EvidenceDetails>

      <EvidenceDetails title="Error Level Analysis" subtitle="ELA visualization and regional measurements">
        <div className="evidence-visual-grid">
          <Visualization
            url={evidence.originalImageUrl}
            title="Original image"
            alt="Original uploaded image"
          />
          <Visualization
            url={evidence.ela?.visualizationUrl}
            title="ELA visualization"
            alt="Backend-provided Error Level Analysis visualization"
          />
        </div>
        <div className="measurement-grid">
          <section>
            <h3>Overall difference</h3>
            {evidence.ela?.difference && Object.keys(evidence.ela.difference).length ? (
              <dl>
                {Object.entries(evidence.ela.difference).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'number' ? value.toFixed(6) : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">Overall ELA metrics unavailable.</div>
            )}
          </section>
          <section>
            <h3>RGB channel means & maxes</h3>
            {elaRgb.length ? (
              <dl>
                {elaRgb.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label} mean</dt>
                    <dd>{value.toFixed(6)}</dd>
                  </div>
                ))}
                {elaMaxRgb.map(([label, value]) => (
                  <div key={`${label}-max`}>
                    <dt>{label} max</dt>
                    <dd>{value.toFixed(2)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">ELA RGB measurements unavailable.</div>
            )}
          </section>
          <section>
            <h3>Thresholds & regional summary</h3>
            {evidence.ela?.thresholdPercentages || evidence.ela?.regionalSummary ? (
              <dl>
                {Object.entries(evidence.ela.thresholdPercentages ?? {}).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value.toFixed(2)}%</dd>
                  </div>
                ))}
                {Object.entries(evidence.ela.regionalSummary ?? {}).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value.toFixed(4)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">Threshold percentages unavailable.</div>
            )}
          </section>
        </div>
        {evidence.ela?.multiQualityCurve && evidence.ela.multiQualityCurve.length > 0 && (
          <section className="interpretation-block">
            <h3>Multi-quality ELA sweep</h3>
            <ul>
              {evidence.ela.multiQualityCurve.map((pt) => (
                <li key={pt.quality}>
                  Q={pt.quality}: mean diff {pt.mean_difference.toFixed(4)} · regional spread{' '}
                  {pt.regional_mean_spread.toFixed(4)}
                </li>
              ))}
            </ul>
          </section>
        )}
        <h3 className="regional-heading">4×4 regional analysis</h3>
        <RegionalGrid regions={evidence.ela?.regional} />
        {evidence.ela?.observations && evidence.ela.observations.length > 0 && (
          <section className="interpretation-block">
            <h3>ELA observations</h3>
            <ul>
              {evidence.ela.observations.map((obs) => (
                <li key={obs}>{obs}</li>
              ))}
            </ul>
          </section>
        )}
        {evidence.ela?.limitations && evidence.ela.limitations.length > 0 && (
          <section className="interpretation-block">
            <h3>ELA limitations</h3>
            <ul>
              {evidence.ela.limitations.map((lim) => (
                <li key={lim}>{lim}</li>
              ))}
            </ul>
          </section>
        )}
      </EvidenceDetails>

      <EvidenceDetails
        title="Noise residual analysis"
        subtitle="Residual visualization and statistical measurements"
      >
        <Visualization
          url={evidence.noise?.visualizationUrl}
          title="Noise residual visualization"
          alt="Backend-provided noise residual visualization"
        />
        <div className="measurement-grid">
          <section>
            <h3>Gaussian smoothing & regional summary</h3>
            <div className="unavailable-data">
              {typeof evidence.noise?.gaussianSmoothing === 'string'
                ? evidence.noise.gaussianSmoothing
                : evidence.noise?.gaussianSmoothing
                  ? JSON.stringify(evidence.noise.gaussianSmoothing)
                  : 'Gaussian smoothing information unavailable.'}
            </div>
            {evidence.noise?.regionalSummary && (
              <dl>
                {Object.entries(evidence.noise.regionalSummary).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value.toFixed(4)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section>
            <h3>Residual statistics</h3>
            {evidence.noise?.statistics && Object.keys(evidence.noise.statistics).length ? (
              <dl>
                {Object.entries(evidence.noise.statistics).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'number' ? value.toFixed(6) : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">Residual statistical measurements unavailable.</div>
            )}
          </section>
          <section>
            <h3>RGB channel analysis</h3>
            {noiseRgb.length ? (
              <dl>
                {noiseRgb.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label} MAR</dt>
                    <dd>{value.toFixed(6)}</dd>
                  </div>
                ))}
                {typeof evidence.noise?.flatPixelResidualStd === 'number' && (
                  <div>
                    <dt>Flat-pixel std</dt>
                    <dd>{evidence.noise.flatPixelResidualStd.toFixed(4)}</dd>
                  </div>
                )}
                {typeof evidence.noise?.edgePixelResidualStd === 'number' && (
                  <div>
                    <dt>Edge-pixel std</dt>
                    <dd>{evidence.noise.edgePixelResidualStd.toFixed(4)}</dd>
                  </div>
                )}
                {typeof evidence.noise?.flatToEdgeNoiseRatio === 'number' && (
                  <div>
                    <dt>Flat / Edge ratio</dt>
                    <dd>{evidence.noise.flatToEdgeNoiseRatio.toFixed(4)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <div className="unavailable-data">Noise RGB measurements unavailable.</div>
            )}
          </section>
        </div>
        <h3 className="regional-heading">Regional residual measurements</h3>
        <RegionalGrid regions={evidence.noise?.regional} />
      </EvidenceDetails>

      <EvidenceDetails
        title="Frequency domain"
        subtitle="2D FFT spatial-frequency spectrum and band energy"
      >
        <Visualization
          url={evidence.frequency?.visualizationUrl}
          title="2D FFT spectrum"
          alt="Backend-provided 2D FFT log-magnitude spectrum visualization"
        />
        <div className="measurement-grid">
          <section>
            <h3>Spectral metrics</h3>
            {evidence.frequency?.statistics &&
            Object.keys(evidence.frequency.statistics).length ? (
              <dl>
                {Object.entries(evidence.frequency.statistics).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'number' ? value.toFixed(4) : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">Frequency domain measurements unavailable.</div>
            )}
          </section>
          <section>
            <h3>Transform parameters & band powers</h3>
            {evidence.frequency?.windowFunction ? (
              <dl>
                <div>
                  <dt>Window function</dt>
                  <dd>{evidence.frequency.windowFunction}</dd>
                </div>
                {evidence.frequency.analysisWidth && evidence.frequency.analysisHeight && (
                  <div>
                    <dt>Analysis grid</dt>
                    <dd>
                      {evidence.frequency.analysisWidth} × {evidence.frequency.analysisHeight}
                    </dd>
                  </div>
                )}
                {typeof evidence.frequency.totalNonDcPower === 'number' && (
                  <div>
                    <dt>total_non_dc_power</dt>
                    <dd>{evidence.frequency.totalNonDcPower.toFixed(2)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <div className="unavailable-data">Transform details unavailable.</div>
            )}
          </section>
        </div>
      </EvidenceDetails>

      <EvidenceDetails
        title="Regional anomaly"
        subtitle="4×4 spatial consistency and statistical deviation"
      >
        <Visualization
          url={evidence.regional?.visualizationUrl}
          title="Regional deviation overlay"
          alt="Backend-provided regional statistical deviation overlay"
        />
        <div className="measurement-grid">
          <section>
            <h3>Deviation summary</h3>
            {evidence.regional?.statistics &&
            Object.keys(evidence.regional.statistics).length ? (
              <dl>
                {Object.entries(evidence.regional.statistics).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'number' ? value.toFixed(4) : String(value ?? 'Unavailable')}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="unavailable-data">Regional deviation summary unavailable.</div>
            )}
          </section>
          <section>
            <h3>Analyzed features & modules</h3>
            {evidence.regional?.analyzedFeatures?.length ? (
              <dl>
                <div>
                  <dt>Features</dt>
                  <dd>{evidence.regional.analyzedFeatures.join(', ')}</dd>
                </div>
                <div>
                  <dt>Active modules</dt>
                  <dd>{evidence.regional.activeModulesUsed?.join(', ') || 'None'}</dd>
                </div>
              </dl>
            ) : (
              <div className="unavailable-data">Regional feature configuration unavailable.</div>
            )}
          </section>
        </div>
        <h3 className="regional-heading">4×4 regional deviation scores</h3>
        <RegionalGrid regions={evidence.regional?.regional} />
      </EvidenceDetails>

      {evidence.recompression?.details && (
        <EvidenceDetails
          title="Double-JPEG & 8×8 block-grid"
          subtitle="Quantization tables and pixel-domain 8×8 DCT grid periodicity"
        >
          <div className="measurement-grid">
            <section>
              <h3>JPEG bitstream DQT</h3>
              <dl>
                <div>
                  <dt>Estimated IJG quality</dt>
                  <dd>
                    {evidence.recompression.details.jpeg_bitstream.estimated_ijg_quality ??
                      'Unavailable'}
                  </dd>
                </div>
                <div>
                  <dt>Custom / non-standard DQT</dt>
                  <dd>
                    {evidence.recompression.details.jpeg_bitstream.custom_or_nonstandard_tables ===
                    null
                      ? 'Unavailable'
                      : String(
                          evidence.recompression.details.jpeg_bitstream.custom_or_nonstandard_tables,
                        )}
                  </dd>
                </div>
                <div>
                  <dt>Chroma subsampling</dt>
                  <dd>
                    {evidence.recompression.details.jpeg_bitstream.chroma_subsampling ?? 'Unavailable'}
                  </dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>Pixel 8×8 block-grid scan</h3>
              <dl>
                <div>
                  <dt>Aligned (0,0) ratio</dt>
                  <dd>
                    {evidence.recompression.details.pixel_block_grid.aligned_blockiness_ratio.toFixed(
                      4,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Max shifted ratio</dt>
                  <dd>
                    {evidence.recompression.details.pixel_block_grid.max_shifted_blockiness_ratio.toFixed(
                      4,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Dominant offset</dt>
                  <dd>
                    ({evidence.recompression.details.pixel_block_grid.dominant_offset.join(', ')})
                  </dd>
                </div>
                <div>
                  <dt>Shifted grid detected</dt>
                  <dd>
                    {String(evidence.recompression.details.pixel_block_grid.shifted_grid_detected)}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
          {evidence.recompression.details.double_jpeg_indicators.indicators.length > 0 && (
            <section className="interpretation-block">
              <h3>Recompression indicators</h3>
              <ul>
                {evidence.recompression.details.double_jpeg_indicators.indicators.map((ind) => (
                  <li key={ind}>{ind}</li>
                ))}
              </ul>
            </section>
          )}
        </EvidenceDetails>
      )}

      {evidence.robustness?.details && (
        <EvidenceDetails
          title="Perturbation robustness"
          subtitle="In-memory re-encoding and resampling signal persistence"
        >
          <div className="measurement-grid">
            <section>
              <h3>Stability summary</h3>
              <dl>
                <div>
                  <dt>Overall stability</dt>
                  <dd>{evidence.robustness.details.overall_stability}</dd>
                </div>
                <div>
                  <dt>Analysis resolution</dt>
                  <dd>
                    {evidence.robustness.details.analysis_resolution.width} ×{' '}
                    {evidence.robustness.details.analysis_resolution.height}
                  </dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{evidence.robustness.details.duration_ms} ms</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>Perturbation transforms</h3>
              {evidence.robustness.details.transforms.length > 0 ? (
                <ul>
                  {evidence.robustness.details.transforms.map((tr) => (
                    <li key={tr.transform_id}>
                      <strong>{tr.label}</strong>: retention {(tr.noise_retention_ratio * 100).toFixed(1)}
                      %, r={tr.regional_pearson_corr.toFixed(2)}, Top-3 IoU=
                      {tr.regional_top_k_iou.toFixed(2)} ({tr.signal_retained})
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="unavailable-data">
                  {evidence.robustness.details.insufficient_contrast_reason ??
                    'Transforms skipped due to insufficient spatial contrast.'}
                </div>
              )}
            </section>
          </div>
        </EvidenceDetails>
      )}

      <EvidenceDetails
        title="Evidence interpretation"
        subtitle="Backend synthesis observations; not a final authenticity judgment"
      >
        <div className="evidence-note">
          <ShieldAlert />
          <p>
            {evidence.evidence?.methodology?.disclaimer ??
              'ELA or noise residual anomalies are indicators that require contextual review. They do not prove manipulation or AI generation.'}
          </p>
        </div>
        {[
          ['Observed indicators', evidence.evidence?.observedIndicators],
          ['Supporting evidence', evidence.evidence?.supportingEvidence],
          ['Potential anomalies', evidence.evidence?.potentialAnomalies],
          ['Limitations', evidence.evidence?.limitations],
          ['Interpretation notes', evidence.evidence?.interpretationNotes],
        ].map(([title, items]) => (
          <section className="interpretation-block" key={String(title)}>
            <h3>{String(title)}</h3>
            {Array.isArray(items) && items.length ? (
              <ul>
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>Unavailable.</p>
            )}
          </section>
        ))}
        {evidence.evidence?.spatialCorroboration && (
          <>
            {evidence.evidence.spatialCorroboration.pairs.length > 0 && (
              <section className="interpretation-block">
                <h3>Cross-method spatial corroboration</h3>
                <ul>
                  {evidence.evidence.spatialCorroboration.pairs.map((p) => (
                    <li key={`${p.method_a}-${p.method_b}`}>
                      {p.method_a} vs {p.method_b}: Top-{p.top_k} IoU {p.iou.toFixed(2)} [{p.status}]
                      {p.overlap_regions.length ? ` (${p.overlap_regions.join(', ')})` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {evidence.evidence.spatialCorroboration.alternative_explanations.length > 0 && (
              <section className="interpretation-block">
                <h3>Alternative explanations</h3>
                <ul>
                  {evidence.evidence.spatialCorroboration.alternative_explanations.map((alt) => (
                    <li key={alt}>{alt}</li>
                  ))}
                </ul>
              </section>
            )}
            {evidence.evidence.spatialCorroboration.recommended_human_checks.length > 0 && (
              <section className="interpretation-block">
                <h3>Recommended human checks</h3>
                <ul>
                  {evidence.evidence.spatialCorroboration.recommended_human_checks.map((chk) => (
                    <li key={chk}>{chk}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        {evidence.evidence?.regionalSynthesis && (
          <section className="interpretation-block">
            <h3>Regional synthesis</h3>
            <p>{evidence.evidence.regionalSynthesis.summary}</p>
          </section>
        )}
        {evidence.evidence?.methodology && (
          <section className="interpretation-block">
            <h3>Methodology (v{evidence.evidence.methodology.version})</h3>
            <p>{evidence.evidence.methodology.correlated_feature_policy}</p>
            <p>{evidence.evidence.methodology.aggregation_approach}</p>
          </section>
        )}
      </EvidenceDetails>

      <EvidenceDetails
        title="Module status"
        subtitle="Implemented and unavailable forensic capabilities"
      >
        <div className="module-status-grid">
          <div>
            <span>ELA</span>
            <strong className={statusTone(evidence.ela?.status)}>
              {moduleLabel(evidence.ela?.status)}
            </strong>
          </div>
          <div>
            <span>Noise residual</span>
            <strong className={statusTone(evidence.noise?.status)}>
              {moduleLabel(evidence.noise?.status)}
            </strong>
          </div>
          <div>
            <span>Frequency domain</span>
            <strong className={statusTone(evidence.frequencyStatus)}>
              {moduleLabel(evidence.frequencyStatus)}
            </strong>
          </div>
          <div>
            <span>Recompression / 8×8 Grid</span>
            <strong className={statusTone(evidence.recompressionStatus)}>
              {moduleLabel(evidence.recompressionStatus)}
            </strong>
          </div>
          <div>
            <span>Perturbation robustness</span>
            <strong className={statusTone(evidence.robustnessStatus)}>
              {moduleLabel(evidence.robustnessStatus)}
            </strong>
          </div>
          <div>
            <span>Regional anomaly</span>
            <strong className={statusTone(evidence.regionalStatus)}>
              {moduleLabel(evidence.regionalStatus)}
            </strong>
          </div>
          <div>
            <span>Evidence aggregation</span>
            <strong className={statusTone(evidence.evidenceStatus)}>
              {moduleLabel(evidence.evidenceStatus)}
            </strong>
          </div>
        </div>
      </EvidenceDetails>
    </div>
  );
}
