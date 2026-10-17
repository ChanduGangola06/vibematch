# ADR 002 — In-process event bus; cluster delivery through the Socket.IO adapter

**Status:** accepted

**Context.** Domain events (`message.sent`, `user.liked`, `user.banned`, `session.revoked` …) must reach sockets that may be connected to *another* API instance.

**Decision.** The event bus is deliberately in-process (typed Observer, handler failures isolated). The realtime layer is the only subscriber that talks to sockets, and it never addresses a socket directly: it emits to rooms (`user:<id>`, `sid:<id>`) through Socket.IO. With `REDIS_URL` set, the Redis adapter fans room emits and `disconnectSockets` out to every instance. An event therefore needs to be handled on exactly one instance — the one that served the HTTP request — and its effect is cluster-wide.

**Not done on purpose.** Cache invalidation events (`settings.changed`, `content.changed`) are also local; with the Redis cache the invalidation is shared because it deletes keys in Redis. With the in-memory cache and several instances, changes can take up to the cache TTL (≤ 60 s) to appear on other instances — use Redis when scaling out.

**Verified by.** `tests/integration/redis-cluster.test.ts` (real Redis, two instances): cross-instance matching, signalling, chat, likes, DMs, bans and logout.
