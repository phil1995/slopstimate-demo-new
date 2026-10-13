# Planning Poker — Implementation Specification

**Status:** Ready for implementation  
**Target:** Public MIT-licensed GitHub repository, deployable to a user's own Cloudflare account  
**Scope:** Lightweight, real-time story-point voting for recurring teams; no accounts, history, or subscription

## 1. Product overview

Build a minimal Planning Poker (story-estimation) web application. One person creates a room and becomes its administrator. Colleagues open a shared URL, enter a display name, and vote using a configurable set of story-point options. Votes remain hidden until the admin reveals them. The admin may reset the round or change settings. The **same room and admin identity can be reused every week** without signing in again.

This is intended to be simple enough for a public, self-hostable GitHub project with one-click deployment onto **Cloudflare Workers Free**, subject to its then-current usage limits and account eligibility. No separately provisioned database, OAuth provider, third-party real-time service, or paid plan should be necessary.

### Explicit decisions

- Rooms are **permanent by default**: no TTL, expiry alarm, scheduled deletion, or inactivity deletion.
- Admin authority is an unguessable bearer token generated at room creation and kept in the creating browser's `localStorage`.
- If the admin clears storage, loses the device, or loses the token, **there is no recovery mechanism**; create a new room. Existing participants cannot promote themselves.
- No admin login, password, email, invitation service, or recovery link.
- Participants are anonymous and identified by a randomly generated browser-local participant token. They can rejoin a room by its URL.
- No history: a reset discards the previous round's votes. No stories, archives, reports, or analytics in MVP.
- Admin may explicitly delete a room; deletion is irreversible at the application level.
- One deployable Cloudflare Worker serves the frontend, API and WebSocket upgrade handling; a SQLite-backed Durable Object owns each room.

## 2. User stories and acceptance criteria

### Create and revisit

1. Landing page offers **Create room** and a brief explanation.
2. Clicking creates a server-side room with a cryptographically random opaque identifier and an admin secret. Use `crypto.getRandomValues` / Web Crypto, not `Math.random`.
3. The browser saves the admin token in `localStorage`, namespaced by room ID, **before** navigating to `/r/:roomId`.
4. The room URL can be copied and shared; it **must not** contain the admin token.
5. Revisiting the same URL days or weeks later from the same browser restores admin controls, without a login.
6. Revisiting without the stored admin token gives participant-level access only. Display an unobtrusive explanation that lost admin access cannot be recovered.
7. Unknown or deleted room IDs show a friendly Not Found view; visiting one must not create it.

### Participants

1. A participant enters a display name (trimmed, 1–40 characters) and joins the room.
2. Generate a participant token and save it locally, scoped to that room. Reuse it on reconnect or later visits.
3. A participant can change their display name; the server enforces max length and sanitizes data for display.
4. The roster displays joined participants and each person's `voted`/`not voted` status, never their numeric choice before reveal.
5. Multiple tabs using the same participant token count as **one** participant. Reconnects must not create duplicates.
6. A participant's presence may be marked offline when all of their sockets disconnect, but their membership may remain across weeks. The UI should distinguish **saved members** and **currently connected** people or filter to connected participants for the active meeting.
7. Include a simple **Leave room / Forget me on this device** action; if the participant deletes their own membership, invalidate the token.

### Voting

1. Default deck: `0, 1, 2, 3, 5, 8, 13, 21, ?, ☕` (editable by admin; choices represented as strings).
2. A participant can select or change a vote any time before reveal; selecting another option replaces the previous vote.
3. All clients see that a participant has voted, but **never receive the vote value before reveal**, including in join snapshots, network traffic, browser markup, API responses, or socket payloads.
4. The admin clicks **Reveal**, and all clients immediately receive the complete vote values for that round.
5. Once revealed, voting is locked for that round. Admin clicks **Reset round** to clear every vote, set `revealed=false`, increment the `round` number, and notify connected clients.
6. Repeated reveal/reset requests should be safe and predictable; old/out-of-order messages cannot restore previous round votes.
7. Users who reconnect after a reveal see the current revealed values; after a reset they see no previous votes.
8. No vote history is written, retained, or displayed.

### Admin controls

