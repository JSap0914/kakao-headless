# v0.3.0 protocol adapter specification

## Scope

Local macOS CLI, original MIT wrapper. Optional, exact-pinned provider. Existing-room text writes and one-image writes, strict paged reads, Keychain token persistence. No app UI automation, no modification of Aside internals, and no public relay service.

A supported image is exactly one PNG or JPEG file, no larger than 10 MiB, with width and height each no greater than 20,000 pixels and no more than 100 million pixels total. Validation inspects PNG/JPEG structure and headers only; it is not a full image decode. Captions, galleries, video, audio and all other attachment forms are out of scope.

## State machine

1. `auth begin`: nonforced tablet login. If needed, request challenge and return immediately. Pending email/device UUID/expiry use private local metadata, never the password or phone code. Completing registration can clear this metadata without mutating Keychain.
2. `auth finish`: after phone confirmation, register then login. Save OAuth token and refresh token in Keychain for initial registration; remove pending state. Later token rotations use an AES-256-GCM local envelope rooted in that Keychain secret, with HKDF salt and account/device authenticated context. Root mutation is not required; corruption or changed/missing roots fail closed.
3. `preview`: accept exactly one input mode: `--text-file FILE` or `--image-file FILE`. Read exact room and a complete stable member snapshot. For text, save exact text. For image, validate the allowed format/bounds, copy it immutably to a private generic-named `.image.bin` file with mode `0600`, and bind its SHA-256. Never store or report the source local filename or path. Save account, chat ID, recipient fingerprint, type, creation and expiry timestamps.
4. `send --confirm`: validate preview, account and the image hash if applicable; re-resolve room and recipient before the attempt. Open an exclusive reservation with wx, write/fsync it and fsync its directory before any `SHIP` or `POST` operation.
5. Text previews invoke the raw session WRITE once. For image previews, acquire the provider's private connection/config through version-checked `file:` URL imports pinned to `agent-messenger@2.37.1`. This is an explicit compatibility coupling, not a stable public-provider API. Run offline provider-contract tests against that exact installed version. Use one raw transport path only: `SHIP` → `POST` → stream → `COMPLETE`. Do not call any high-level retrying send wrapper.
6. Inspect packet and body status plus exact BSON/string log ID. Persist accepted outcome before attempting history verification. There is no second write, no retry API, and no replay after an error.
7. `receipt`: offline retrieval. Orphan reservation means unknown, not unsent.
8. `reconcile PREVIEW --log-id ID`: read-only own-history validation using original account, revalidated recipient, exact type and attempt-time window. Text previews require exact text. Image previews require the preview-bound SHA-256 and exact own-history SHA-1, size, dimensions, MIME type and optional server key where present. Store separate verification evidence, preserve original response evidence and block future retries.

## Identity and precision

Chat and log IDs are canonical positive signed64 decimal strings. Numeric inputs are rejected. Safe numeric author IDs from the provider are normalized to strings; unsafe numeric author IDs never verify. Provider CHECKIN currently uses a numeric user ID, so account IDs above Number.MAX_SAFE_INTEGER are rejected explicitly. Recipient binding uses sorted member IDs, room ID, type and raw title/display name. A title is not proof of human identity; verify intended recipient independently.

Preview state is private. Image state uses a generic internal filename specifically to avoid leaking a source filename or path; no private IDs, names, paths or contents belong in logs, public output or release assets.

## Read semantics

Chat listing requests all pages with strict status handling. History uses the provider's getMessagePage, not its error-swallowing convenience getMessages. It pages at most 50 times with page size 100, deduplicates exact log IDs and returns the latest requested N. Unfinished pagination fails, rather than claiming an empty/complete result. No markRead/CHATONROOM/typing calls are made by this bridge. Read sessions can still have provider-side presence/session effects.

## Failure semantics

Validation, room/account revalidation, lookup or storage failure before reservation: no write. Existing reservation: ALREADY_ATTEMPTED. After reservation, all results consume preview. Explicit rejection: rejected. Synthetic close, thrown raw transport call or malformed reply: unknown. Accepted reply without exact history match: accepted_unverified. Exact history match: verified, never 'read' or 'delivered to recipient'. Ambiguous results are never retried; only the same preview's read-only `reconcile` command may add history evidence.

There is no exactly-once claim and no retry queue. Independent clients or new previews are outside the deduplication boundary.

## Live acceptance criteria

- Dedicated test account completes registration and reads its existing rooms.
- Resolve desired test recipient by exact ID and confirm complete membership.
- If using Aside's independent read-only connector, verify that its chat ID maps exactly; do not assume identical naming means identical IDs.
- Approve recipient and one non-sensitive test text or one eligible image.
- Reserve durably before raw `SHIP`/`POST`; make exactly one write path and validate the response.
- Verify an own-history entry using the required text or image evidence.
- Independently verify the message in the read connector or receiving account.
- Record only redacted outcome, never credentials, private image paths or private message history.

The automated suite remains mock/offline provider-contract testing. Text has one real-account send result. One PNG photo has also been sent once, history-reconciled in a fresh process, and verified by downloading and hashing the uploaded original; see VALIDATION.md. JPEG remains offline-tested only.
