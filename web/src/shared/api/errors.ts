/** RFC 9457 problem details as sent by the API. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string; code?: string }[];
  [extension: string]: unknown;
}

/** Every failed call surfaces as one of these — UI code switches on `code`, never on message text. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly fieldErrors: Record<string, string>;
  readonly requestId: string | undefined;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail || problem.title || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code ?? 'error';
    this.detail = problem.detail ?? problem.title ?? '';
    this.requestId = problem.requestId;
    this.problem = problem;
    this.fieldErrors = Object.fromEntries((problem.errors ?? []).map((e) => [e.path || '_', e.message]));
  }

  is(...codes: string[]): boolean {
    return codes.includes(this.code);
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function networkError(cause: unknown): ApiError {
  const e = new ApiError(0, { code: 'network_error', title: 'Network error', detail: 'Could not reach the server. Check your connection and try again.' });
  (e as { cause?: unknown }).cause = cause;
  return e;
}

/** User-facing text for any thrown value. */
export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  if (isApiError(e)) {
    const first = Object.values(e.fieldErrors)[0];
    return e.status === 422 && first ? first : e.detail || fallback;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}
