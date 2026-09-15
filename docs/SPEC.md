# v0.1 protocol adapter specification

## Scope

Local macOS CLI, original MIT wrapper. Optional, exact-pinned provider. Text-only
existing-room writes, strict paged reads, Keychain token persistence. No app UI
automation, no modification of Aside internals, and no public relay service.

## State machine

1. `auth begin`: nonforced tablet login. If needed, request challenge and return
   immediately. Pending email/device UUID/expiry go into Keychain, not password.
2. `auth finish`: after phone confirmation, register then login. Save OAuth token
   and refresh token in Keychain; remove pending state.
3. `preview`: read exact room and a complete stable member snapshot. Save exact
   text, account, chat ID, recipient fingerprint, creation and expiry timestamps.
4. `send --confirm`: validate preview and re-resolve recipient. Open exclusive
   reservation with wx, write/fsync it and fsync its directory before WRITE.
5. Acquire raw LOCO session; invoke its sendMessage once. Do not call the client's
   retrying high-level sendMessage wrapper.
6. Inspect packet and body status plus exact BSON/string log ID. Persist accepted
   outcome before attempting history verification. Never replay after an error.
7. `receipt`: offline retrieval. Orphan reservation means unknown, not unsent.

## Identity and precision

Chat and log IDs are canonical positive signed64 decimal strings. Numeric inputs
are rejected. Safe numeric author IDs from the provider are normalized to strings;
unsafe numeric author IDs never verify. Provider CHECKIN currently uses a numeric
user ID, so account IDs above Number.MAX_SAFE_INTEGER are rejected explicitly.
Recipient binding uses sorted member IDs, room ID, type and raw title/display name.
A title is not proof of human identity; verify intended recipient independently.

## Read semantics

Chat listing requests all pages with strict status handling. History uses the
provider's getMessagePage, not its error-swallowing convenience getMessages.
It pages at most 50 times with page size 100, deduplicates exact log IDs and
returns the latest requested N. Unfinished pagination fails, rather than claiming
an empty/complete result. No markRead/CHATONROOM/typing calls are made by this bridge.
Read sessions can still have provider-side presence/session effects.

## Failure semantics

Validation/lookup/storage failure before reservation: no WRITE. Existing
reservation: ALREADY_ATTEMPTED. After reservation, all results consume preview.
Explicit rejection: rejected. Synthetic close, thrown write or malformed reply:
unknown. Accepted reply without exact history match: accepted_unverified.
Exact history match: verified, never 'read' or 'delivered to recipient'.
There is no exactly-once claim and no retry queue. Independent clients or new
previews are outside the deduplication boundary.

## Live acceptance checklist (not yet executed)

- Dedicated test account completes registration and reads its existing rooms.
- Resolve desired test recipient by exact ID and confirm complete membership.
- If using Aside's independent read-only connector, verify that its chat ID maps
  exactly; do not assume identical naming means identical IDs.
- Approve recipient and one non-sensitive test sentence.
- One WRITE, valid response log ID, matching own-message history entry.
- Independently verify the message in the read connector or receiving account.
- Record only redacted outcome, never credentials/private message history.

Release tests are mock and offline provider-contract tests, not this checklist.
