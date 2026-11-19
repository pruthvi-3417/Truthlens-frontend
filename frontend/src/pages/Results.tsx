import { useNavigate, useLocation } from 'react-router-dom';
import { Download, FileSearch } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/Common';
import BackendResult from '../components/ui/BackendResult';
import ImageEvidenceDashboard from '../components/ui/ImageEvidenceDashboard';
import type { InvestigationResult } from '../types';

export default function Results() {
  const nav = useNavigate();
  const location = useLocation();
  const result = (location.state as { result?: InvestigationResult } | null)?.result;
  const isImage = result?.mediaTypes.includes('image') || result?.imageEvidence;
  const imageEvidence = result?.imageEvidence;
  const assessmentDetail = result?.assessmentDetail;

  return (
    <>
      <PageHeader
        title="Investigation report"
        description="Evidence and module observations returned by the backend."
        actions={
          <button className="button secondary" disabled>
            <Download size={16} />
            Report unavailable
          </button>
        }
      />
      {result ? (
        isImage && imageEvidence ? (
          <>
            <div className="result-placeholder">
              <section className="card">
                <div className="card-header">
                  <span>INVESTIGATION SUMMARY</span>
                  <h3>Image evidence</h3>
                </div>
                <div className="detail-list">
                  <div>
                    <span>Original filename</span>
                    <strong>{result.filenames[0] ?? 'Unavailable'}</strong>
                  </div>
                  <div>
                    <span>Investigation ID</span>
                    <strong>{result.id ?? 'Unavailable'}</strong>
                  </div>
                  <div>
                    <span>Analysis timestamp</span>
                    <strong>{result.timestamp ?? 'Unavailable'}</strong>
                  </div>
                  <div>
                    <span>Analysis status</span>
                    <strong>{result.analysisStatus ?? 'Unavailable'}</strong>
                  </div>
                </div>
              </section>
              <section className="card">
                <div className="card-header">
                  <span>
                    ASSESSMENT · TIER {assessmentDetail?.maturityTier ?? result.maturityTier ?? 'A'}
                  </span>
                  <h3>Interpretation status</h3>
                </div>
                <div className="assessment-box">
                  <FileSearch />
                  <strong>{result.assessment ?? 'INCONCLUSIVE'}</strong>
                  <p>
                    {assessmentDetail?.summary ??
                      (result.assessment
                        ? 'Backend-provided assessment'
                        : 'No backend assessment is available.')}
                  </p>
                  <p>
                    {assessmentDetail?.calibration?.label ??
                      result.calibration?.label ??
                      'Uncalibrated — qualitative indicator only'}
                  </p>
                </div>
              </section>
            </div>
            <ImageEvidenceDashboard
              investigationId={result.id}
              evidence={{
                ...imageEvidence,
                status: imageEvidence.status ?? result.analysisStatus ?? 'unavailable',
                sha256: imageEvidence.sha256 ?? result.sha256?.[0],
                fileFormat: imageEvidence.fileFormat ?? result.fileFormat,
                fileSize: imageEvidence.fileSize ?? result.fileSize,
                width: imageEvidence.width ?? result.imageProperties?.width,
                height: imageEvidence.height ?? result.imageProperties?.height,
              }}
            />
          </>
        ) : (
          <BackendResult result={result} />
        )
      ) : (
        <div className="card report-empty">
          <EmptyState
            title="No investigation result"
            message="There is no backend result to display. Upload media and submit an investigation to produce an evidence report."
            action={
              <button className="button primary" onClick={() => nav('/analyze')}>
                Analyze media
              </button>
            }
          />
        </div>
      )}
    </>
  );
}
