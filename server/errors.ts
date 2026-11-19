export class TruthLensError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = 'error') {
    super(message);
    this.name = 'TruthLensError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ValidationFailedError extends TruthLensError {
  constructor(message: string, code = 'validation_error') {
    super(message, 400, code);
    this.name = 'ValidationFailedError';
  }
}

export class PayloadTooLargeError extends TruthLensError {
  constructor(message: string) {
    super(message, 413, 'payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

export function errorBody(code: string, message: string, details?: unknown) {
  const error: { code: string; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return { success: false as const, error };
}
