import { ApiError } from '../shared/validation';
import { TOKEN } from '../shared/protocol';

export const MAX_BODY = 4096;
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: SECURITY_HEADERS });
}
export function failure(error: unknown): Response {
  const known = error instanceof ApiError;
  return json(
    {
      error: known ? error.message : 'Something went wrong. Please try again.',
    },
    known ? error.status : 500,
  );
}
export async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    throw new ApiError(415, 'Send application/json.');
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) {
    throw new ApiError(413, 'Request is too large (maximum 4 KB).');
  }
  // Bound streaming/chunked bodies too, before decoding or parsing.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new ApiError(413, 'Request is too large (maximum 4 KB).');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'Invalid JSON.');
  }
}
export function bearer(request: Request, optional = false): string | null {
  const header = request.headers.get('Authorization');
  if (!header && optional) return null;
  const token = header?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token || !TOKEN.test(token))
    throw new ApiError(401, 'Your saved access is invalid. Please join again.');
  return token;
}
export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
