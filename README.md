# kakao-headless

[![CI](https://github.com/JSap0914/kakao-headless/actions/workflows/ci.yml/badge.svg)](https://github.com/JSap0914/kakao-headless/actions/workflows/ci.yml)

A local KakaoTalk CLI for agents. List rooms, read messages and send text without controlling the KakaoTalk app UI.

Uses `agent-messenger@2.37.1` as its LOCO provider, with an original MIT-licensed layer for credential storage, recipient checks, durable send reservations and history verification.

> Unofficial integration. Kakao may restrict accounts that use unofficial clients. Review the provider's terms and use a test account first. No affiliation with Kakao or Aside.

## Features

- **Read:** list/search existing rooms, fetch message history and page from an exact log ID.
- **Send:** exact-recipient previews, account/member rechecks and one local WRITE attempt per preview.
- **Verify:** distinguish server acceptance from an own-history match; reconcile ambiguous replies without resending.
- **Authenticate:** two-step phone registration, hidden password input and explicit token refresh.
- **Store securely:** initial secret in macOS Keychain; rotated credentials encrypted with AES-256-GCM under a Keychain-derived key. No plaintext token cache.
- **Use with Aside:** bundled user skill for the installed CLI.

Room lookup, history, forward paging, one direct-room text send, read-only reconciliation and token refresh/reconnection have been checked against a real account. Automated tests cover protocol compatibility and failure paths. See [validation details](docs/VALIDATION.md) for the exact scope.

## Install

Requires macOS, Node.js **22.13+**, and Apple command-line tools (`xcode-select --install`) for Keychain access. Core tests also run on Linux.

Install into a dedicated directory:

```sh
mkdir -p "$HOME/.local/share/kakao-headless"
cd "$HOME/.local/share/kakao-headless"
npm init -y
npm install --ignore-scripts --save-exact \
  https://github.com/JSap0914/kakao-headless/releases/download/v0.1.1/jsap0914-kakao-headless-0.1.1.tgz
npm install --ignore-scripts --save-exact agent-messenger@2.37.1
npx --no-install kakao-headless doctor
```

The package is distributed through [GitHub Releases](https://github.com/JSap0914/kakao-headless/releases), not the npm registry. Release assets include checksums. The optional provider is installed separately; read [THIRD_PARTY.md](THIRD_PARTY.md) before using or redistributing it. Do not install `agent-kakaotalk@0.0.1`, which is a separate empty package-name reservation.

Run the examples below from the installation directory. Optionally symlink `node_modules/.bin/kakao-headless` into a directory on your `PATH`.

## Connect an account

```sh
npx --no-install kakao-headless auth begin --email YOU@example.com --ack-risk
# Confirm the locally displayed registration code on your phone, then:
npx --no-install kakao-headless auth finish --ack-risk
```

Passwords are prompted without echo and are never persisted. Keep passwords and registration codes out of chat, shell arguments, logs and GitHub. Device registration does not force-replace an occupied device slot.

```sh
npx --no-install kakao-headless auth refresh --ack-risk
```

Refresh preflights encrypted persistence before requesting a new token. The existing Keychain root remains unchanged; no Keychain permission weakening is required.

## Read rooms and messages

```sh
npx --no-install kakao-headless chats --search 'Room name' --ack-risk
npx --no-install kakao-headless history 'CHAT_ID' --count 30 --ack-risk
npx --no-install kakao-headless history 'CHAT_ID' --from 'LOG_ID' --count 30 --ack-risk
```

IDs are exact decimal **strings**, never JavaScript numbers. `--from` is an exclusive lower cursor, not a before/older cursor. Reads do not issue mark-read, typing or room-entry commands, although a live login can affect session/presence state. History fails explicitly if its bounded page scan cannot finish.

## Preview and send

```sh
printf '%s' 'This is one test message. No reply needed.' > message.txt
npx --no-install kakao-headless preview 'CHAT_ID' --text-file message.txt --ack-risk
# Check the returned recipient, members and exact text before confirming:
npx --no-install kakao-headless send 'PREVIEW_UUID' --confirm --ack-risk
npx --no-install kakao-headless receipt 'PREVIEW_UUID'
```

A preview expires after ten minutes and is bound to the account, room, members and exact text. The 4,000-byte text limit is measured in UTF-8; trailing newlines are preserved.

A durable reservation is written **before** the network call. Connection loss, crashes or an ambiguous response do not cause an automatic retry. This is at-most-one local attempt per preview, not a guarantee of exactly-once delivery. Deleting state or creating another preview is outside that duplicate-protection boundary.

### Reconcile an ambiguous result

First find the exact own-message log ID in history, then:

```sh
npx --no-install kakao-headless reconcile 'PREVIEW_UUID' --log-id 'LOG_ID' --ack-risk
npx --no-install kakao-headless receipt 'PREVIEW_UUID'
```

Reconciliation is **read-only**. It checks the account, recipient, log ID, text, message type and attempt-time window. Separate verification evidence is added without rewriting the original response or sending again.

| Result | Meaning |
|---|---|
| `verified` | Send response and exact own-history entry matched |
| `accepted_unverified` | Response accepted; history not yet confirmed |
| `unknown` | Response lost or malformed; do not retry |
| `rejected` | Explicit rejection or a pre-write validation failure |
| `verification.status: history_verified` | Follow-up history verification succeeded; original response is preserved |

These are not recipient delivery/read receipts. Exit `0` means the command succeeded, `1` means validation/runtime failure, and `2` means a send did not reach history-verified status. A nonzero send exit is never an instruction to retry.

## Aside integration

Copy the bundled skill into the user skills directory for your Aside account:

```sh
mkdir -p /path/to/aside/account/skills/user/kakao-headless
cp node_modules/@jsap0914/kakao-headless/skills/kakao-headless/SKILL.md \
  /path/to/aside/account/skills/user/kakao-headless/SKILL.md
```

Set the installed CLI path in that skill. Agents use the CLI for room lookup, previews, approved sends and receipts. This is a separate integration; it does not add a send method to Aside's built-in `kakaotalk` REPL global.

## Storage and limits

State defaults to `~/.local/state/kakao-headless`; use `--state-dir` only with a trusted private directory. State is mode `0700`, files `0600`. Previews contain plaintext message text and member IDs. Rotated credentials are encrypted. Back up the Keychain root and encrypted credential file together; removing the root can make that file unreadable. Never commit private state.

`auth import --ack-risk` accepts an already authorized credential object on stdin only. `auth logout` deletes local credentials, not the server session, and reports an error if the OS refuses deletion. Serialize credential-changing commands; concurrent refreshes across processes are not supported.

Text messages in existing rooms are the supported write scope. Attachments, quoted replies, new-room creation, push listeners, typing, explicit mark-read and room leaving are not exposed by this CLI.

## Development

```sh
npm ci --ignore-scripts
npm test
# With the pinned optional provider installed:
TEST_PROVIDER=1 npm test
```

CI runs on macOS/Linux with Node 22/24 and exercises the real provider's offline API/codec contracts. CI has no account credentials and never sends messages.

[Architecture](docs/SPEC.md) · [Security](SECURITY.md) · [Validation](docs/VALIDATION.md) · [MIT license](LICENSE)
