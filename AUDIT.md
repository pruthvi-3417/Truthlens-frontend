# TruthLens Repository Audit (Phase 0 / Gate 0)

**Audit Date:** 2026-11-19  
**Scope:** Full-repository read-only audit and runtime verification. No feature code added.

---

## 1. Environment Check

| Component | Status / Version | Notes |
|---|---|---|
| OS / Kernel | `Linux localhost 4.19.0-gvisor #1 SMP x86_64` | Containerized Linux x86_64 |
| Node.js | `v22.23.2` | Active runtime (native TypeScript execution supported) |
| npm | `10.9.8` | Package manager |
| Python | `Python 3.11.2` | System binary present |
| pytest | **Not installed** (`pytest: not found`) | No Python virtualenv or test runner installed |
| ffmpeg | **Available** (`/usr/bin/ffmpeg`, `4.4.2-0ubuntu0.22.04.1+esm17`) | Ready for Tier B video frame extraction and audio decoding |
| ffprobe | **Available** (`/usr/bin/ffprobe`, `4.4.2-0ubuntu0.22.04.1+esm17`) | Ready for Tier B container/stream metadata inspection |
| GPU | **None / Unavailable** (`nvidia-smi: not found`) | CPU-only execution; precludes heavy model training or GPU inference |

---

## 2. Directory Map, Entry Points, and Dependencies

### 2.1 Directory Map

```
.
├── .env.example                    # Placeholder env vars (all empty by default)
├── .gitignore
├── AUDIT.md                        # This audit report
├── README.md                       # Root readme (still references frontend-only setup)
├── bun.lock                        # Leftover empty/lock artifact from import
├── metadata.json                   # AI Studio app metadata
├── package.json                    # Root npm workspace manifest (dev/build/start/lint)
├── server.ts                       # Node.js Express + Vite middleware entrypoint (port 3000)
├── docs/
│   └── samples/
│       └── analyze_response.real.json  # Real POST /api/v1/analyze output for hero.png
├── server/                         # Ported Node.js/TypeScript forensic backend
│   ├── config.ts                   # Env-based settings (limits, grid, sigma, quality)
│   ├── errors.ts                   # Typed errors & JSON error envelope
│   ├── types.ts                    # Backend API response interfaces
│   ├── services/
│   │   ├── ela.ts                  # JPEG Error Level Analysis + 4x4 grid + PNG vis
│   │   ├── frequency.ts            # 2D FFT spectral bands + entropy + PNG vis
│   │   ├── hashing.ts              # SHA-256 hex digest of raw input bytes
│   │   ├── metadata.ts             # EXIF extraction (exifr) with GPS coords withheld
│   │   ├── noise.ts                # Gaussian blur residual + stats + 4x4 grid + PNG vis
│   │   ├── regional.ts             # 4x4 MAD Z-score anomaly map + SVG/PNG overlay vis
│   │   └── synthesis.ts            # Phase 3 5-domain evidence aggregation & observations
│   └── utils/
│       ├── fft2d.ts                # Radix-2 / Bluestein arbitrary-size 2D FFT
│       └── imageIo.ts              # Sharp image validation, pixel decoding, grid partition
├── frontend/
│   ├── BACKEND_INTEGRATION_CHECKLIST.md
│   ├── README.md
│   ├── index.html
│   ├── package.json                # Legacy frontend-only package manifest
│   ├── vite.config.ts              # Vite 8 config (host 0.0.0.0, port 3000)
│   ├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
│   ├── .oxlintrc.json
│   ├── public/                     # favicon.svg, icons.svg
│   └── src/
│       ├── App.tsx / main.tsx / styles.css / index.css / theme.ts
│       ├── assets/                 # hero.png (343x361 PNG), react.svg, vite.svg
│       ├── components/
│       │   ├── layout/AppLayout.tsx
│       │   └── ui/                 # BackendResult, Common, ConfirmationDialog, FileDropzone,
│       │                           # ImageEvidenceDashboard, MediaPreview, PageHeader
│       ├── lib/investigationStore.ts   # localStorage-only history store
│       ├── pages/                  # Landing, Dashboard, Analyze, Processing, Results,
│       │                           # History, Methods, Reports, About, Settings
│       ├── services/analysisAdapter.ts # Fetch wrapper + response normalization
│       └── types/index.ts
└── backend/                        # Legacy Python FastAPI directory (source migrated & removed;
    ├── README.md                   # only README.md and stale __pycache__/*.pyc remain)
    └── app/**/__pycache__/*.pyc & tests/__pycache__/*.pyc
```

