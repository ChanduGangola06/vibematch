# ADR 003 — Gems are a ledgered, atomically-updated balance

**Status:** accepted

**Context.** v1 changed balances with read-modify-write and trusted client-supplied amounts, so concurrent requests could overdraw and a modified client could set its own prices.

**Decision.**
* `users.gems` changes only through `GemService`: debit = one `findOneAndUpdate({ gems: { $gte: cost } }, { $inc })`; credit with a business reference is claimed first in `gem_ledger` under a unique `(refType, refId, reason)` index, so the same purchase can never pay twice.
* Every change appends an immutable ledger row with the resulting balance (`balanceAfter`).
* Balance + ledger + purchase are written in one MongoDB transaction when the deployment is a replica set (the compose files and the installer use one); on a standalone server they fall back to ordered writes and a self-healing retry (`PaymentService.heal`).
* Prices, gem amounts and VIP durations come from the database. Web gateways freeze `userId/packId/gems/price` into gateway metadata at checkout and the verification step checks the paid amount against it.
* Multi-step flows use the Command pattern (`DebitGemsCommand.undo()` refunds) — e.g. a gift whose message cannot be stored.

**Verified by.** `gems.test.ts` (20 parallel spends of 10 against 100 gems → exactly 10 succeed), `economy.test.ts`, `payments.test.ts` (replay, cross-user claim, amount tampering, crash recovery), `migrate-legacy.test.ts` (ledger sums to balances).
