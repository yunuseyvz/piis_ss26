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

export function hashSourceClient(source: string): string {
  // Simple djb2-style hash used to create a stable cell identity for XP tracking.
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) & 0xffffffff;
  }
  return `explain-${(hash >>> 0).toString(16)}`;
}
