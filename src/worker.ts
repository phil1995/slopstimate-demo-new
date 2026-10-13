import type { RoomObject } from './room-object';
import { ROOM_ID } from './shared/protocol';
import { ApiError, object } from './shared/validation';
import { body, failure, hash, json, randomHex } from './server/http';
export { RoomObject } from './room-object';
export interface Env {
  ROOM: DurableObjectNamespace<RoomObject>;
  ASSETS: Fetcher;
  CREATE_LIMIT: RateLimit;
  REQUEST_LIMIT: RateLimit;
  // Optional comma-separated exact origins for a separately hosted frontend.
  ALLOWED_ORIGINS?: string;
}
function checkOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('Origin');
  const allowed = [
    new URL(request.url).origin,
    ...(env.ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ];
  if (!origin || !allowed.includes(origin))
    throw new ApiError(
      403,
      'Open the app on its own website to perform this action.',
    );
}
export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (request.url.length > 2048)
        throw new ApiError(414, 'URL is too long.');
      if (url.search)
        throw new ApiError(400, 'API URLs do not accept query parameters.');
      const upgrading =
        request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      if (request.method !== 'GET' || upgrading) checkOrigin(request, env);
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const key = await hash(`${url.hostname}:${ip}`);
      if (!(await env.REQUEST_LIMIT.limit({ key })).success)
        throw new ApiError(429, 'Too many requests. Please wait a minute.');
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        if (!(await env.CREATE_LIMIT.limit({ key })).success)
          throw new ApiError(
            429,
            'Room creation limit reached. Please wait a minute.',
          );
        object(await body(request), []);
        const roomId = randomHex(16);
        const adminToken = randomHex(32);
        const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
        await stub.create(roomId, await hash(adminToken));
        return json({ roomId, adminToken }, 201);
      }
      const route = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})(\/.*)?$/);
      if (!route || !ROOM_ID.test(route[1]))
        throw new ApiError(404, 'Room not found.');
      // Buffer and bound browser bodies before entering the room's serialized
      // mutation queue, so a slow upload cannot hold its other clients hostage.
      let forwarded = request;
      if (request.method !== 'GET') {
        const input = await body(request);
        const headers = new Headers(request.headers);
        headers.delete('Content-Length');
        forwarded = new Request(request, {
          headers,
          body: JSON.stringify(input),
        });
      }
      return await env.ROOM.get(env.ROOM.idFromName(route[1])).fetch(forwarded);
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
