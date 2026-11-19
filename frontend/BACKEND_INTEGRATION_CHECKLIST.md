# TruthLens Backend Integration Checklist

The frontend does not assume a backend contract. Confirm the following before enabling live submissions.

## Required from the backend developer

1. Public API base URL and CORS origin.
2. Submission endpoint for synchronous analysis.
3. Optional separate image, video, audio, and text submission endpoints.
4. HTTP method and accepted `FormData` field names.
5. Confirm media field name: the frontend currently sends `media` and `mediaType`.
6. Confirm text field name: the frontend currently sends `text`.
7. Synchronous response schema for `InvestigationResult`, or the exact JSON field names.
8. Whether analysis is asynchronous.
9. Asynchronous job ID field names and status field names.
10. Status endpoint URL format; for example, `/api/jobs/{jobId}` or a response-provided URL.
11. Status values and terminal states.
12. Status response result location and schema.
13. Health endpoint for accurate connection status.
14. Authentication or API-key requirements.
15. Maximum upload size and supported file limits.
16. Timeout and recommended polling interval.
17. Report download endpoint and report response schema.
18. History/list/delete endpoint contracts, if locally persisted history is not the only source.
19. Expected assessment values if returned by the backend.
20. Module status values and unavailable-module behavior.

## Frontend environment variables

- `VITE_TRUTHLENS_API_URL`
- `VITE_TRUTHLENS_ANALYSIS_PATH`
- `VITE_TRUTHLENS_IMAGE_ANALYSIS_PATH`
- `VITE_TRUTHLENS_VIDEO_ANALYSIS_PATH`
- `VITE_TRUTHLENS_AUDIO_ANALYSIS_PATH`
- `VITE_TRUTHLENS_TEXT_ANALYSIS_PATH`
- `VITE_TRUTHLENS_STATUS_PATH`
- `VITE_TRUTHLENS_HEALTH_PATH`
- `VITE_TRUTHLENS_REQUEST_TIMEOUT_MS`
- `VITE_TRUTHLENS_STATUS_TIMEOUT_MS`
- `VITE_TRUTHLENS_POLL_INTERVAL_MS`

## Frontend behavior already prepared

- Direct synchronous result handling
- FormData media/text submission
- Typed image, video, audio, and text functions
- Job ID/status polling support
- Loading and cancellation controls
- Timeout and AbortError handling
- Configurable health and status endpoints
- Actual-backend-only response normalization
