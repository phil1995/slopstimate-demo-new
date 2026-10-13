export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  data?: unknown,
  token?: string,
  method = data === undefined ? 'GET' : 'POST',
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      'Could not reach the room. Check your connection and try again.',
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw new HttpError(
      response.status,
      result.error || 'Unable to complete this action.',
    );
  return result as T;
}
