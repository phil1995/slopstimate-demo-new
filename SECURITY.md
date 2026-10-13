# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/phil1995/Slopstimate/security/advisories/new). Do not post bearer tokens, room URLs for real teams, or unrevealed votes in public issues.

Room IDs have 128 bits of randomness. Admin and member secrets have 256 bits and are stored server-side only as SHA-256 hashes. Possession of a room URL permits joining, not administration. Every HTTP mutation checks its bearer identity and Origin. WebSockets authenticate through their first frame with a ten-second deadline, and receive no room data before authentication. Incoming frames and request bodies are bounded; server output excludes actual vote fields until reveal.

Browser secrets live in room-scoped local storage. This enables return visits but makes XSS prevention essential. User content is rendered as text, and static assets enforce CSP. There is no admin recovery: clearing storage or losing a browser loses authority. Never add secrets to URLs, clipboard links, logs, telemetry, or HTML attributes. Do not weaken CSP to accommodate remote scripts.

Reset removes old votes from the application state; there is no history table or archive. Room deletion leaves only a tombstone and clears members, hashes, and votes. This is application-level deletion, not a guarantee about storage-provider backups or infrastructure retention. The server and the deploying Cloudflare account are trusted; votes are not end-to-end encrypted.

The limits in the README provide basic abuse resistance, not comprehensive denial-of-service protection. Operators are responsible for monitoring their Cloudflare account quotas. Keep dependencies updated and do not enable request-body/header logging for authenticated routes.
