import { ServerConnection } from '@jupyterlab/services';

function buildUrl(path: string): string {
  const settings = ServerConnection.makeSettings();
  return new URL(path.replace(/^\//, ''), settings.baseUrl).toString();
}

async function readError(response: Response): Promise<{ message: string; kind: string }> {
  try {
    const payload = (await response.json()) as {
      message?: string;
      reason?: string;
      errorKind?: string;
    };
    const message =
      payload.reason ?? payload.message ?? `Request failed with ${response.status}`;
    const kind = payload.errorKind ?? 'http';
    return { message, kind };
  } catch {
    return { message: `Request failed with ${response.status}`, kind: 'http' };
  }
}

export class FlowquestApiError extends Error {
  readonly kind: string;
  readonly status: number;

  constructor(message: string, kind: string, status: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const headers = new Headers(init.headers ?? undefined);
  if (init.method !== 'GET' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await ServerConnection.makeRequest(
    buildUrl(path),
    { ...init, headers },
    settings
  );
  if (!response.ok) {
    const { message, kind } = await readError(response);
    throw new FlowquestApiError(message, kind, response.status);
  }
  return response.json() as Promise<T>;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Per-notebook prefix for idempotency award keys, mirroring the backend's
 * `handlers._notebook_ns` (`"<notebookPath>::"`).
 *
 * XP pools globally, but a mission / quiz / reflection is earnable once *per
 * notebook*. The backend namespaces award keys with this prefix; the frontend
 * must use the same prefix when it checks whether something is already
 * claimed, or the comparison silently never matches.
 */
export function notebookAwardPrefix(notebookPath: string | null | undefined): string {
  const path = (notebookPath ?? '').trim();
  return path ? `${path}::` : '';
}

export function clipText(value: string, limit = 1200): string {
  const normalized = value.replace(/\s+$/g, '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}
