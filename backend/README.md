# TruthLens Backend

FastAPI service for image forensic analysis.

**Phase:** `phase_3`  
**Tagline:** See beyond the image. Verify what is real.

## Overview

Phase 3 provides a unified, explainable evidence aggregation engine built on top of five modular forensic analytical services:

1. Safe image upload intake (in-memory)
2. Format and integrity validation
3. Image property extraction
4. SHA-256 fingerprinting of the original file bytes
5. EXIF / metadata extraction and provenance interpretation
6. Error Level Analysis (ELA) engine for JPEG lossy compression
7. Noise residual analysis for JPEG, PNG, and WEBP images
8. Frequency-domain analysis using 2D Fast Fourier Transform (FFT)
9. Regional anomaly analysis across spatial grid partitions
10. Evidence Aggregation & Synthesis Engine across five independent forensic domains

AI image detection, binary fake/authentic classifications, and synthetic manipulation probabilities are **strictly not implemented** and are never fabricated.

## Architecture

```
backend/
├── app/
│   ├── main.py              # FastAPI app, CORS, routers
│   ├── api/routes/          # HTTP endpoints (analyze, health)
│   ├── core/                # Settings and error handling
│   ├── models/              # Pydantic response contracts
│   ├── services/            # Validation, hashing, metadata, ELA, noise, frequency, regional, synthesis
│   └── utils/               # Image I/O helpers and grid partitioner
├── tests/
├── requirements.txt
├── .env.example
└── README.md
```

## Installation

Requires **Python 3.11+**.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # optional local overrides
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_NAME` | `TruthLens` | Application name |
| `APP_VERSION` | `1.0.0` | API version |
| `DEBUG` | `false` | Debug flag |
| `CORS_ORIGINS` | Vite/local origins | Comma-separated allowed origins |
| `MAX_UPLOAD_BYTES` | `15728640` (15 MB) | Max upload size |
| `MAX_IMAGE_DIMENSION` | `12000` | Max width or height |
| `MAX_PIXEL_COUNT` | `40000000` | Max total pixels |
| `ELA_DEFAULT_QUALITY` | `90` | Default recompression quality for ELA (1–100) |
| `NOISE_DEFAULT_SIGMA` | `1.0` | Default Gaussian smoothing sigma for noise analysis |
| `FFT_MAX_DIMENSION` | `2048` | Max image dimension before 2D FFT downsampling |
| `REGIONAL_GRID_ROWS` | `4` | Default vertical grid rows for regional analysis |
| `REGIONAL_GRID_COLS` | `4` | Default horizontal grid columns for regional analysis |
| `REGIONAL_EDGE_THRESHOLD` | `15.0` | Gradient magnitude threshold for edge density |

See `.env.example` for safe placeholders. Do not commit a real `.env`.

CORS uses an explicit origin allowlist. Wildcard origins are not combined with credentials.

## Running the server

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- Swagger UI: http://localhost:8000/docs  
- OpenAPI schema: http://localhost:8000/openapi.json  

## Running tests

```bash
cd backend
source .venv/bin/activate
pytest
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health |
| `POST` | `/api/v1/analyze` | Validation + properties + SHA-256 + metadata |

### Sample curl

```bash
curl -X POST "http://localhost:8000/api/v1/analyze" \
  -F "file=@sample.jpg"
```

## Metadata extraction (Phase 2A)

### Supported formats

| Format | Notes |
|--------|--------|
| JPEG | Full classic EXIF support when present |
| PNG | Often has no EXIF; absence is normal |
| WEBP | EXIF optional depending on encoder; absence is common |

### Fields extracted when present

- Camera make / model
- Lens information (when available)
- Orientation
- Capture / digitized date-time
- Software / processing software indicators
- Color space
- EXIF version
- GPS **presence** and GPS **field names only**

### GPS privacy

- Exact GPS coordinates are **never** returned by default
- The API reports `gps_present` and `gps_fields_present` (tag names only)
- Latitude / longitude / altitude values are withheld

### Interpretation rules

- Missing metadata ≠ AI-generated or manipulated
- Camera metadata ≠ authenticity
- Software tags alone ≠ proof of editing
- No authenticity percentage or binary fake/authentic verdict

### Analysis status meanings

| Status | Meaning |
|--------|---------|
| `completed` | Metadata analysis finished (EXIF may be present or absent) |
| `failed` | Parsing failed defensively; see `details.parse_errors` |

Empty EXIF is reported as `completed` with `exif_present: false`, not as failure.

## Error Level Analysis (Phase 2B)

### Overview

Error Level Analysis (ELA) identifies differences in JPEG compression levels across an image:

1. Decodes the validated JPEG into RGB.
2. Recompresses the image in memory at a controlled baseline quality (default: `90`).
3. Decodes the recompressed image and verifies identical spatial dimensions.
4. Computes absolute pixel differences across RGB channels: `abs(original - recompressed)`.
5. Computes image-level distribution metrics, channel metrics, threshold exceedance percentages, and regional grid statistics.
6. Generates a normalized difference visualization as a base64 PNG data URL.
7. Produces factual forensic observations and limitations.

### Supported formats

| Format | ELA Status | Notes |
|--------|------------|-------|
| JPEG | `completed` | Recompression analysis executed |
| PNG | `unavailable` | ELA is specific to JPEG lossy DCT compression |
| WEBP | `unavailable` | Non-JPEG format |

### ELA Metrics

- **Mean absolute pixel difference:** Global average pixel error on a 0–255 scale
- **Median difference:** 50th percentile of absolute error
- **Maximum difference:** Peak error observed (0–255)
- **95th and 99th percentiles:** Upper-tail error distribution
- **Threshold exceedance percentages:** Percentage of pixels exceeding difference thresholds (5, 10, 15, 20, 30, 50)
- **Channel metrics:** Per-channel mean and maximum difference for Red, Green, and Blue
- **Regional metrics:** Spatial grid partition (e.g. 4x4) computing mean, variance, and max difference per tile
- **Regional summary:** Minimum, maximum, spread, and variance across regions

### Forensic interpretation principles

- ELA indicates relative compression artifacts against a recompression baseline, not absolute authenticity.
- High-frequency edges and complex textures naturally exhibit higher error due to discrete cosine transform (DCT) quantization.
- Uniform error does not prove lack of manipulation; localized variations do not prove forgery.
- Never classifies images as real/fake or calculates authenticity probabilities.

## Noise Residual Analysis (Phase 2C)

### Overview

Noise Residual Analysis extracts high-frequency spatial deviations from an image by suppressing underlying low-frequency image structure:

1. Decodes the validated image to RGB.
2. Applies a Gaussian low-pass filter to RGB channels using a controlled standard deviation (`sigma=1.0` by default).
3. Converts original and smoothed images to `float32`.
4. Calculates the signed pixel residual:
   $$\text{Residual} = \text{Original Image} - \text{Smoothed Image}$$
5. Computes signed residual statistics and absolute residual magnitude metrics.
6. Computes regional residual distribution using a 4×4 spatial grid.
7. Normalizes the absolute residual magnitude for visualization (base64 PNG data URL) without altering analytical metrics.
8. Produces neutral, factual forensic observations and limitations.

### Supported formats

| Format | Noise Analysis Status | Notes |
|--------|-----------------------|-------|
| JPEG | `completed` | Spatial filter applied across RGB pixels |
| PNG | `completed` | Supported for all validated PNG modes |
| WEBP | `completed` | Supported for all validated WEBP modes |

### Metrics returned

- **Residual mean:** Signed average residual across all channels (scale: -255 to +255)
- **Residual standard deviation:** Global dispersion of the signed residual
- **Mean absolute residual:** Average residual magnitude on a 0–255 scale
- **Median absolute residual:** 50th percentile of residual magnitude
- **Maximum absolute residual:** Peak absolute residual observed
- **95th and 99th percentiles:** Upper-tail magnitude distribution
- **Channel metrics:** Per-channel signed mean, standard deviation, and mean absolute residual for Red, Green, and Blue
- **Regional metrics:** 4×4 spatial grid partition (`RegionalNoiseMetric`) computing mean absolute residual (`mean_difference`), residual standard deviation (`std`), and maximum absolute residual (`max_difference`) per tile
- **Regional summary:** Minimum, maximum, spread, and average regional standard deviation

### Forensic interpretation principles and limitations

- **Edges and textures:** High-frequency content, high-contrast boundaries, and complex textures naturally yield elevated residual magnitudes because low-pass filtering attenuates sharp transitions.
- **Processing history:** Routine operations like JPEG recompression, sharpening, downsampling, and denoising alter residual noise distributions non-linearly.
- **Sensor variations:** Authentic physical cameras produce widely varying noise levels depending on sensor model, ISO rating, sensor temperature, and ambient exposure.
- **AI and manipulation:** Noise uniformity or regional disparity cannot prove or disprove AI generation or digital manipulation.
- **No verdicts:** TruthLens never outputs authenticity scores, manipulation probabilities, or binary real/fake determinations.

## Frequency Domain Analysis (2D FFT)

### Algorithm and Pipeline