- Update room title (optional, default `Planning Poker`).
- Configure deck options: 2–20 unique, nonempty items, each no more than 16 characters. Offer defaults for Fibonacci and T-shirt sizes.
- Reveal results, reset round, and delete room with confirmation.
- Deck changes are allowed by admin. **Changing deck resets the current round** to prevent votes against obsolete options.
- Every privileged action is verified on the server using the admin token, not by a client-side `isAdmin` boolean.
- Room settings persist between weekly meetings.

### Visual and accessibility expectations

- Mobile-first responsive layout, comfortable on laptop and phone.
- Room header: name, share link/button, connection status.
- Voting cards large enough to tap; show selected state and keyboard focus.
- Participant roster and clear voting progress, e.g. `4 of 6 connected participants voted`.
- Reveal screen shows names and estimates; optional tally/average for numeric choices only (exclude `?` and `☕`), labeled clearly.
- Visible loading, reconnecting, offline, and error states. Keyboard accessible controls; accessible labels; no color-only feedback.
- Never place admin token in page source, app logs, analytics, error reports, or clipboard-share URL.

## 3. Non-goals

- User registration, SSO, organization accounts, or admin recovery.
- Multiple admins, ownership transfers, moderation, invitations, or access controls beyond possession of the room URL.
- Stories/issues, integration with Jira/Linear, retrospective history, or statistics across rounds.
- Public directory, search, discovery, push notifications, automatic expiration, cron cleanup, advertising, or payment.
- End-to-end encryption; the server is trusted to hold unrevealed votes.

## 4. Architecture

```text
Browser (Svelte + Vite SPA)
    | HTTPS  /api/*
    | WebSocket /api/rooms/:id/ws
    v
Cloudflare Worker (one deployment)
    | validates route, limits payloads, handles create
    | routes room operations by room ID
    v
Durable Object namespace: ROOM
    | one SQLite-backed Durable Object per room
    | authoritative admin token hash and member token hashes
    | room settings, current round and current votes
    | WebSocket hibernation API and broadcasts
    v
Built-in per-object durable storage (no D1/KV required)
```

**Frontend:** Vite + Svelte + TypeScript, client-side routing or a small URL-route parser. SSR is not needed.  
**Backend:** TypeScript Cloudflare Worker.  
**Realtime:** Durable Object WebSockets using WebSocket hibernation APIs.  
**Storage:** SQLite-backed Durable Object storage using its key-value storage API or SQL API. It is *technically durable storage*, but it does not require a standalone database product.  
**Deployment:** Wrangler and Cloudflare Workers Static Assets, one repository and one deployment.

Do not use a process-global `Map` as the source of truth. Durable Object instances can be evicted, restarted, and hibernated: rebuild state from durable storage and websocket attachments. Persist the current state after each mutation, not just on socket close.

### Room lifecycle

A room is created only by the create endpoint. Its deterministic Durable Object instance is then addressed by the opaque room ID. Do **not** treat every object ID as an existing room: Durable Objects may be initialized on first access. The persisted `roomExists`/initialized marker is authoritative.

No automatic expiry is implemented. Objects may hibernate or restart without losing committed state. The session remains accessible until explicit admin deletion (or external account/deployment/storage loss). No uptime or indefinite storage guarantee is implied by the product.

## 5. Data model

An example persisted model (storage layout may be normalized into separate keys/SQL tables):

```ts
type Room = {
  id: string;
  title: string;
  adminTokenHash: string; // SHA-256 of high-entropy admin secret
  deck: string[];
  round: number;
  revealed: boolean;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
};

type Member = {
  id: string;
  tokenHash: string; // hashed random member secret
  name: string;
  vote: string | null; // current round only; PRIVATE before reveal
  joinedAt: number;
};
```

Use cryptographically random 128+ bit room IDs and 256-bit admin/member secrets. Compare secrets by hashing and matching stored hashes, and never persist raw tokens. One member can have multiple active WebSocket connections. Presence is derived from connected sockets rather than persisted as a definitive online status.

**Consistency:** Each room's mutations are serialized through its single Durable Object. Ensure votes and the round number are persisted atomically as necessary; persist reset/deletion safely and broadcast only committed state. Attach only non-sensitive connection metadata needed for hibernation/recovery (role/member ID and any verified auth context), not plaintext secrets.

## 6. API and realtime protocol

These routes are illustrative but should be implemented consistently, using typed request/response schemas and runtime validation.

