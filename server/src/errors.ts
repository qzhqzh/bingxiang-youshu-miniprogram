export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  | 'HOUSEHOLD_FORBIDDEN'
  | 'MEMBERSHIP_CHANGED'
  | 'VERSION_CONFLICT'
  | 'INVENTORY_CONFLICT'
  | 'MUTATION_REJECTED'
  | 'FULL_RESYNC_REQUIRED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function assertApi(condition: unknown, code: ApiErrorCode, message: string, statusCode = 400, details?: unknown): asserts condition {
  if (!condition) throw new ApiError(code, message, statusCode, details);
}
