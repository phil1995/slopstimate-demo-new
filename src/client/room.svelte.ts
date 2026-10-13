import type {
  JoinResponse,
  RoomMetadata,
  RoomSnapshot,
  ServerEvent,
} from '../shared/protocol';
import { api, HttpError } from './api';
import { identityKey, readIdentity, saveIdentity } from './storage';

export class RoomController {
  room = $state<RoomSnapshot | null>(null);
  loading = $state(true);
  notFound = $state(false);
  error = $state('');
  connection = $state<
    'connecting' | 'connected' | 'reconnecting' | 'offline' | 'join'
  >('join');
  isAdmin = $state(false);
  memberId = $state<string | null>(null);
  hasMembership = $state(false);
  name = $state('');
  selected = $state<string | null>(null);
  busy = $state(false);
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failures = 0;
  private lastPong = 0;
  constructor(public readonly id: string) {}
  private get path() {
    return `/api/rooms/${this.id}`;
  }
  private apply(room: RoomSnapshot) {
    if (this.room && room.version < this.room.version) return;
    if (this.room && room.round !== this.room.round) this.selected = null;
    this.room = room;
  }
  async start() {
    this.loading = true;
    try {
      const room = await api<RoomMetadata>(this.path);
      this.apply({ ...room, members: [] });
      const saved = readIdentity(this.id);
      this.name = saved.name ?? '';
      this.hasMembership = !!saved.memberToken;
      if (saved.memberToken || saved.adminToken) this.connect();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.loading = false;
    }
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
    window.addEventListener('storage', this.storage);
  }
  private handleError(error: unknown) {
    if (error instanceof HttpError && error.status === 404) {
      this.notFound = true;
      this.disconnect();
    } else
      this.error = error instanceof Error ? error.message : 'Please try again.';
  }
  private online = () => {
    if (this.connection !== 'connected') this.connect();
  };
  private offline = () => {
    this.disconnect();
    this.connection = 'offline';
  };
  private storage = (event: StorageEvent) => {
    if (event.key !== identityKey(this.id) && event.key !== null) return;
    const saved = readIdentity(this.id);
    this.name = saved.name ?? '';
    this.hasMembership = !!saved.memberToken;
    this.memberId = null;
    this.isAdmin = false;
    this.selected = null;
    this.connect();
  };
  private disconnect() {
    clearTimeout(this.retry);
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
  connect = () => {
    this.disconnect();
    if (this.stopped || this.notFound) return;
    const saved = readIdentity(this.id);
    if (!saved.memberToken && !saved.adminToken) {
      this.connection = 'join';
      return;
    }
    if (!navigator.onLine) {
      this.connection = 'offline';
      return;
    }
    this.connection = this.failures ? 'reconnecting' : 'connecting';
    const url = new URL(`${this.path}/ws`, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      ws.send(
        JSON.stringify({
          type: 'auth',
          ...(saved.memberToken ? { memberToken: saved.memberToken } : {}),
          ...(saved.adminToken ? { adminToken: saved.adminToken } : {}),
        }),
      );
      this.handshake = setTimeout(() => ws.close(), 12_000);
    };
    ws.onmessage = (message) => {
      if (ws !== this.ws) return;
      if (message.data === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === 'authenticated') {
        clearTimeout(this.handshake);
        this.memberId = event.memberId;
        this.isAdmin = event.isAdmin;
        this.hasMembership = !!event.memberId;
        this.connection = 'connected';
        this.failures = 0;
        this.error = '';
        if (saved.memberToken && !event.memberId)
          saveIdentity(this.id, { memberToken: undefined });
        if (saved.adminToken && !event.isAdmin)
          saveIdentity(this.id, { adminToken: undefined });
        this.lastPong = Date.now();
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastPong > 60_000) {
            ws.close();
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 25_000);
      } else if (event.type === 'snapshot') this.apply(event.room);
      else if (event.type === 'room_deleted') {
        this.notFound = true;
        this.disconnect();
      } else if (event.type === 'membership_removed') {
        saveIdentity(this.id, { memberToken: undefined });
        this.hasMembership = false;
        this.memberId = null;
        this.selected = null;
        this.error = 'Your membership was removed. You can join again.';
        this.connect();
      } else if (event.type === 'error') this.error = event.message;
    };
    ws.onclose = (event) => {
      clearTimeout(this.handshake);
      clearInterval(this.heartbeat);
      if (this.stopped || this.notFound || ws !== this.ws) return;
      if (event.code === 4404) {
        this.notFound = true;
        return;
      }
      if (event.code === 4401) {
        saveIdentity(this.id, { memberToken: undefined });
        this.memberId = null;
        this.hasMembership = false;
        // Keep the independent admin secret when a membership was revoked.
        this.isAdmin = false;
        this.connection = 'join';
        if (readIdentity(this.id).adminToken)
          this.retry = setTimeout(this.connect, 500);
        return;
      }
      if (event.code === 4403) {
        saveIdentity(this.id, { adminToken: undefined });
        this.isAdmin = false;
        this.connection = 'join';
        return;
      }
      this.connection = navigator.onLine ? 'reconnecting' : 'offline';
      this.failures++;
      this.retry = setTimeout(
        this.connect,
        Math.min(15_000, 500 * 2 ** Math.min(this.failures, 5)) +
          Math.random() * 300,
      );
    };
  };
  private async action<T>(run: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      return await run();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }
  async join(name: string): Promise<boolean> {
    const result = await this.action(async () => {
      const saved = readIdentity(this.id);
      const result = await api<JoinResponse>(
        `${this.path}/join`,
        { name },
        saved.memberToken,
      );
      saveIdentity(this.id, {
        memberToken: result.memberToken ?? saved.memberToken,
        name: name.trim(),
      });
      this.name = name.trim();
      this.hasMembership = true;
      this.memberId = result.memberId;
      this.apply(result.room);
      this.connect();
      return true;
    });
    return result ?? false;
  }
  async vote(vote: string) {
    const round = this.room?.round;
    if (!round || !this.memberId || this.connection !== 'connected') return;
    await this.action(async () => {
      const room = await api<RoomSnapshot>(
        `${this.path}/vote`,
        { vote, round },
        readIdentity(this.id).memberToken,
      );
      this.apply(room);
      if (this.room?.round === round && !this.room.revealed)
        this.selected = vote;
    });
  }
  async reveal(): Promise<boolean> {
    if (
      !this.room ||
      (!this.hasMembership && !this.isAdmin) ||
      this.connection !== 'connected'
    )
      return false;
    const round = this.room.round;
    const saved = readIdentity(this.id);
    const result = await this.action(async () => {
      this.apply(
        await api<RoomSnapshot>(
          `${this.path}/reveal`,
          { round },
          this.hasMembership ? saved.memberToken : saved.adminToken,
        ),
      );
      return true;
    });
    return result ?? false;
  }
  async admin(
    action: 'reset' | 'settings',
    settings?: { title: string; deck: string[] },
  ): Promise<boolean> {
    if (!this.room || !this.isAdmin || this.connection !== 'connected')
      return false;
    const data =
      action === 'settings'
        ? { ...settings, version: this.room.version }
        : { round: this.room.round };
    const result = await this.action(async () => {
      this.apply(
        await api<RoomSnapshot>(
          `${this.path}/admin/${action}`,
          data,
          readIdentity(this.id).adminToken,
        ),
      );
      return true;
    });
    return result ?? false;
  }
  async removeMember(memberId: string): Promise<boolean> {
    if (!this.isAdmin || this.connection !== 'connected') return false;
    const result = await this.action(async () => {
      this.apply(
        await api<RoomSnapshot>(
          `${this.path}/admin/remove-member`,
          { memberId },
          readIdentity(this.id).adminToken,
        ),
      );
      return true;
    });
    return result ?? false;
  }
  async leave(): Promise<boolean> {
    const result = await this.action(async () => {
      await api(`${this.path}/leave`, {}, readIdentity(this.id).memberToken);
      saveIdentity(this.id, { memberToken: undefined, name: undefined });
      this.hasMembership = false;
      this.memberId = null;
      this.name = '';
      this.selected = null;
      this.connect();
      return true;
    });
    return result ?? false;
  }
  async delete(): Promise<boolean> {
    const result = await this.action(async () => {
      await api(this.path, {}, readIdentity(this.id).adminToken, 'DELETE');
      saveIdentity(this.id, {
        memberToken: undefined,
        adminToken: undefined,
        name: undefined,
      });
      this.notFound = true;
      this.disconnect();
      return true;
    });
    return result ?? false;
  }
  destroy() {
    this.stopped = true;
    this.disconnect();
    window.removeEventListener('online', this.online);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('storage', this.storage);
  }
}
