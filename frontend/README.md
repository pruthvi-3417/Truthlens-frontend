# TruthLens Frontend

A responsive React, TypeScript, and Vite frontend for explainable multimodal digital-forensics investigations.

## Run

```bash
npm install
npm run dev
```

## Validation

```bash
npm run lint
npm run build
npm run preview
```

## Backend configuration

Copy `.env.example` to `.env.local`, then configure:

- `VITE_TRUTHLENS_API_URL`: owned TruthLens backend base URL
- `VITE_TRUTHLENS_ANALYSIS_PATH`: analysis submit endpoint; defaults to `/api/analyze`
- `VITE_TRUTHLENS_REPORT_PATH`: reserved report endpoint

No backend endpoint is contacted unless configured, and no third-party AI service receives uploaded media.

## Structure

- `src/components/layout`: reusable application shell
- `src/components/ui`: reusable interface components
- `src/pages`: routed pages
- `src/services`: backend adapter and normalization
- `src/types`: strict forensic result contracts
