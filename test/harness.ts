import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { WebSocket, MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type {
  CreateResponse,
  JoinResponse,
  RoomSnapshot,
  ServerEvent,
} from '../src/shared/protocol';

export class Harness {
  mf!: Miniflare;
  directory = '';
  options!: MiniflareOptions;
  private ip = 0;
  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'slopstimate-test-'));
    const scriptPath = join(this.directory, 'worker.mjs');
    await build({
      stdin: {
        contents: `import worker from './src/worker'; export { RoomObject } from './src/worker'; export default { async fetch(request, env, ctx) { const id = new URL(request.url).pathname.match(/^\\/__test\\/create\\/([a-f0-9]{32})$/)?.[1]; if (id) { try { await env.ROOM.get(env.ROOM.idFromName(id)).create(id, 'f'.repeat(64)); return new Response('Created', {status: 201}); } catch { return new Response('Already exists', {status: 409}); } } return worker.fetch(request, env, ctx); } };`,
        resolveDir: resolve('.'),
      },
      outfile: scriptPath,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      external: ['cloudflare:workers'],
    });
    this.options = convertV4MiniflareOptions({
      name: 'slopstimate-test',
      modules: true,
      script: await readFile(scriptPath, 'utf8'),
      compatibilityDate: '2026-10-13',
      durableObjects: { ROOM: { className: 'RoomObject', useSQLite: true } },
      durableObjectsPersist: join(this.directory, 'storage'),
      ratelimits: {
        CREATE_LIMIT: { namespace_id: '1', simple: { limit: 10, period: 60 } },
        REQUEST_LIMIT: {
          namespace_id: '2',
          simple: { limit: 240, period: 60 },
        },
      },
    });
    this.options.resourcePersistencePath = join(this.directory, 'storage');
    this.options.unsafeInspectDurableObjects = true;
    this.mf = new Miniflare(this.options);
    await this.mf.ready;
  }
  async restart() {
    await this.mf.dispose();
    this.mf = new Miniflare(this.options);
    await this.mf.ready;
  }
  async stop() {
    await this.mf?.dispose();
    await rm(this.directory, { recursive: true, force: true });
  }
  async request(
    path: string,
    data?: unknown,
    token?: string,
    method = data === undefined ? 'GET' : 'POST',
    ip = '192.0.2.1',
  ) {
    return this.mf.dispatchFetch(`https://poker.test${path}`, {
      method,
      headers: {
        Origin: 'https://poker.test',
        'CF-Connecting-IP': ip,
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  }
  async room() {
    const ip = `192.0.2.${++this.ip}`;
    const response = await this.request(
      '/api/rooms',
      {},
      undefined,
      'POST',
      ip,
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateResponse;
    return { ...created, path: `/api/rooms/${created.roomId}`, ip };
  }
  async join(path: string, name = 'Alex', token?: string) {
    const response = await this.request(`${path}/join`, { name }, token);
    expect(response.status).toBe(200);
    return (await response.json()) as JoinResponse;
  }
  async snapshot(path: string, token: string) {
    return (await (
      await this.request(path, undefined, token)
    ).json()) as RoomSnapshot;
  }
  async socket(
    path: string,
    auth?: { memberToken?: string; adminToken?: string },
  ) {
    const response = await this.mf.dispatchFetch(
      `https://poker.test${path}/ws`,
      { headers: { Upgrade: 'websocket', Origin: 'https://poker.test' } },
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const events: ServerEvent[] = [];
    const messages: string[] = [];
    ws.addEventListener('message', (event) => {
      messages.push(String(event.data));
      if (event.data !== 'pong') events.push(JSON.parse(String(event.data)));
    });
    ws.addEventListener('close', () => {
      if (ws.readyState !== 3) ws.close(1000);
    });
    ws.accept();
    if (auth) {
      ws.send(JSON.stringify({ type: 'auth', ...auth }));
      await waitUntil(() => events.some((e) => e.type === 'snapshot'));
    }
    return { ws, events, messages };
  }
}
export async function waitUntil(predicate: () => boolean) {
  await expect.poll(predicate, { timeout: 5000, interval: 20 }).toBe(true);
}
export async function close(ws: WebSocket) {
  ws.close(1000, 'Test complete');
}
export function assertPrivate(snapshot: RoomSnapshot) {
  expect(snapshot.revealed).toBe(false);
  for (const member of snapshot.members) {
    expect(member).not.toHaveProperty('vote');
    expect(member).not.toHaveProperty('tokenHash');
  }
  expect(snapshot).not.toHaveProperty('adminTokenHash');
}