1. **Luminance conversion:** ITU-R BT.601 conversion ($Y = 0.299R + 0.587G + 0.114B$) on 32-bit float RGB values.
2. **DC suppression:** Spatial mean subtraction of the image luminance array.
3. **Windowing:** Separable 2D Hann window to reduce spectral edge leakage.
4. **2D FFT & shift:** `numpy.fft.fft2` and `fftshift` to position zero frequency at spectrum center.
5. **Radial partitioning:** Normalized frequency radius $r \in [0, \sqrt{2}]$ split into:
   - Low frequency: $0.0 < r < 0.10$
   - Mid frequency: $0.10 \le r < 0.40$
   - High frequency: $r \ge 0.40$
6. **Spectral metrics:** Non-DC spectral power percentages, spectral centroid, and normalized Shannon spectral entropy.
7. **Visualization:** Normalized centered log-magnitude spectrum ($\log(1 + |\mathcal{F}|)$) encoded as base64 PNG data URL.

## Regional Anomaly Analysis

### Objective and Principles

The Regional Anomaly Analysis engine examines spatial variations across the image and measures how individual regions differ statistically from image-wide distributions and from adjacent neighbors.

**Forensic Principle:** Spatial differences occur naturally in photographic images due to illumination gradients, depth of field, scene content, shadows, camera autofocus, and texture variations. Statistical deviation indicates contrast in measured properties, **not** proof of manipulation, AI generation, or forgery.

### Grid Partitioning

- Default partition: 4×4 uniform grid (16 tiles).
- Uses shared `partition_grid` algorithm to ensure 100% pixel coverage without gaps or overlaps.
- Non-divisible dimensions are handled gracefully via integer rounding with exact boundary anchoring.
- Small images and edge regions are handled safely without zero-dimension crashes.

### Extracted Regional Features

Each region extracts a structured feature set:

1. **Luminance / Intensity:**
   - Mean luminance
   - Standard deviation of luminance
   - Minimum and maximum luminance
2. **Texture and Spatial Characteristics:**
   - Mean gradient magnitude
   - Gradient standard deviation (texture variation)
   - Edge density (percentage of pixels exceeding gradient threshold)
3. **Noise Residual Integration:**
   - Residual standard deviation (`noise_residual_std`)
   - Mean absolute residual (`noise_mean_abs`)
   - Reused directly from the Noise analysis service without duplicate computation
4. **Error Level Analysis Integration:**
   - Mean recompression difference (`ela_mean`)
   - Difference variance (`ela_variance`)
   - Reused directly when available (JPEG images)
5. **Regional Frequency Analysis:**
   - Regional high-frequency energy ratio computed via localized 2D FFT on tile luminance if tile dimensions $\ge 8\times 8$ pixels.

### Statistical Deviation Scoring

To provide robust comparison resilient against outliers, deviation scores use **Median and Median Absolute Deviation (MAD)** modified Z-scores:

$$Z_{i, k} = \frac{|x_{i, k} - \text{median}(X_k)|}{1.4826 \cdot \text{MAD}(X_k) + \epsilon}$$

If $\text{MAD} = 0$, standard deviation is used as fallback. If $\sigma = 0$ (e.g. completely uniform image), $Z_{i, k} = 0.0$.

- **Composite Deviation Score:**
  $$S_i = \frac{1}{|\mathcal{K}|} \sum_{k \in \mathcal{K}} Z_{i, k}$$
- **Spatial Neighbor Deviation:** Average standardized feature distance between region $(r, c)$ and its 4-connected adjacent grid neighbors.

### Visualization

- Clean semi-transparent overlay rendered on top of the image.
- Color ramp mapping deviation score:
  - Cool Blue (0.0): Low deviation / consistent with image-wide median
  - Amber (0.5): Moderate spatial variation
  - Crimson (1.0): Elevated statistical contrast
- Region boundaries and ID labels (`r{row}_c{col}`).
- Legend color bar at the bottom indicating scale and explicit non-tampering disclaimer.
- Base64 encoded as PNG data URL (`visualization_data_url`).

## Evidence Aggregation & Synthesis Engine (Phase 3 & 3.1)

### Methodology & Principles

The Phase 3 Synthesis Engine aggregates individual forensic measurements into four independent physical/data evidence domains, supported by a spatial localization dimension:

