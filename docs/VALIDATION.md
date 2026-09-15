# Validation scope (2026-09-15)

This document deliberately excludes account IDs, contact names, room IDs, message contents, credentials and screenshots of private conversations.

## Real-account checks

| Capability | Result | Boundary |
|---|---|---|
| Load stored credentials from macOS Keychain | Passed | Secrets never printed |
| LOCO login using an existing tablet registration | Passed | Registration was completed locally by the operator |
| Enumerate existing rooms and filter names | Passed | Direct, group, open and business-room types observed |
| Exact room lookup and stable member snapshot | Passed | Direct-room identity checked before sending |
| Strict message history and forward cursor | Passed | Fresh process and exclusive lower cursor checked |
| One text WRITE to an approved direct room | Own-history confirmed | Initial receipt was `unknown / INVALID_RESPONSE`; one matching own message appeared afterwards |
| Automatic acceptance of a fresh WRITE response after patch | Not live-retested | No second message sent to the recipient just to test a parser change |
| Token rotation, encrypted persistence and new-process reconnect | Passed after fix | Existing Keychain root left unchanged; rotated credentials encrypted in a private local envelope; refreshed credentials successfully logged in |
| Read-only reconciliation | Passed | Exact own log ID, sender, text, type and time window verified; separate evidence preserves original ambiguous response |
| Duplicate attempt prevention against actual reservation | Passed | `ALREADY_ATTEMPTED` before any network call; no second WRITE |

## Problems found and changes

1. The provider's BSON decoder promotes integer values within the safe range to JavaScript numbers. A strict echoed-chat-ID check rejected such numeric echoes. A regression fixture now traverses the actual provider-style BSON encode/decode boundary; safe positive numeric **echoed chat IDs only** are accepted. Numeric log IDs and unsafe numbers remain rejected. The original live raw reply was not retained, so this reproduces a concrete decoder incompatibility without claiming every field in that reply is known.
2. Keychain reads worked but updating the existing credential item was rejected on this host. The credential vault now leaves that root unchanged and encrypts rotated credentials locally using AES-256-GCM with a Keychain-secret-derived HKDF key, fresh salt/nonce and account/device-bound authenticated context. No OS permission changes or denied Keychain mutations are retried. A persistence preflight precedes remote rotation. Live refresh succeeded; the encrypted file contained no plaintext token, had mode 0600, and a new process successfully logged in and read history with the stored rotated credentials. A save failure after preflight is still possible; do not retry blindly.
3. `doctor` now states that it is an offline check rather than emitting a permanent `live_kakao_tested: false` project-wide claim.
4. Read-only `reconcile` verifies an explicitly supplied log ID against original account, recipient, exact text, message type and attempt-time window. It adds a separate evidence file and never calls WRITE or replaces the original unknown receipt.

## What is not integrated

The provider exposes more features than this bridge. Photos, video, audio, file/multi-photo uploads, quoted replies, push/event listeners, typing indicators, explicit mark-read, room leaving, and general profile APIs are not exposed as bridge CLI commands. They were **not** live-tested. It would be incorrect to say that all agent-messenger features are integrated.

Logout and destructive/session-changing actions are not exercised against the working account merely to increase test coverage. Authentication, rotation, errors, expiry, recipient changes, duplicate suppression and crash reservations have automated fixtures; a fixture is not an account E2E test.
