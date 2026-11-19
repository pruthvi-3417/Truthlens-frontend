import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  TRUTHLENS_CONTRACT_VERSION,
  UNCALIBRATED_QUALITATIVE_INFO,
  type AnalyzeResponse,
  type ImageProperties,
  type SynthesisDetails,
} from '../shared/contracts.ts';
import { mapSynthesisRelationshipToCategory } from '../shared/validation.ts';
import { getSettings, type Settings } from './config.ts';
import { TruthLensError, ValidationFailedError, errorBody } from './errors.ts';
import { exportCaseManifest, importCaseManifest } from './services/caseManifest.ts';
import { WorkspaceCaseStore, type CaseStorageAdapter } from './services/caseStore.ts';
import { buildElaAnalysis } from './services/ela.ts';
import { buildFrequencyAnalysis } from './services/frequency.ts';
import { computeSha256 } from './services/hashing.ts';
import { buildRecompressionAnalysis } from './services/jpegCompression.ts';
import { buildMetadataAnalysis } from './services/metadata.ts';
import { buildNoiseAnalysis } from './services/noise.ts';
import { buildRegionalAnalysis } from './services/regional.ts';
import { buildRobustnessAnalysis } from './services/robustness.ts';
import { buildSynthesisAnalysis } from './services/synthesis.ts';
import { formatBytes, validateAndDecodeImage } from './utils/imageIo.ts';

export interface CreateApiAppOptions {
  settings?: Settings;
  caseStore?: CaseStorageAdapter;
}