| Route | Purpose | Authentication |
|---|---|---|
| `POST /api/rooms` | Create room; respond with `roomId`, `adminToken` once | None; rate limited |
| `GET /api/rooms/:id` | Public room snapshot (redacted until reveal) | None |
| `GET /api/rooms/:id/ws` | WebSocket upgrade and live events | Participant/admin token supplied securely at handshake |
| `POST /api/rooms/:id/join` | Create or resume participant identity | Existing participant token optional |
| `POST /api/rooms/:id/admin/settings` | Change title/deck | Admin |
| `POST /api/rooms/:id/admin/reveal` | Reveal votes | Admin |
| `POST /api/rooms/:id/admin/reset` | Reset votes and increment round | Admin |
| `DELETE /api/rooms/:id` | Mark deleted, clear persisted member/vote data | Admin |

Recommended: keep mutations on HTTP endpoints and push state changes by WebSocket. Either HTTP `Authorization: Bearer <token>` (for privileged/membership calls) or validated WebSocket `auth` as the first message. **Browser WebSocket constructors cannot set arbitrary Authorization headers**; never place bearer tokens in URL query strings. If using a first-message auth handshake, reject unauthenticated action messages, limit handshake time and message size, and avoid broadcasting state until authentication is complete. Since rooms are URL-shareable, a non-member may only receive sanitized public room metadata until authenticated.

Event envelope:

```ts
type ServerEvent =
  | { type: 'snapshot'; version: number; room: PublicRoomSnapshot }
  | { type: 'member_update'; version: number; members: PublicMember[] }
  | { type: 'vote_status'; version: number; memberId: string; voted: boolean }
  | { type: 'revealed'; version: number; round: number; votes: { memberId: string; vote: string }[] }
  | { type: 'round_reset'; version: number; round: number }
  | { type: 'settings_changed'; version: number; deck: string[]; title: string }
  | { type: 'room_deleted' };
```

`PublicRoomSnapshot` includes room title/deck/round/revealed, safe roster and connection status. **Only include actual `vote` values when `revealed === true`.** Add monotonic `version`/`round` identifiers to prevent stale/out-of-order UI updates. On reconnect, fetch an authoritative snapshot and reconcile.

Consider implementing a single server-side serializer, `toPublicSnapshot(state)`, used by both HTTP and WebSocket outputs, with explicit tests that votes never leak before reveal.

## 7. Security and abuse prevention

This will be deployed publicly, so implement basic defenses even though it is intentionally small:

- High-entropy room IDs; no listing or discovery of rooms.
- Authenticate every admin mutation server-side. Room URL **does not** confer admin privileges.
- Store only hashes of admin and participant tokens; avoid logs of raw tokens.
- Store tokens in `localStorage` with room-scoped keys. This is a deliberate convenience/security tradeoff; prevent XSS with safe templating, CSP, no unsafe HTML, and careful dependency management.
- `Authorization` header for HTTP; never embed admin token in URL, referer, or shared links.
- Verify `Origin` on WebSocket upgrades and state-changing browser requests; explicit allowed-origin rules for custom domains and `workers.dev` domains. CORS is not an authentication substitute.
- Rate limit room creation, join, vote changes, and repeated mutations (per-IP where appropriate, per-room/member within the Durable Object). Use platform-available rate limiting or lightweight application limits; do not require paid add-ons.
- Cap concurrent connections, persisted members (e.g. 50 per room), name lengths, deck size, URL sizes and WebSocket frame sizes. Return actionable errors.
- Escape/display user content as text, not HTML; set restrictive CSP and standard security headers.
- Deletion authorization is checked before destructive writes; deleted rooms should return 404/410 and not resurrect accidentally.
- Avoid retaining vote data beyond the current round; do not put pre-reveal votes into error telemetry, analytics, or log output.
- Avoid relying on IP addresses as identities or security boundaries.

## 8. Repository layout

```text
planning-poker/
├── README.md
├── LICENSE                      # MIT
├── SPEC.md                      # this document
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── wrangler.jsonc
├── index.html
├── src/
│   ├── client/                  # Svelte app, components, routes, styles
│   ├── worker.ts                # Worker HTTP/WebSocket routing
│   ├── room-object.ts           # Durable Object implementation
│   └── shared/                  # event schemas, validation, types
├── test/
│   ├── room.test.ts
│   ├── authorization.test.ts
│   └── realtime.test.ts
└── .github/
    └── workflows/
        └── ci.yml               # typecheck, tests, build; no deployment secret needed
```

