export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function object(
  value: unknown,
  allowed: string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'Expected a JSON object.');
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, 'Unexpected request fields.');
  }
  return result;
}
export function text(
  value: unknown,
  label: string,
  max: number,
  fallback?: string,
): string {
  if (typeof value !== 'string')
    throw new ApiError(400, `${label} must be text.`);
  const result = value.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(result)) {
    throw new ApiError(400, `${label} cannot contain control characters.`);
  }
  if ([...result].length > max || (!result && fallback === undefined)) {
    throw new ApiError(400, `${label} must be 1–${max} characters.`);
  }
  return result || fallback!;
}
export function deck(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw new ApiError(400, 'Choose 2–20 deck options.');
  }
  const result = value.map((item) => text(item, 'Each deck option', 16));
  if (new Set(result).size !== result.length)
    throw new ApiError(400, 'Deck options must be unique.');
  return result;
}
export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(400, `${label} must be a positive integer.`);
  }
  return value as number;
}