### 2.2 Entry Points

- **Unified Runtime (`package.json`):**
  - `npm run dev` → `tsx server.ts` (Express API + Vite dev middleware on `0.0.0.0:3000`)
  - `npm run build` → `tsc -b frontend/tsconfig.json && vite build --config frontend/vite.config.ts`
  - `npm run start` → `node server.ts` (Express API + static `frontend/dist` on `0.0.0.0:3000`)
  - `npm run lint` → `oxlint -c frontend/.oxlintrc.json frontend/src server.ts server`
- **HTTP Endpoints (`server.ts`):**
  - `GET /health` → `{ application, status: "healthy", version }`
  - `POST /api/v1/analyze` → `multipart/form-data` (`media` or `file` field), synchronous image forensic pipeline.

### 2.3 Dependency Versions (`package.json`)

- **Backend / Server:** `express@^4.21.2`, `multer@^1.4.5-lts.1`, `sharp@^0.33.5`, `exifr@^7.1.3`, `tsx@^4.19.3`
- **Frontend:** `react@^19.3.1`, `react-dom@^19.3.1`, `react-router-dom@^7.18.6`, `lucide-react@^1.75.0`, `recharts@^3.11.0`, `tailwindcss@^4.3.5`, `@tailwindcss/vite@^4.3.5`
- **Tooling:** `vite@^8.3.6`, `typescript@~7.0.2`, `oxlint@^1.90.0`

---

## 3. Verified Backend Capabilities (Live Runs Against `http://127.0.0.1:3000`)

All checks below were executed against the running server on 2026-11-19.

| Capability | Status | Observed Verification Result |
|---|---|---|
| `GET /health` | **Working** | `200 OK` → `{"application":"TruthLens","status":"healthy","version":"1.0.0"}` |
| Upload & validation | **Working** | Empty file → `400 empty_file`; plain text → `400 unrecognized_image`; `mediaType=video` → `400 unsupported_media_type` |
| Format verification (content-sniffed) | **Working** | PNG bytes uploaded as `spoof.jpg` (`image/jpeg`) decoded accurately as `format: "PNG"` |
| Dimensions & image properties | **Working** | `frontend/src/assets/hero.png` reported `343x361`, `pixel_count: 123823`, `has_transparency: false`, `size_bytes: 59008` |
| SHA-256 fingerprinting | **Working** | Exact match with `crypto.createHash('sha256')` on `hero.png` bytes (`64`-char lowercase hex) |
| EXIF / metadata extraction + GPS privacy | **Working** | Tested synthetic JPEG with Canon EOS R5 / Photoshop / DateTimeOriginal / GPSLatitude & GPSLongitude: extracted camera/software/timestamp fields, reported `gps_present: true` and `gps_fields_present: ["GPSLatitude","GPSLatitudeRef","GPSLongitude","GPSLongitudeRef"]`, and **did not leak coordinate values** (`LEAKS_COORDS?: false`). Note: `exifr` returned `orientation: "Horizontal (normal)"` (translated string) instead of integer `1`. |
| ELA (+ regional + visualization) | **Working** | JPEG (`hero.jpg` Q=88): `status: "completed"`, `mean_difference: 0.403`, `16` regional tiles, base64 PNG `difference_image_data_url` generated. PNG & WEBP: `status: "unavailable"` with format-specific limitation note. |
| Noise residual (+ stats + regional) | **Working** | JPEG/PNG/WEBP: `status: "completed"`, Gaussian blur (`sigma=1.0`), `residual_std: 5.6738` (JPEG), `16` regional tiles, base64 PNG `visualization_data_url` generated. |
| 2D FFT frequency domain | **Working** | `status: "completed"`, Hann windowing, radial band percentages (`33.26% / 41.85% / 24.89%` on JPEG test), centroid, normalized Shannon entropy, base64 PNG spectrum visualization. |
| Regional anomaly mapping | **Working** | `status: "completed"`, `16` tiles (`4x4`), median/MAD Z-scores, 4-connected neighbor deviation, base64 PNG overlay with legend footer. |
| Phase 3 Evidence Aggregation (`synthesis`) | **Working** | `status: "completed"`, evaluates 5 domains (`metadata`, `compression`, `noise`, `frequency`, `spatial`), classifies relationship (`isolated_observation` on JPEG test; `no_notable_variation` on `hero.png`), emits structured `key_observations`, `cross_domain_relationships`, `regional_synthesis`, `limitations`, and `methodology`. |

