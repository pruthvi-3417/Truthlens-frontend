import type { InvestigationResult } from '../../types';
import { FileSearch } from 'lucide-react';

export default function BackendResult({ result }: { result: InvestigationResult }) {
  const detail = result.assessmentDetail;
  return (
    <>
      <div className="result-placeholder">
        <section className="card">
          <div className="card-header">
            <span>INVESTIGATION DETAILS</span>
            <h3>File properties</h3>
          </div>
          <div className="detail-list">
            <div>
              <span>Investigation ID</span>
              <strong>{result.id ?? 'Unavailable'}</strong>
            </div>
            <div>
              <span>Timestamp</span>
              <strong>{result.timestamp ?? 'Unavailable'}</strong>
            </div>
            <div>
              <span>SHA-256</span>
              <strong>{result.sha256?.join(', ') || 'Unavailable'}</strong>
            </div>
            <div>
              <span>Filenames</span>
              <strong>{result.filenames.join(', ') || 'Unavailable'}</strong>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <span>ASSESSMENT · TIER {detail?.maturityTier ?? result.maturityTier ?? 'A'}</span>
            <h3>Overall category</h3>
          </div>
          <div className="assessment-box">
            <FileSearch />
            <strong>{result.assessment ?? 'INCONCLUSIVE'}</strong>
            <p>
              {detail?.summary ??
                (result.assessment
                  ? 'Backend-provided assessment'
                  : 'No backend assessment is available.')}
            </p>
            <p>
              {detail?.calibration?.label ??
                result.calibration?.label ??
                'Uncalibrated — qualitative indicator only'}
            </p>
          </div>
        </section>
      </div>
      {result.modules.length > 0 && (
        <section className="card module-results">
          <div className="card-header">
            <span>FORENSIC MODULES</span>
            <h3>Backend module states</h3>
          </div>
          {result.modules.map((module) => (
            <div className="module-result" key={module.name}>
              <div>
                <strong>{module.name}</strong>
                <p>{module.status === 'unavailable' ? 'Analysis unavailable' : module.status}</p>
              </div>
              <span>{module.status}</span>
            </div>
          ))}
        </section>
      )}
      {result.findings.length > 0 && (
        <section className="card module-results">
          <div className="card-header">
            <span>FINDINGS</span>
            <h3>Backend observations</h3>
          </div>
          {result.findings.map((finding) => (
            <article className="method-card" key={finding.id}>
              <div className="method-copy">
                <h3>{finding.title}</h3>
                <dl>
                  <div>
                    <dt>Observation</dt>
                    <dd>{finding.observation}</dd>
                  </div>
                  <div>
                    <dt>Possible interpretation</dt>
                    <dd>{finding.interpretation ?? 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Limitations</dt>
                    <dd>{finding.limitations ?? 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Evidence reference</dt>
                    <dd>{finding.evidenceReference ?? 'Unavailable'}</dd>
                  </div>
                </dl>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
