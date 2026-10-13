import { DurableObject } from 'cloudflare:workers';
import type { Env } from './worker';
import { DEFAULT_DECK, ROOM_ID, TOKEN } from './shared/protocol';
import type { ServerEvent } from './shared/protocol';
import { ApiError, deck, integer, object, text } from './shared/validation';
import { bearer, body, failure, hash, json, randomHex } from './server/http';
import { metadata, toPublicSnapshot } from './server/state';
import type { Member, RoomState, Tombstone } from './server/state';

interface Connection {
  authenticated: boolean;
  memberId: string | null;
  isAdmin: boolean;
  expiresAt: number;
}
interface Bucket {
  start: number;
  count: number;
}
const MAX_MEMBERS = 50;
const MAX_CONNECTIONS = 100;
const AUTH_TIMEOUT = 10_000;

export class RoomObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }
  async create(id: string, adminTokenHash: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('room'))
        throw new ApiError(409, 'Room already exists.');
      const now = Date.now();
      const state: RoomState = {
        id,
        title: 'Planning Poker',
        deck: [...DEFAULT_DECK],
        round: 1,
        revealed: false,
        version: 1,
        adminTokenHash,
        createdAt: now,
        updatedAt: now,
        members: [],
      };
      await this.ctx.storage.put('room', state);
    });
  }
  private async state(): Promise<RoomState> {
    const state = await this.ctx.storage.get<RoomState | Tombstone>('room');
    if (!state || 'deleted' in state)
      throw new ApiError(404, 'This room does not exist or has been deleted.');
    return state;
  }
  private attachment(ws: WebSocket): Connection {
    return ws.deserializeAttachment() as Connection;
  }
  private connected(): Set<string> {
    return new Set(
      this.ctx
        .getWebSockets()
        .filter(
          (ws) =>
            ws.readyState === WebSocket.OPEN &&
            this.attachment(ws).authenticated,
        )
        .map((ws) => this.attachment(ws).memberId)
        .filter((id): id is string => id !== null),
    );
  }
  private snapshot(state: RoomState) {
    return toPublicSnapshot(state, this.connected());
  }
  private send(ws: WebSocket, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      ws.close(1011, 'Reconnect to the room.');
    }
  }
  private broadcast(state: RoomState): void {
    const event: ServerEvent = {
      type: 'snapshot',
      version: state.version,
      room: this.snapshot(state),
    };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN && this.attachment(ws).authenticated)
        this.send(ws, event);
    }
  }
  private async commit(
    state: RoomState,
    onCommitted?: () => void,
  ): Promise<void> {
    state.version++;
    state.updatedAt = Date.now();
    await this.ctx.storage.put('room', state);
    onCommitted?.();
    this.broadcast(state);
  }
  private async removeMember(
    state: RoomState,
    memberId: string,
  ): Promise<void> {
    if (!state.members.some((member) => member.id === memberId)) return;
    state.members = state.members.filter((member) => member.id !== memberId);
    await this.commit(state, () => {
      // Revoke every tab after the removal is durable and before broadcasting.
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = this.attachment(ws);
        if (attachment.memberId === memberId) {
          this.send(ws, { type: 'membership_removed' });
          attachment.authenticated = false;
          ws.serializeAttachment(attachment);
          ws.close(4401, 'Membership removed.');
        }
      }
    });
  }
  private async throttle(actor: string, limit = 60): Promise<void> {
    // Durable, bounded minute buckets: restart/hibernation cannot bypass these limits.
    const now = Date.now();
    const buckets =
      (await this.ctx.storage.get<Record<string, Bucket>>('limits')) ?? {};
    for (const [key, bucket] of Object.entries(buckets))
      if (now - bucket.start >= 60_000) delete buckets[key];
    for (const [key, max] of [
      ['room', 600],
      [actor, limit],
    ] as const) {
      const bucket = buckets[key] ?? { start: now, count: 0 };
      if (bucket.count >= max)
        throw new ApiError(429, 'Too many changes. Please wait a minute.');
      bucket.count++;
      buckets[key] = bucket;
    }
    await this.ctx.storage.put('limits', buckets);
  }
  private async authenticate(
    request: Request,
    state: RoomState,
    admin = false,
  ): Promise<Member | null> {
    const tokenHash = await hash(bearer(request)!);
    if (admin) {
      if (tokenHash !== state.adminTokenHash)
        throw new ApiError(403, 'Only the room admin can do this.');
      return null;
    }
    const member = state.members.find((m) => m.tokenHash === tokenHash);
    if (!member)
      throw new ApiError(
        401,
        'Your saved membership is no longer valid. Please join again.',
      );
    return member;
  }
  private reset(state: RoomState): void {
    state.round++;
    state.revealed = false;
    for (const member of state.members) member.vote = null;
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const state = await this.state();
        const path = new URL(request.url).pathname.replace(
          /^\/api\/rooms\/[a-f0-9]{32}/,
          '',
        );
        if (path === '' && request.method === 'GET') {
          const token = bearer(request, true);
          if (!token) return json(metadata(state));
          const tokenHash = await hash(token);
          if (
            tokenHash !== state.adminTokenHash &&
            !state.members.some((m) => m.tokenHash === tokenHash)
          )
            throw new ApiError(
              401,
              'Your saved access is invalid. Please join again.',
            );
          return json(this.snapshot(state));
        }
        if (path === '/ws' && request.method === 'GET')
          return await this.upgrade(request);
        const actor = await hash(
          bearer(request, true) ??
            `join:${request.headers.get('CF-Connecting-IP') || 'local'}`,
        );
        await this.throttle(actor, path === '/join' ? 30 : 60);
        if (path === '/join' && request.method === 'POST') {
          const input = object(await body(request), ['name']);
          const name = text(input.name, 'Name', 40);
          const token = bearer(request, true);
          let member: Member;
          let memberToken: string | undefined;
          if (token) {
            member = (await this.authenticate(request, state))!;
            member.name = name;
          } else {
            if (state.members.length >= MAX_MEMBERS)
              throw new ApiError(
                409,
                'This room has 50 saved members. Someone must leave before another person can join.',
              );
            memberToken = randomHex(32);
            member = {
              id: randomHex(16),
              tokenHash: await hash(memberToken),
              name,
              vote: null,
              joinedAt: Date.now(),
            };
            state.members.push(member);
          }
          await this.commit(state);
          return json({
            memberId: member.id,
            ...(memberToken ? { memberToken } : {}),
            room: this.snapshot(state),
          });
        }
        if (path === '/vote' && request.method === 'POST') {
          const member = (await this.authenticate(request, state))!;
          const input = object(await body(request), ['vote', 'round']);
          if (integer(input.round, 'Estimation revision') !== state.round)
            throw new ApiError(
              409,
              'The estimation changed. Please choose again.',
            );
          if (state.revealed)
            throw new ApiError(
              409,
              'Voting is locked until the estimation is reset.',
            );
          const vote = text(input.vote, 'Vote', 16);
          if (!state.deck.includes(vote))
            throw new ApiError(400, 'Choose an option from the current deck.');
          if (member.vote !== vote) {
            member.vote = vote;
            await this.commit(state);
          }
          return json(this.snapshot(state));
        }
        if (
          (path === '/reveal' || path === '/admin/reveal') &&
          request.method === 'POST'
        ) {
          const tokenHash = await hash(bearer(request)!);
          if (
            tokenHash !== state.adminTokenHash &&
            !state.members.some((member) => member.tokenHash === tokenHash)
          )
            throw new ApiError(
              401,
              'Join the room before revealing estimates.',
            );
          const input = object(await body(request), ['round']);
          if (integer(input.round, 'Estimation revision') !== state.round)
            throw new ApiError(
              409,
              'The estimation changed. Please try again.',
            );
          if (!state.revealed) {
            state.revealed = true;
            await this.commit(state);
          }
          return json(this.snapshot(state));
        }
        if (path === '/leave' && request.method === 'POST') {
          const member = (await this.authenticate(request, state))!;
          object(await body(request), []);
          await this.removeMember(state, member.id);
          return json({ ok: true });
        }
        if (path.startsWith('/admin/') && request.method === 'POST') {
          await this.authenticate(request, state, true);
          if (path === '/admin/remove-member') {
            const input = object(await body(request), ['memberId']);
            if (
              typeof input.memberId !== 'string' ||
              !ROOM_ID.test(input.memberId)
            )
              throw new ApiError(400, 'Choose a valid member to remove.');
            await this.removeMember(state, input.memberId);
          } else if (path === '/admin/settings') {
            const input = object(await body(request), [
              'title',
              'deck',
              'version',
            ]);
            if (integer(input.version, 'Version') !== state.version)
              throw new ApiError(
                409,
                'The room changed. Review the current settings and try again.',
              );
            const title = text(input.title, 'Title', 80, 'Planning Poker');
            const choices = deck(input.deck);
            const changed =
              JSON.stringify(choices) !== JSON.stringify(state.deck);
            if (changed || title !== state.title) {
              state.title = title;
              state.deck = choices;
              if (changed) this.reset(state);
              await this.commit(state);
            }
          } else if (path === '/admin/reset') {
            const input = object(await body(request), ['round']);
            const round = integer(input.round, 'Estimation revision');
            if (round !== state.round) {
              // Retrying the same reset is harmless. Future rounds are never accepted.
              if (round > state.round)
                throw new ApiError(
                  409,
                  'The estimation changed. Please try again.',
                );
            } else {
              this.reset(state);
              await this.commit(state);
            }
          } else throw new ApiError(404, 'Action not found.');
          return json(this.snapshot(state));
        }
        if (path === '' && request.method === 'DELETE') {
          await this.authenticate(request, state, true);
          object(await body(request), []);
          // Retain only a tombstone: no votes, identities, or authority survive deletion.
          await this.ctx.storage.put('room', {
            deleted: true,
          } satisfies Tombstone);
          await this.ctx.storage.delete('limits');
          await this.ctx.storage.deleteAlarm();
          for (const ws of this.ctx.getWebSockets()) {
            if (this.attachment(ws).authenticated)
              this.send(ws, { type: 'room_deleted' });
            ws.close(4404, 'Room deleted.');
          }
          return json({ ok: true });
        }
        throw new ApiError(404, 'Action not found.');
      } catch (error) {
        return failure(error);
      }
    });
  }
  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      throw new ApiError(426, 'A WebSocket connection is required.');
    await this.throttle(
      `ws:${request.headers.get('CF-Connecting-IP') || 'local'}`,
      30,
    );
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS)
      throw new ApiError(
        429,
        'This room has too many connections. Close unused tabs and try again.',
      );
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authenticated: false,
      memberId: null,
      isAdmin: false,
      expiresAt: Date.now() + AUTH_TIMEOUT,
    } satisfies Connection);
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) await this.ctx.storage.setAlarm(Date.now() + AUTH_TIMEOUT);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (
          typeof message !== 'string' ||
          new TextEncoder().encode(message).byteLength > 1024
        ) {
          ws.close(1009, 'Message too large.');
          return;
        }
        const attachment = this.attachment(ws);
        if (attachment.authenticated) {
          ws.close(1008, 'Use HTTP for actions.');
          return;
        }
        if (Date.now() >= attachment.expiresAt) {
          ws.close(4408, 'Authentication timed out.');
          return;
        }
        const input = object(JSON.parse(message), [
          'type',
          'memberToken',
          'adminToken',
        ]);
        if (input.type !== 'auth')
          throw new ApiError(
            401,
            'Authenticate before receiving room updates.',
          );
        const state = await this.state();
        let member: Member | undefined;
        let isAdmin = false;
        if (input.memberToken !== undefined) {
          if (
            typeof input.memberToken !== 'string' ||
            !TOKEN.test(input.memberToken)
          )
            throw new ApiError(401, 'Invalid membership.');
          const tokenHash = await hash(input.memberToken);
          member = state.members.find((m) => m.tokenHash === tokenHash);
          // A revoked participant identity must not discard valid admin access.
          // Verify both roles independently before deciding whether to reject.
        }
        if (input.adminToken !== undefined) {
          if (
            typeof input.adminToken !== 'string' ||
            !TOKEN.test(input.adminToken)
          )
            throw new ApiError(403, 'Invalid admin access.');
          isAdmin = (await hash(input.adminToken)) === state.adminTokenHash;
        }
        if (!member && !isAdmin)
          throw new ApiError(
            input.memberToken ? 401 : 403,
            input.memberToken
              ? 'Membership removed. Please join again.'
              : 'Admin access is invalid. Please join as a participant.',
          );
        ws.serializeAttachment({
          authenticated: true,
          memberId: member?.id ?? null,
          isAdmin,
          expiresAt: 0,
        } satisfies Connection);
        this.send(ws, {
          type: 'authenticated',
          memberId: member?.id ?? null,
          isAdmin,
        });
        await this.commit(state);
      } catch (error) {
        this.send(ws, {
          type: 'error',
          message:
            error instanceof ApiError
              ? error.message
              : 'Unable to authenticate. Please reconnect.',
        });
        ws.close(
          error instanceof ApiError && error.status === 403
            ? 4403
            : error instanceof ApiError && error.status === 404
              ? 4404
              : 4401,
          'Authentication failed.',
        );
      }
    });
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const attachment = this.attachment(ws);
      // Empty/abnormal peer close codes are reserved and cannot be sent back.
      ws.close(
        code === 1005 || code === 1006 ? 1000 : code,
        'Connection closed.',
      );
      if (!attachment.authenticated) return;
      attachment.authenticated = false;
      ws.serializeAttachment(attachment);
      try {
        await this.commit(await this.state());
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    });
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
  async alarm(): Promise<void> {
    // This alarm only closes unauthenticated handshakes. Rooms never expire.
    await this.ctx.blockConcurrencyWhile(async () => {
      let next = Infinity;
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = this.attachment(ws);
        if (attachment.authenticated || ws.readyState !== WebSocket.OPEN)
          continue;
        if (attachment.expiresAt <= Date.now())
          ws.close(4408, 'Authentication timed out.');
        else next = Math.min(next, attachment.expiresAt);
      }
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    });
  }
}
