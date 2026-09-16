# V3.5 validation

- JavaScript syntax: passed for server.js, app.js, and the userscript.
- 33 server-route simulation assertions passed.
- 43 existing DOM/standalone-script regression assertions passed.
- 20 paired desktop/mobile integration simulation assertions passed.
- Total: **96 local simulation assertions**.
- Validated shared selection, callback/promise GM API adapters, device attribution, reload persistence, manual handoff, stale-device reporting, one-owner lease, notification deduplication, scoped credentials, admin stop and offline status.
- Visual checks: desktop management card and 375px local panel inspected using offline sample tickets.
- The production Express/Playwright npm runtime was not installed in this sandbox due to DNS failure. The source route handlers were exercised through a lightweight local HTTP/Express harness instead.
- No live ticket account was used and no real ntfy notification was sent.
- No claim of actual SE2/Windows browser-extension compatibility, live ticket parsing, Cloudflare unblock, or push latency verification. These require device testing.
- Existing cloud monitor implementations retained. No automatic cloud-to-local fallback and no multi-tab background guarantee.

Primary implementation references consulted:
- https://github.com/quoid/userscripts (promise-based GM APIs, extension script storage)
- https://www.tampermonkey.net/documentation.php (callback tab APIs and @connect)
- https://support.microsoft.com/en-us/topic/learn-about-performance-features-in-microsoft-edge-7b36f363-2119-448a-8de6-375cfd88ab25 (sleeping tabs)