export function createApiApp(options: CreateApiAppOptions = {}) {
  const settings = options.settings ?? getSettings();
  const caseStore = options.caseStore ?? new WorkspaceCaseStore(settings.casesDir);
  const app = express();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && settings.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: settings.maxUploadBytes },
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      application: settings.appName,
      status: 'healthy',
      version: settings.appVersion,
    });
  });

  app.post(
    '/api/v1/analyze',
    upload.any(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const mediaType =
          typeof req.body?.mediaType === 'string' ? req.body.mediaType.trim().toLowerCase() : 'image';

        if (mediaType && mediaType !== 'image') {
          throw new ValidationFailedError(
            `Media type '${mediaType}' is not yet supported by the forensic engine. Please submit a JPEG, PNG, or WEBP image.`,
            'unsupported_media_type',
          );
        }

        const files = Array.isArray(req.files) ? req.files : [];
        const uploaded =
          files.find((f) => f.fieldname === 'file') ??
          files.find((f) => f.fieldname === 'media') ??
          files[0];

        if (!uploaded) {
          throw new ValidationFailedError('No file provided.', 'missing_file');
        }

        if (!uploaded.buffer || uploaded.buffer.length === 0) {
          throw new ValidationFailedError('Empty file rejected.', 'empty_file');
        }

        // Preserve original upload bytes into CaseStore read-only before running decoding/analysis
        const requestedCaseId =
          typeof req.body?.caseId === 'string' && req.body.caseId.trim()
            ? req.body.caseId.trim()
            : null;
        const contextText =
          typeof req.body?.contextText === 'string' && req.body.contextText.trim()
            ? req.body.contextText.trim()
            : null;

        const decoded = await validateAndDecodeImage(uploaded.buffer, {
          filename: uploaded.originalname || null,
          declaredContentType: uploaded.mimetype || null,
          settings,
        });

        const activeCase = requestedCaseId
          ? (caseStore.getCase(requestedCaseId) ??
            caseStore.createCase({
              caseId: requestedCaseId,
              title: uploaded.originalname || 'Image Investigation',
              contextText,
              actor: 'api',
            }))
          : caseStore.createCase({
              title: uploaded.originalname || 'Image Investigation',
              contextText,
              actor: 'api',
            });

        const evidenceItem = caseStore.ingestEvidence(activeCase.case_id, {
          buffer: uploaded.buffer,
          filename: uploaded.originalname || null,
          declaredMime: uploaded.mimetype || null,
          modality: 'image',
          contextNote: contextText,
          actor: 'api',
        });

        const digest = computeSha256(uploaded.buffer);

        const [
          metadataAnalysis,
          elaAnalysis,
          noiseAnalysis,
          frequencyAnalysis,
          robustnessAnalysis,
        ] = await Promise.all([
          buildMetadataAnalysis(uploaded.buffer, decoded.format, {
            decodedWidth: decoded.width,
            decodedHeight: decoded.height,
            containerNotes: decoded.containerNotes,
          }),
          buildElaAnalysis(decoded, {
            quality: settings.elaDefaultQuality,
            gridRows: settings.regionalGridRows,
            gridCols: settings.regionalGridCols,
          }),
          buildNoiseAnalysis(decoded, {
            sigma: settings.noiseDefaultSigma,
            gridRows: settings.regionalGridRows,
            gridCols: settings.regionalGridCols,
          }),
          buildFrequencyAnalysis(decoded, {
            maxDimension: settings.fftMaxDimension,
            gridRows: settings.regionalGridRows,
            gridCols: settings.regionalGridCols,
          }),
          buildRobustnessAnalysis(decoded, {
            gridRows: settings.regionalGridRows,
            gridCols: settings.regionalGridCols,
          }),
        ]);

        const recompressionAnalysis = buildRecompressionAnalysis(uploaded.buffer, decoded, {
          elaAnalysis,
          gridRows: settings.regionalGridRows,
          gridCols: settings.regionalGridCols,
        });

        const regionalAnalysis = await buildRegionalAnalysis(decoded, {
          gridRows: settings.regionalGridRows,
          gridCols: settings.regionalGridCols,
          edgeThreshold: settings.regionalEdgeThreshold,
          elaAnalysis,
          noiseAnalysis,
          recompressionAnalysis,
        });

        const properties: ImageProperties = {
          filename: decoded.filename,
          format: decoded.format,
          mime_type: decoded.mimeType,
          size_bytes: decoded.sizeBytes,
          size_readable: decoded.sizeReadable,
          width: decoded.width,
          height: decoded.height,
          aspect_ratio: decoded.aspectRatio,
          pixel_count: decoded.pixelCount,
          mode: decoded.mode,
          has_transparency: decoded.hasTransparency,
        };

        const synthesisAnalysis = buildSynthesisAnalysis([
          metadataAnalysis,
          elaAnalysis,
          noiseAnalysis,
          frequencyAnalysis,
          recompressionAnalysis,
          robustnessAnalysis,
          regionalAnalysis,
        ]);

        const synthDetails = synthesisAnalysis.details as SynthesisDetails | null;
        const relationship = synthDetails?.evidence_summary?.relationship ?? 'insufficient_evidence';
        const synthesisSummary =
          synthDetails?.evidence_summary?.synthesis_statement ??
          'Forensic analysis and evidence synthesis completed.';

        const analysisTimestamp = new Date().toISOString();

        const basePayload: AnalyzeResponse = {
          success: true,
          application: settings.appName,
          phase: 'phase_3',
          schema_version: TRUTHLENS_CONTRACT_VERSION,
          case_id: activeCase.case_id,
          evidence_id: evidenceItem.evidence_id,
          analysis_timestamp: analysisTimestamp,
          maturity_tier: 'A',
          calibration: UNCALIBRATED_QUALITATIVE_INFO,
          image_properties: properties,
          sha256: digest,
          analyses: [
            { ...metadataAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...elaAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...noiseAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...frequencyAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...recompressionAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...robustnessAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...regionalAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
            { ...synthesisAnalysis, tier: 'A', calibration: UNCALIBRATED_QUALITATIVE_INFO },
          ],
          assessment: {
            status: relationship === 'insufficient_evidence' ? 'INCONCLUSIVE' : 'COMPLETE',
            summary: synthesisSummary,
            limitations: [...synthesisAnalysis.limitations],
            relationship,
            category: mapSynthesisRelationshipToCategory(relationship),
            maturity_tier: 'A',
            calibration: UNCALIBRATED_QUALITATIVE_INFO,
          },
        };

        caseStore.recordAnalysisRun(activeCase.case_id, {
          evidenceId: evidenceItem.evidence_id,
          modality: 'image',
          toolVersion: settings.appVersion,
          maturityTier: 'A',
          calibration: UNCALIBRATED_QUALITATIVE_INFO,
          parameters: {
            ela_quality: settings.elaDefaultQuality,
            noise_sigma: settings.noiseDefaultSigma,
            fft_max_dimension: settings.fftMaxDimension,
            regional_grid: `${settings.regionalGridRows}x${settings.regionalGridCols}`,
            recompression_enabled: true,
            robustness_enabled: true,
          },
          result: basePayload,
          actor: 'api',
        });

        const auditVerification = caseStore.verifyAuditLog(activeCase.case_id);
        const payload: AnalyzeResponse = {
          ...basePayload,
          audit_head_hash: auditVerification.head_hash,
        };

        res.json(payload);
      } catch (err) {
        next(err);
      }
    },
  );

  // ===========================================================================
  // Phase 1 Case, Evidence Custody, Audit Chain & Manifest Export/Import Routes
  // ===========================================================================
  const jsonParser = express.json({ limit: '50mb' });

  app.post('/api/v1/cases', jsonParser, (req: Request, res: Response, next: NextFunction) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
      const contextText =
        typeof req.body?.context_text === 'string' ? req.body.context_text : undefined;
      const created = caseStore.createCase({ title, contextText, actor: 'api' });
      res.status(201).json({ success: true, case: created });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/cases', (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        schema_version: TRUTHLENS_CONTRACT_VERSION,
        ephemeral_storage_notice: caseStore.ephemeralNotice,
        cases: caseStore.listCases(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/cases/import', jsonParser, (req: Request, res: Response, next: NextFunction) => {
    try {
      const requireOriginals = req.query.requireOriginals === 'true';
      const manifestBody = req.body?.manifest ?? req.body;
      const imported = importCaseManifest(caseStore, manifestBody, {
        requireOriginalEvidence: requireOriginals,
        actor: 'api_import',
      });
      res.status(201).json({
        success: true,
        case: imported.caseRecord,
        verification: imported.verification,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/cases/:caseId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const caseId = String(req.params.caseId);
      const found = caseStore.getCase(caseId);
      if (!found) {
        throw new TruthLensError(`Case '${caseId}' not found.`, 404, 'case_not_found');
      }
      res.json({ success: true, case: found });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/cases/:caseId/evidence',
    upload.any(),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const caseId = String(req.params.caseId);
        const files = Array.isArray(req.files) ? req.files : [];
        const uploaded =
          files.find((f) => f.fieldname === 'file') ??
          files.find((f) => f.fieldname === 'media') ??
          files[0];
        if (!uploaded) {
          throw new ValidationFailedError('No evidence file provided.', 'missing_file');
        }
        if (!uploaded.buffer || uploaded.buffer.length === 0) {
          throw new ValidationFailedError('Empty evidence file rejected.', 'empty_file');
        }
        const modalityRaw =
          typeof req.body?.modality === 'string' ? req.body.modality.trim().toLowerCase() : undefined;
        const modality =
          modalityRaw === 'image' ||
          modalityRaw === 'video' ||
          modalityRaw === 'audio' ||
          modalityRaw === 'text'
            ? modalityRaw
            : undefined;
        const contextNote =
          typeof req.body?.context_note === 'string' ? req.body.context_note : undefined;

        const item = caseStore.ingestEvidence(caseId, {
          buffer: uploaded.buffer,
          filename: uploaded.originalname || null,
          declaredMime: uploaded.mimetype || null,
          modality,
          contextNote,
          actor: 'api',
        });
        res.status(201).json({ success: true, evidence_item: item });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/v1/cases/:caseId/audit', (req: Request, res: Response, next: NextFunction) => {
    try {
      const caseId = String(req.params.caseId);
      const events = caseStore.getAuditLog(caseId);
      const verification = caseStore.verifyAuditLog(caseId);
      res.json({
        success: true,
        case_id: caseId,
        verification,
        events,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/cases/:caseId/verify', (req: Request, res: Response, next: NextFunction) => {
    try {
      const caseId = String(req.params.caseId);
      const report = caseStore.verifyCaseIntegrity(caseId);
      res.json({
        success: true,
        integrity: report,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/cases/:caseId/export', (req: Request, res: Response, next: NextFunction) => {
    try {
      const caseId = String(req.params.caseId);
      const includeOriginalEvidence = req.query.includeOriginals === 'true';
      const includeAnalysisResults = req.query.includeResults !== 'false';
      const manifest = exportCaseManifest(caseStore, caseId, {
        includeOriginalEvidence,
        includeAnalysisResults,
        exporterName: settings.appName,
        exporterVersion: settings.appVersion,
        actor: 'api_export',
      });
      res.json(manifest);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res
          .status(413)
          .json(
            errorBody(
              'payload_too_large',
              `File exceeds the maximum upload size of ${formatBytes(settings.maxUploadBytes)}.`,
            ),
          );
        return;
      }
      res.status(400).json(errorBody('upload_error', err.message));
      return;
    }

    if (err instanceof TruthLensError) {
      res.status(err.statusCode).json(errorBody(err.code, err.message));
      return;
    }

    res
      .status(500)
      .json(
        errorBody(
          'internal_error',
          'An unexpected error occurred while processing the request.',
        ),
      );
  });

  return { app, settings, caseStore };
}