### Real Sample Output
The actual JSON response from `POST /api/v1/analyze` on `frontend/src/assets/hero.png` is saved verbatim at:
- `docs/samples/analyze_response.real.json`

---

## 4. Test Suite & Static Check Results

- **Pytest results:** **0 tests run (pytest not installed; Python `backend/app/*.py` and `backend/tests/*.py` were removed during the Node.js migration)**. Only stale `__pycache__/*.pyc` artifacts remain under `backend/`. Currently there are **no automated backend unit/integration tests or frontend component tests** in the repository.
- **TypeScript / Build / Lint checks executed:**
  - `npx tsc --noEmit --target es2023 --module nodenext --moduleResolution nodenext --skipLibCheck --allowImportingTsExtensions --erasableSyntaxOnly --strict server.ts server/**/*.ts` → **Exit 0 (0 errors)**
  - `npm run build` (`tsc -b frontend/tsconfig.json && vite build --config frontend/vite.config.ts`) → **Exit 0 (built `frontend/dist`)**
  - `npm run lint` (`oxlint -c frontend/.oxlintrc.json frontend/src server.ts server`) → **Exit 0 (0 warnings, 0 errors across 37 files)**

---

## 5. Frontend Adapter Assumptions vs. Real Backend Response (Mismatch List)

While `frontend/src/services/analysisAdapter.ts` was patched during migration to parse `AnalyzeResponse`, the following contract mismatches and gaps remain:

1. **Assessment schema mismatch:**
   - **Backend returns:** `assessment: { status: "COMPLETE", summary: string, limitations: string[] }` plus `synthesis.details.evidence_summary.relationship` (`no_notable_variation` | `isolated_observation` | `mixed_observations` | `converging_observations` | `insufficient_evidence`).
   - **Frontend expects:** `InvestigationResult.assessment` typed as `'NO MAJOR INDICATORS' | 'REQUIRES REVIEW' | 'MULTIPLE ANOMALIES' | 'INCONCLUSIVE'`. `Results.tsx` displays only `"Backend-provided assessment"` and drops `assessment.summary` and `assessment.limitations`.
2. **Hardcoded Investigation ID bug in `ImageEvidenceDashboard.tsx` (line 47):**
   - Renders `{evidence.sha256 ? 'Unavailable' : 'Unavailable'}` inside the "Investigation summary" accordion instead of the investigation/case ID.
3. **Original Image Preview missing in `Results.tsx`:**
   - Backend does not return `originalImageUrl` and `Analyze.tsx` revokes its local `URL.createObjectURL` on unmount, so the "Original image" card in `ImageEvidenceDashboard.tsx` always shows `"Original image unavailable"`.
4. **EXIF fields dropped or formatted inconsistently:**
   - `exifr` returns translated orientation strings (`"Horizontal (normal)"`) instead of raw EXIF numbers, and `ImageEvidenceDashboard.tsx` ignores `lens`, `orientation`, `color_space`, `exif_version`, `fields_found`, `fields_missing`, and `format_notes`.
