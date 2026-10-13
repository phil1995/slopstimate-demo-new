# Live deployment verification

Fresh-account deployment is to be verified by the repository owner. Local runtime tests and `wrangler deploy --dry-run` have passed; they do not replace this check.

1. On a fresh/eligible Cloudflare account, open the README deployment badge, authorize GitHub repository creation, accept the detected commands, and deploy.
2. Confirm no manual database creation, API keys, or secrets are requested. Verify the `ROOM` binding and SQLite `v1` migration were provisioned.
3. Open the supplied `workers.dev` URL. Create a room in Browser A and join with a name. Save the room URL.
4. Open the URL in Browsers B and C (separate profiles). Join and vote. Inspect HTTP responses and incoming WebSocket frames: unrevealed member objects must have **no `vote` key**, including on reconnect. A browser knows its own outbound choice; the server never echoes it before reveal.
5. Reveal as a participant in B and confirm all profiles immediately show values beside participant names; the estimate boxes retain their choices. Check that the summary contains the average, disagreement, and per-choice vote counts and sits beside participants on desktop and below them on a phone. Skipped/nonnumeric values are excluded from numeric statistics but counted in the vote summary; no numeric votes shows `—` for average and disagreement. Use **Reset estimation** and confirm results and the summary disappear. Changing the deck should also reset the estimation.
6. Refresh `/r/<roomId>` directly and confirm SPA routing works. Open a second tab in A and confirm it counts as one member.
7. Close every tab, revisit later, and confirm A remains admin and names/settings/round persist. Leave the room idle with live sockets and confirm it hibernates/reconnects without losing the round.
8. Test at phone width, use only the keyboard to vote and open/close settings, and disconnect/reconnect the network.
9. In a disposable room, clear A's browser storage and confirm admin controls are gone. There must be no recovery or participant promotion.
10. In another disposable room, delete as admin and confirm every client receives deletion and the link returns Not Found permanently.
11. Record the date, Cloudflare account plan, deployed URL, build result, and any quota/eligibility conditions here. Then update the README verification statement.
