import type { RoomMetadata, RoomSnapshot } from '../shared/protocol';
export interface Member {
  id: string;
  tokenHash: string;
  name: string;
  vote: string | null;
  joinedAt: number;
}
export interface RoomState extends RoomMetadata {
  adminTokenHash: string;
  createdAt: number;
  updatedAt: number;
  members: Member[];
}
export interface Tombstone {
  deleted: true;
}
export function metadata(state: RoomState): RoomMetadata {
  return {
    id: state.id,
    title: state.title,
    deck: state.deck,
    round: state.round,
    revealed: state.revealed,
    version: state.version,
  };
}
// The only serializer for authenticated HTTP and WebSocket room data.
// Never spread private state or member objects into a public response.
export function toPublicSnapshot(
  state: RoomState,
  connected: ReadonlySet<string>,
): RoomSnapshot {
  return {
    ...metadata(state),
    members: state.members.map((member) => ({
      id: member.id,
      name: member.name,
      voted: member.vote !== null,
      connected: connected.has(member.id),
      ...(state.revealed ? { vote: member.vote } : {}),
    })),
  };
}
