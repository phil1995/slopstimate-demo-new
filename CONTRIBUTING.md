# Contributing

Install Node.js 24+, run `npm ci`, and start the full local app with `npm run dev`. No Cloudflare credentials are needed to develop or test locally.

Keep changes focused and explain the user-visible behavior in your pull request. Before submitting, run:

```sh
npm run format
npm run check
npm test
npm run deploy:check
```

For behavior affecting authorization, private votes, resets, persistence, or realtime connections, add an integration test against the Workers runtime. For UI changes, check narrow phone screens, keyboard focus, native dialogs, connection errors, and two separate browser profiles. Do not include secrets, `.dev.vars`, local durable storage, or real team data in commits or screenshots.

The project intentionally has no accounts, recovery, ownership transfer, history, external database, or third-party realtime service. Discuss changes to those boundaries before building them. Preserve existing deployed rooms when changing durable storage: this initial release has a single SQLite migration; future schema changes must account for existing data.
