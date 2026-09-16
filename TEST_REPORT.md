# Ticket Monitor V4.0 test report

## Static / syntax checks
- `node --check server.js` — PASS
- `node --check public/app.js` — PASS
- `node --check public/universal-linked.user.js` — PASS
- `node --check public/ticketplus-linked.user.js` — PASS
- `node --check public/tixcraft-linked.user.js` — PASS

## Architecture checks
- Default execution mode is `auto` — PASS
- Default detection mode is smart whole-page (`page`) — PASS
- Any valid HTTP(S) URL can use local pairing — PASS
- Old Ticket-Plus-only local restriction absent — PASS
- Auto cloud failure -> local fallback state exists — PASS
- 403 / 429 / 503 / verification page can trigger fallback — PASS
- Login-page detection with password field can trigger fallback — PASS
- Three consecutive ordinary cloud errors can trigger fallback — PASS
- Pairing is allowed while an auto monitor is already waiting for local takeover — PASS
- Universal userscript matches general HTTP/HTTPS sites — PASS
- Universal userscript stores multiple site pairings — PASS
- Universal userscript defaults to smart whole-page baseline — PASS
- Universal userscript supports region selection, multiple regions, per-target delete, and text conditions — PASS
- Site-specific Ticket Plus / Tixcraft scripts remain bundled as optional enhancements — PASS

## Smart page behavior
- First cloud check establishes a baseline and does not notify — PASS by code-path inspection
- Later stable fingerprint change triggers notification — PASS by code-path inspection
- Common clock / relative-time / long-token noise is normalized before fingerprinting — PASS
- Universal local whole-page mode also uses a stable baseline — PASS

## Limits / real-world verification still needed
- No authenticated real-world browser sessions were available in this build environment.
- DOM behavior on every possible third-party website cannot be pre-verified.
- Some SPAs may require local browser mode even when an unauthenticated HTTP fetch returns 200.
- The implementation deliberately does not bypass CAPTCHA, queues, Cloudflare challenges, or other site protections.
