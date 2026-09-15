# kakao-headless

Experimental, UI-free KakaoTalk read/write bridge for local agents, including Aside.

**Status: alpha, not live-account verified.** Unit/contract tests are not evidence of real message delivery. This is not an official Kakao product or an update to Aside's built-in read-only connector. Unofficial protocol access can lead to account restrictions. Use a dedicated test account, not your primary account.

## What it does

- Lists existing rooms and reads message history through a pinned LOCO provider.
- Does not call mark-read, typing, room-entry or app UI automation APIs for reads. A LOCO login is still an online session, not an offline database read.
- Stores OAuth tokens in macOS Keychain, not plaintext credential JSON.
- Separates device registration into `auth begin` and `auth finish`. The password is prompted locally without echo and is never persisted.
- Creates a ten-minute preview bound to account, exact room ID, title/display name, members and exact text.
- Rechecks the recipient, reserves the attempt durably, then calls raw `WRITE` once without the provider's automatic replay wrapper.
- Validates packet/body status and exact log ID. Checks history for matching log ID, sender and text.
- Writes explicit `verified`, `accepted_unverified`, `rejected` or `unknown` receipts. None means that the recipient has read the message.

Not included: new chats by contact name, attachments, group creation, automatic sending, a hosted service, an MCP server, or account restriction avoidance.

## Install

Requirements: macOS, Node >=22.13.0, and Apple command-line tools (`xcode-select --install`) for the Swift Keychain helper. Core mocked tests also run on Linux. Keychain may request local OS approval.

Download the `.tgz` from [Releases](https://github.com/JSap0914/kakao-headless/releases). Install into a dedicated local directory, not into an existing app:

```sh
mkdir kakao-local && cd kakao-local
npm init -y
npm install --ignore-scripts /absolute/path/to/jsap0914-kakao-headless-0.1.0.tgz
# Review THIRD_PARTY.md first. The provider is an explicit optional peer.
npm install --ignore-scripts --save-prod agent-messenger@2.37.1
npx --no-install kakao-headless doctor
```

`@jsap0914/kakao-headless` is distributed through GitHub Releases; do not assume it is published to the npm registry. **Do not install `agent-kakaotalk@0.0.1`: it is an empty defensive reservation, not the client.** `agent-kakaotalk` is a binary provided by the different `agent-messenger` package.

The MIT license covers this bridge's original files only. The provider is not bundled. Its repository says MIT but lacks a root license grant; review its terms yourself before use or redistribution.

## Connect a test account

```sh
npx --no-install kakao-headless auth begin --email YOU@example.com --ack-risk
# Enter the locally displayed registration code on your phone.
# Run before the challenge expires; password is prompted again:
npx --no-install kakao-headless auth finish --ack-risk
```

The tool does not force-replace an occupied device slot. Do not put passwords in arguments, shell history, chat, CI, or GitHub. `auth refresh --ack-risk` explicitly refreshes and saves a rotated token. `auth logout` deletes local Keychain credentials; it does not revoke the remote session.

For an already authorized test-account token, `auth import --ack-risk` accepts a JSON object on **stdin only** with `oauth_token`, `refresh_token` (optional), `user_id` (string), `device_uuid`, and `device_type` (`tablet` or `pc`). It does not extract tokens from another app. Never commit that input.

## Read

```sh
npx --no-install kakao-headless chats --search 'Exact room name' --ack-risk
npx --no-install kakao-headless history 'CHAT_ID' --count 30 --ack-risk
```

Pass decimal ID strings exactly; do not convert chat/log IDs to JavaScript numbers. History uses strict forward paging internally, returns the latest requested count from the fetched range, and fails explicitly if its 50-page cap is reached. `--from LOG_ID` is an exclusive lower cursor, **not** a before/older cursor. No output is not proof that an entire account has no messages.

## Preview and send

```sh
printf '%s' 'This is one test message. No reply needed.' > message.txt
npx --no-install kakao-headless preview 'CHAT_ID' --text-file message.txt --ack-risk
# Review exact room/member IDs/text in the JSON. Then explicitly authorize:
npx --no-install kakao-headless send 'PREVIEW_UUID' --confirm --ack-risk
npx --no-install kakao-headless receipt 'PREVIEW_UUID'
```

The preview does not send. File bytes are preserved, including trailing newlines. Text is limited to 4,000 UTF-8 bytes. Room changes or a different account invalidate approval. Known recipient IDs should be independently verified; a display name alone is not identity proof.

**Never automatically retry an unknown or unverified result.** Inspect the room with an independent reader. A crash after reservation permanently consumes that preview, even if no bytes were sent. This provides **at-most-one local attempt per preview**, not exactly-once delivery. Creating a fresh preview, deleting state, using another state directory, or another client bypasses that deduplication boundary.

Exit codes: `0` for successful commands / history-verified send, `1` for validation/runtime failures, `2` for a send result that is not history-verified. A nonzero exit after `send` is **not** permission to retry.

State defaults to `~/.local/state/kakao-headless` (directory 0700, JSON files 0600). It contains plaintext previews/message text and nonsecret provider sync metadata. Keep it local and private. `--state-dir` must point to a trusted private directory. No HTTP server or listening port is opened.

## Aside use

The bundled [skill](skills/kakao-headless/SKILL.md) describes the CLI workflow. Install the tool into a stable local directory and add the skill under your Aside account's user skills. It does not modify or claim write support for the built-in `kakaotalk` REPL global. A live test is blocked until local authentication and recipient identity verification are complete.

## Development

```sh
npm ci --ignore-scripts
npm test
# Optional: install the pinned provider explicitly before this offline contract test
TEST_PROVIDER=1 npm test
```

Tests cover two-stage auth, safe Keychain subprocess handling, ID precision, member changes, expiry, concurrent sends, durable reservations, status validation, connection-loss ambiguity, strict history paging and verification mismatch. CI never logs in to Kakao or sends messages. See [SPEC](docs/SPEC.md), [SECURITY](SECURITY.md), and [third-party notes](THIRD_PARTY.md).
