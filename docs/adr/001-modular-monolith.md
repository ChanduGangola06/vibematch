# ADR 001 — Modular monolith behind ports, not microservices

**Status:** accepted

**Context.** The product is one deployable web+mobile backend maintained by a small team. The system-design checklist (load balancing, caching, queues, discovery, service split …) must be *supported*, but splitting into services on day one multiplies operational cost (deploys, tracing, distributed transactions for gem balances) for no user-visible benefit.

**Decision.** One process, strict internal boundaries:
* `core/` knows nothing about modules or infrastructure; `infra/` adapters implement ports declared by the modules that need them; modules never import another module's repository (services and events only).
* The API process is stateless. Anything that must be shared between instances sits behind a port with an in-memory and a Redis implementation: rate-limit store, cache, matching queue, match-session store, presence, Socket.IO adapter.
* `matching`/`realtime` and `payments` already depend only on ports, so either can be extracted into its own service later by swapping the in-process calls for a queue/RPC client.

**Consequences.** Horizontal scaling works today (`--scale api=N`, proven by the two-instance tests against a real Redis). Cross-module consistency stays simple (one MongoDB transaction can cover balance + ledger + purchase).
