// Shared HTTP plumbing for the forge's surfaces: one request shape, one
// response shape, JSON helpers and the request-id header every reply carries.

import type { IncomingMessage } from 'node:http';

export interface HttpRequest {
  method: string;
  /** The path, split on '/' with each segment percent-decoded. */
  pathname: string;
  /** The raw query string, parsed. */
  query: URLSearchParams;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** The raw request body (empty for GET). */
  body: Buffer;
  /** The origin the client dialled, from the Host header (for Link headers). */
  origin: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

let requestCounter = 0;

/** The next X-GitHub-Request-Id value (non-empty, unique per request). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${process.pid.toString(36)}-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = `${JSON.stringify(body)}\n`;
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(text, 'utf8'), headers };
}

export function jsonError(status: number, message: string, headers: Record<string, string> = {}): HttpResponse {
  return jsonResponse(status, { message }, headers);
}

/** Parse a request body as JSON: the value, or null with `error` set when it is not JSON. */
export function parseJsonBody(body: Buffer): { value: unknown; error: boolean } {
  const text = body.toString('utf8').trim();
  if (text === '') return { value: undefined, error: false };
  try {
    return { value: JSON.parse(text) as unknown, error: false };
  } catch {
    return { value: undefined, error: true };
  }
}

/** Read a request's whole body, capped at `maxBytes` (0 = unlimited). */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

/** The bearer token on the request, or null. */
export function bearerToken(req: HttpRequest): string | null {
  const header = headerOf(req.headers, 'authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

/** The token the trial gives this process (MAKEFUN_SHOP_TOKEN), or null locally. */
export function envToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

/**
 * Whether the request is authenticated. When MAKEFUN_SHOP_TOKEN is set, the
 * bearer must equal it; when it is unset (local practice), any non-empty
 * bearer counts, so a local token still works and a missing one is still 401.
 */
export function isAuthenticated(req: HttpRequest): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = envToken();
  if (expected === null) return true;
  return token === expected;
}