5. **Rich Phase 3 fields hidden/flattened in Image UI:**
   - `ela.threshold_percentages`, `ela.channel_maxes`, and `ela.regional_summary` are omitted.
   - `RegionalGrid` renders only `region` and a single `value`, discarding `variance`, `max_difference`, `std`, `neighbor_deviation`, `z_scores`, and tile `observation`.
   - `synthesis.details.regional_synthesis` (per-tile classification `low | typical | elevated | divergent` and `contributing_domains`), `cross_domain_relationships`, `methodology`, and structured `key_observations` (`supporting_metrics`, `region_ids`, `neutral_interpretation`) are not rendered as structured forensic findings on the image report page.
6. **No Case / Custody / Audit Log / Calibration / Maturity Tier fields:**
   - Neither backend nor frontend currently implements `schema_version`, `case`, `evidence_item`, `custody_events`, `audit_log` (hash chain), `robustness`, `calibration` metadata, or explicit `tier` (`A | B | C`) badges.

---

## 6. Unwired / Stubbed UI Modules Inventory

| UI Route / Component | Current Wiring Status | Gap Details |
|---|---|---|
| `Analyze.tsx` — Video tab | **Unwired (rejects on submit)** | Validates MP4/MOV/WEBM locally, posts to `/api/v1/analyze`, receives `400 unsupported_media_type`. |
| `Analyze.tsx` — Audio tab | **Unwired (rejects on submit)** | Validates WAV/MP3/M4A/AAC/OGG/OPUS locally, posts to `/api/v1/analyze`, receives `400 unsupported_media_type`. |
| `Analyze.tsx` — Text tab | **Unwired (rejects on submit)** | Accepts text or `.txt` upload, posts to `/api/v1/analyze`, receives `400 unsupported_media_type`. |
| `Analyze.tsx` — Case / context | **Missing** | Single-item upload only; cannot attach multiple files into one Case or supply context text alongside media. |
| `Processing.tsx` | **Wired to nothing** | Expects async `jobId` + `VITE_TRUTHLENS_STATUS_PATH` polling; backend is synchronous (`200` direct result). All 10 pipeline stage rows are hardcoded `"Unconfirmed"`. |
| `Results.tsx` — Export button | **Disabled stub** | Hardcoded `<button disabled>Report unavailable</button>`. |
| `Reports.tsx` | **Empty stub** | Static `"No reports available"` page; no backend report list or JSON/PDF export. |
| `History.tsx` | **LocalStorage only** | Reads/deletes `localStorage['truthlens-investigations']`; no backend case store, no audit log, no chain-of-custody hash verification. Download icon relies on `record.reportUrl` (never populated). |
| `Dashboard.tsx` | **LocalStorage + `/health` only** | Stats and Recharts bar chart reflect only browser `localStorage` entries. |
| `Settings.tsx` | **Partially unwired** | `ThemePreference` works (`dark`/`light`/`system`). `saveHistory` toggle writes `localStorage['truthlens-save-history']`, but `Analyze.tsx` **ignores** that setting and always calls `saveInvestigation()`. |

---

## 7. Open Risks & Observations for Phase 1+

1. **Zero automated tests currently exist** after the Python-to-Node.js migration; a Node test suite (e.g. `node --test` or `vitest`) and frontend component tests must be built from scratch starting in Phase 1/2.
2. **Ephemeral filesystem in container:** AI Studio containers do not persist disk across sleeps, so read-only evidence originals + append-only custody/audit logs should support in-session disk/memory storage with JSON export/import verification.
3. **CPU-only environment (`4`+ GB RAM / no GPU):** Video frame sampling and audio spectrogram analysis via `ffmpeg`/`ffprobe` + `sharp` are feasible and fast; any heavy ML deepfake models are not practical unless lightweight ONNX/CPU-only and strictly validated.
4. **Leftover artifacts:** Stale `backend/**/__pycache__/*.pyc` files and `bun.lock` remain in the repo root/backend folder and should be cleaned up when convenient (outside Phase 0).