1. **Metadata & Provenance:** Camera hardware tags, timestamps, editing/export software signatures, metadata completeness. (Absence of metadata is standard for web/social media images and is never treated as manipulation).
2. **Compression & Recompression (ELA):** JPEG recompression error magnitudes and regional error spread relative to an analysis baseline.
3. **Noise & Texture:** Gaussian low-pass residual standard deviation and regional noise dispersion.
4. **Frequency Spectrum:** 2D Fast Fourier Transform radial energy distribution (low, mid, high bands), centroid, and spectral entropy.
5. **Spatial Consistency (Supporting Dimension):** Regional grid anomaly scores, multi-feature deviation, spatial neighbor contrast, and regional convergence. Spatial Consistency functions as a supporting analytical dimension for spatial localization and cross-domain overlap; it does not independently inflate the count of independent evidence domains (TL-P3-001).

### Correlated Feature Weighting & Grouped Composite Deviation (TL-P3-003)

To prevent multi-collinear metrics (e.g. `mean_gradient`, `std_gradient`, and `edge_density` from gradient magnitude; `noise_residual_std` and `noise_mean_abs` from residual arrays) from dominating regional composite scores, regional synthesis groups correlated measurements into domain-level scores first:
- **Texture Domain:** Arithmetic mean of available gradient and edge density metrics.
- **Luminance Domain:** Arithmetic mean of luminance standard deviation and mean luminance.
- **Noise Domain:** Arithmetic mean of residual standard deviation and mean absolute residual.
- **Compression Domain:** Arithmetic mean of ELA difference mean and variance.
- **Frequency Domain:** Regional high-frequency energy ratio.

The regional composite deviation score is computed as the arithmetic mean of available domain scores rather than unweighted raw features, ensuring that correlated metrics do not artificially inflate regional deviation. Missing domains (such as Compression on PNG images) are excluded without diluting the composite score.

### Regional Classification Precedence (TL-P3-002)

Regional tiles are classified deterministically based on domain elevation and composite deviation:
- `divergent`: 3 or more contributing domains elevated ($Z \ge 1.8$) or composite deviation $\ge 3.0$.
- `elevated`: 2 or more contributing domains elevated (multi-domain) or composite deviation $\ge 1.5$.
- `low`: Strictly assigned only when **zero** contributing domains are elevated and composite deviation $\le 0.4$.
- `typical`: Standard distribution; regions with an isolated elevated domain and composite deviation $< 1.5$ are classified as typical to preserve isolated elevation without contradictory low-variation labels.

### Cross-Domain Relationship Labels

- `converging_observations`: Multiple independent evidence domains exhibit notable statistical variation with confirmed spatial convergence in the same physical regions.
- `isolated_observation`: Exactly one independent evidence domain exhibits a notable statistical pattern, while all other independent domains remain within typical distributions. Supporting spatial analysis may describe regional localization.
- `mixed_observations`: Multiple independent evidence domains exhibit statistical observations, but without spatial convergence in the same regions.
- `no_notable_variation`: All evaluated independent domains display uniform, expected distributions.
- `insufficient_evidence`: Fewer than two independent domains were available for evaluation.

### Structured Key Observations

Each generated observation includes a unique deterministic ID (`OBS-META-001`, `OBS-ELA-001`, `OBS-NOISE-001`, `OBS-FREQ-001`, `OBS-SPAT-001`, `OBS-CROSS-001`), supporting numerical metrics, region IDs if applicable, neutral interpretations, and documented limitations.

## Implemented forensic modules

1. Image validation and properties
2. SHA-256 identity fingerprint
3. EXIF / metadata analysis
4. Error Level Analysis (ELA)
5. Noise residual analysis
6. Frequency domain analysis (2D FFT)
7. Regional anomaly analysis
8. Evidence aggregation & synthesis engine (Phase 3)

## Frontend integration

- Contract-first via `/openapi.json`
- `POST /api/v1/analyze` accepts `multipart/form-data` field `file`
- `phase` reports `"phase_3"`
- `assessment.status` reports `"COMPLETE"` with dynamic synthesis summary and limitations
- Forensic results appear in `analyses[]` with `name` set to:
  - `"metadata"`: details in `MetadataDetails`
  - `"ela"`: details in `ELADetails`
  - `"noise"`: details in `NoiseDetails`
  - `"frequency"`: details in `FrequencyDetails`
  - `"regional"`: details in `RegionalAnomalyDetails`
  - `"synthesis"`: details in `SynthesisDetails`
- Visualizations:
  - ELA: `analyses[name=ela].details.difference_image_data_url`
  - Noise: `analyses[name=noise].details.visualization_data_url`
  - Frequency: `analyses[name=frequency].details.visualization_data_url`
  - Regional: `analyses[name=regional].details.visualization_data_url`
- Configure `CORS_ORIGINS` for the frontend developer’s Vite origin
- Do not modify the `frontend/` tree from the backend agent
