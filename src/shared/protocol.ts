export const DEFAULT_DECK = ['0', '0.5', '1', '2', '3', '8', '13', '?'];
export const FIBONACCI = ['0', '1', '2', '3', '5', '8', '13', '21', '?'];
export const TSHIRT = ['XS', 'S', 'M', 'L', 'XL', '?'];
export const ROOM_ID = /^[a-f0-9]{32}$/;
export const TOKEN = /^[a-f0-9]{64}$/;

export interface RoomMetadata {
  id: string;
  title: string;
  deck: string[];
  // Internal estimation revision for stale-request protection, not a visible round number.
  round: number;
  revealed: boolean;
  version: number;
}
export interface PublicMember {
  id: string;
  name: string;
  voted: boolean;
  connected: boolean;
  // This key is absent, not merely null, before reveal.
  vote?: string | null;
}
export interface RoomSnapshot extends RoomMetadata {
  members: PublicMember[];
}
export type ServerEvent =
  | { type: 'authenticated'; memberId: string | null; isAdmin: boolean }
  | { type: 'snapshot'; version: number; room: RoomSnapshot }
  | { type: 'room_deleted' }
  | { type: 'membership_removed' }
  | { type: 'error'; message: string };
export interface JoinResponse {
  memberId: string;
  memberToken?: string;
  room: RoomSnapshot;
}
export interface CreateResponse {
  roomId: string;
  adminToken: string;
}
