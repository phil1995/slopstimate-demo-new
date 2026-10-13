# Room API and realtime protocol

All API responses use JSON and `Cache-Control: no-store`. API URLs reject query parameters; bearer secrets must never be placed in URLs. HTTP bodies must be `application/json`, at most 4096 bytes. Mutating requests and WebSocket upgrades must include an allowed Origin (the request origin or an exact configured `ALLOWED_ORIGINS` entry). No wildcard origins or cookie authentication are used.

| Endpoint                                  | Request                  | Authority                                             | Response                                                                  |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /api/rooms`                         | `{}`                     | None                                                  | `201 {roomId, adminToken}`; secret returned once                          |
| `GET /api/rooms/:id`                      | —                        | None                                                  | Basic metadata only: id/title/deck/round/revealed/version                 |
| `GET /api/rooms/:id`                      | —                        | Member or admin Bearer                                | Redacted/revealed full snapshot                                           |
| `POST /api/rooms/:id/join`                | `{name}`                 | None for new identity; member Bearer to resume/rename | `{memberId, memberToken?, room}`; new secret returned once                |
| `POST /api/rooms/:id/vote`                | `{vote, round}`          | Member Bearer                                         | Current full snapshot; chosen value omitted before reveal                 |
| `POST /api/rooms/:id/leave`               | `{}`                     | Member Bearer                                         | `{ok:true}`; revokes membership in every tab                              |
| `POST /api/rooms/:id/reveal`              | `{round}`                | Member or admin Bearer                                | Current snapshot                                                          |
| `POST /api/rooms/:id/admin/reset`         | `{round}`                | Admin Bearer                                          | Current snapshot                                                          |
| `POST /api/rooms/:id/admin/settings`      | `{title, deck, version}` | Admin Bearer                                          | Current snapshot                                                          |
| `POST /api/rooms/:id/admin/remove-member` | `{memberId}`             | Admin Bearer                                          | Current snapshot; removes membership and vote, revokes all target sockets |
| `DELETE /api/rooms/:id`                   | `{}`                     | Admin Bearer                                          | `{ok:true}`; permanent tombstone                                          |
| `GET /api/rooms/:id/ws`                   | WebSocket upgrade        | Authenticate in first frame                           | Events below                                                              |

Secrets and room IDs are lowercase hexadecimal: 64 characters for bearer secrets, 32 for room IDs. Errors are `{error: string}` with 400/401/403/404/409/413/414/415/426/429 as appropriate. Unknown and deleted rooms return 404; visiting them never creates state.

Joining requires a trimmed, nonempty name of 1–40 characters. Names need not be unique; members are identified by their secret-backed IDs. New rooms use `0, 0.5, 1, 2, 3, 8, 13, ?`; `?` means skipping and stays private until reveal, just like estimates. It counts as a completed response.

Admin member removal is by stable member ID, never name. It removes that member’s current vote without resetting the round, revokes all their sockets after durable commit, and broadcasts the updated snapshot. Repeating a removal for an already-removed ID is a no-op. The person may join again with a new identity.

Any joined participant can reveal the current round using their member bearer token. The admin may also reveal without joining as a voter. `/admin/reveal` remains an alias with the same shared authorization rule. Reset, settings, removal, and deletion remain admin-only. The interface shows all members together below the estimate boxes, with revealed values only beside names. Presence metadata is retained in the protocol for reconnect behavior but is not separated in the UI.

The product presents a single current estimation with a **Reset estimation** action, without numbered rounds. The existing `round` field remains an internal estimation revision for compatibility and rejection of stale votes/reveals/resets; no history is stored. On reveal, clients calculate the arithmetic mean of current finite decimal estimates, including zero and fractional choices. Skipped, missing, and nonnumeric choices are excluded. The summary is shown beside participants on wide screens and below them on narrow screens; when there are no numeric estimates the average shows `—`, not zero. Reset hides the summary and clears values.

The revealed summary also includes a disagreement indicator and vote counts. Disagreement is the population standard deviation divided by the absolute mean: **Low** at or below 25%, **Medium** above 25% up to 50%, and **High** above 50%. These are app-defined thresholds. Identical estimates (including a single numeric vote or all zeros) are Low. A zero mean with nonzero deviation is High. No numeric estimates yields no rating. Counts include skipped and nonnumeric choices, exclude unvoted members, and follow deck order. All statistics include saved members regardless of presence and recompute when a member is removed.

## Snapshots and consistency

The types live in `src/shared/protocol.ts`. A full room snapshot extends metadata with `members: {id, name, voted, connected, vote?}[]`. The `vote` property is **absent** until `revealed === true`; once revealed, it is a deck string or `null` for non-voters. Token hashes, timestamps, and raw credentials are never serialized into a snapshot. Unauthenticated metadata contains no roster or estimates, even after reveal.

All mutations are serialized within the Durable Object. Each committed mutation or presence update increments `version`. Voting requires the exact current `round`; stale/future voting and reveals fail with 409. Revealing an already-revealed round is a no-op. Resetting the current round clears all votes and increments `round`; repeating a reset for an older round returns the current snapshot without another reset. Future-round resets fail. Settings require the current `version`, preventing stale overwrites; deck changes atomically reset the round while title-only changes preserve votes.

Clients ignore snapshots with an older version and clear their local card selection on a round change. Every successful WebSocket reconnect receives an authoritative snapshot, including current settings and presence, so there is no replay or history protocol. The UI knows its own locally selected card; the server never sends anyone's choice until reveal.

## WebSockets

Connect to `/api/rooms/:id/ws` without query parameters. Within ten seconds send:

```json
{
  "type": "auth",
  "memberToken": "<optional member secret>",
  "adminToken": "<optional admin secret>"
}
```

At least one identity must verify. Roles are checked independently; a revoked member does not remove valid admin authority. Attachments hold only the verified role/member ID and handshake deadline. Sockets do not accept mutation messages. Frames are limited to 1024 UTF-8 bytes; binary frames are rejected. The room cap includes unauthenticated sockets.

Server events:

```ts
{ type: 'authenticated', memberId: string | null, isAdmin: boolean }
{ type: 'snapshot', version: number, room: RoomSnapshot }
{ type: 'room_deleted' }
{ type: 'membership_removed' }
{ type: 'error', message: string }
```

The implementation deliberately uses complete bounded snapshots in place of incremental roster/vote events. This gives every state transition the same privacy serializer and simplifies reconnects. There are at most 50 members.

The client sends `ping` every 25 seconds; the hibernation auto-response returns `pong` without waking or mutating the room. Missing heartbeats cause a reconnect with bounded exponential backoff. A storage alarm closes incomplete handshakes only, with no room expiration. Close codes: 4401 invalid/revoked member, 4403 invalid admin, 4404 deleted room, 4408 handshake timeout, 1008 disallowed action, 1009 oversized frame. Timeout/transport errors do not erase saved authority.