Keep the root a **single deployable Workers project**; avoid monorepo complexity for the one-click button.

## 9. Cloudflare configuration

Use a current Wrangler version and a SQLite-backed migration (not legacy `new_classes`). Illustrative `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "planning-poker",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-13",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "RoomObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomObject"] }]
}
```

Export `RoomObject` from the Worker entry module (either define there or re-export it). Configure the Vite build to emit `dist/`, and ensure the `deploy` script builds before invoking Wrangler (for example `npm run build && wrangler deploy`). Run `wrangler dev` through an appropriate script for local integration testing; verify that Durable Object bindings and static asset routing are handled together.

Check deployment and compatibility against the installed Wrangler/Cloudflare docs during implementation; the above is an implementation starting point, not a pre-tested production configuration.

## 10. Public repository and one-click deployment

The README must include:

1. One-sentence introduction, screenshot/GIF after UI exists, features, privacy/no-history statement.
2. A **Deploy to Cloudflare** badge near the top, using the real repository URL **after publishing**:

   ```md
   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/REPOSITORY)
   ```

3. Step-by-step first deployment: click badge, sign in to Cloudflare/GitHub as requested, authorize repo creation, review project, deploy, open provided `workers.dev` URL.
4. Explicit statement that users need their own Cloudflare account and that free-tier availability/limits can change; do not guarantee a credit-card-free experience for every location/account.
5. Local development commands and manual deployment fallback:

   ```bash
   npm ci
   npm run dev
   npm run build
   npx wrangler login
   npm run deploy
   ```

6. Setup should **not** require manually creating D1/KV/R2 databases or setting API keys.
7. GitHub Actions CI for PR validation; Cloudflare's deployment integration handles optional redeploys after repository changes.
8. MIT LICENSE and basic CONTRIBUTING/security notes.

**Important:** The button works only once the actual public GitHub repository exists, includes valid config/build scripts, and is verified end-to-end. This spec does **not** itself create or publish that repository.

## 11. Testing checklist

### Unit/integration

- Create room returns a distinct opaque ID and admin token; room exists in storage.
- Nonexistent room never silently initializes as an accessible room.
- Admin token hash verification succeeds; unauthorized reveal/reset/settings/delete all fail.
- Joining, duplicate browser tabs, token reuse, changing name, and reconnecting work.
- Participant cannot impersonate another participant by passing a member ID alone.
- Before reveal, inspect **every** server payload and snapshot: no vote values leak.
- Vote replacement; reveal; locked votes; reset; round increment; idempotent repeat actions.
- Deck change triggers reset; malformed deck, oversized names and invalid vote options rejected.
- Durable Object restart/hibernation simulation restores persisted room, settings, identities and current voting state.
- Deletion irreversibly blocks room access and re-creation under the same ID.
- Rate limits and oversized payloads enforced.

### Manual browser E2E

1. Create room in Browser A; open URL as participants in Browsers B and C.
2. Vote privately; verify nobody, including admin, can inspect vote values through DevTools before reveal.
3. Reveal; verify simultaneous update; reset; verify votes disappear across clients.
4. Close all tabs; revisit after inactivity; admin in A remains admin; participants can rejoin.
5. Clear localStorage for A; verify admin access is lost and no recovery flow exists. New room creation works.
6. Deploy from the public README button on a fresh Cloudflare account; verify room creation, WebSocket handshake, voting, hibernation/reconnect, and static route refresh on `/r/:roomId`.
7. Test on narrow phone screens, with keyboard navigation, slow networks, and WebSocket reconnects.

## 12. Delivery phases

**Phase 1 — Working MVP:** Worker + Svelte UI + durable room state, create/join/vote/reveal/reset, admin localStorage, WebSocket sync, persistent room, tests.

**Phase 2 — Repository-ready:** Clear UX, settings and deletion, reconnect/error states, security limits, CI, MIT README, verified single-click deployment to a fresh account.

**Definition of done:** A stranger can visit the public GitHub repository, click **Deploy to Cloudflare**, obtain a working app on their own account without configuring any external database or authentication provider, create a room, hold a voting session, return to the same room next week, and remain admin in the original browser.

## 13. Official references

- [Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Objects getting started](https://developers.cloudflare.com/durable-objects/get-started/)
- [SQLite-backed Durable Objects migration guidance](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
