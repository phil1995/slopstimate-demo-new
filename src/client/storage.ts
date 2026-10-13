import { TOKEN } from '../shared/protocol';
export type SavedIdentity = {
  adminToken?: string;
  memberToken?: string;
  name?: string;
};
const key = (id: string) => `slopstimate:room:${id}`;
export function readIdentity(id: string): SavedIdentity {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(id)) ?? '{}');
    if (!stored || typeof stored !== 'object') return {};
    const value = stored as Record<string, unknown>;
    return {
      ...(typeof value.adminToken === 'string' && TOKEN.test(value.adminToken)
        ? { adminToken: value.adminToken }
        : {}),
      ...(typeof value.memberToken === 'string' && TOKEN.test(value.memberToken)
        ? { memberToken: value.memberToken }
        : {}),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
    };
  } catch {
    return {};
  }
}
export function saveIdentity(id: string, patch: Partial<SavedIdentity>): void {
  const next = { ...readIdentity(id), ...patch };
  try {
    localStorage.setItem(key(id), JSON.stringify(next));
  } catch {
    throw new Error(
      'Browser storage is unavailable. Enable local storage to keep your room access.',
    );
  }
}
export function identityKey(id: string): string {
  return key(id);
}
