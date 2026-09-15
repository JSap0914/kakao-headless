![Kakao Headless: Read. Approve. Send. A community integration for Aside.](assets/hero.png)

# Kakao Headless

**Read KakaoTalk messages and send approved text or images from your agent. No app UI automation.**

[![CI](https://github.com/JSap0914/kakao-headless/actions/workflows/ci.yml/badge.svg)](https://github.com/JSap0914/kakao-headless/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JSap0914/kakao-headless?include_prereleases&label=release)](https://github.com/JSap0914/kakao-headless/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Kakao Headless lets your agent find conversations, read messages, prepare replies, and send text or a PNG/JPEG image after your approval.

**Use it directly from the terminal, or connect it to Aside with the included skill.** If you already use Aside, follow the setup below and install the skill so Aside can use the CLI for you.

## Setup

You need **macOS**, **Node.js 22.13+**, and Apple command-line tools (`xcode-select --install`). For the Aside integration, have Aside installed and a local account set up first.

### 1. Install Kakao Headless

```sh
npm install -g --ignore-scripts \
  https://github.com/JSap0914/kakao-headless/releases/download/v0.3.0/jsap0914-kakao-headless-0.3.0.tgz \
  agent-messenger@2.37.1

kakao-headless doctor
```

This installs the CLI and its KakaoTalk protocol provider. Kakao Headless packages are distributed through GitHub Releases.

If your global npm directory is not writable, add `--prefix "$HOME/.local"` to the install command and use `"$HOME/.local/bin/kakao-headless"` instead of the bare command. No `sudo` is needed.

### 2. Sign in to your Kakao account

Run these commands in a local terminal:

```sh
kakao-headless auth begin --email YOU@example.com --ack-risk
# Complete the registration confirmation on your phone, then:
kakao-headless auth finish --ack-risk
```

Follow the terminal prompts and allow macOS Keychain access when requested. Password input is hidden. Never paste passwords or phone verification codes into an agent chat.

Each installation uses **your own Kakao account**. The `@jsap0914` package name identifies the publisher; it does not connect you to the publisher's account. Credentials stay on your machine.

### 3. Connect to Aside

If you use Aside, install the included skill:

```sh
kakao-headless aside install --account 0
kakao-headless aside doctor --account 0
```

Replace `0` with your **local Aside account slot** if different. It is not your Kakao user ID. For a custom account directory, also pass `--account-root /absolute/path/to/account`.

The installer adds the Kakao Headless user skill and records the CLI path for Aside. No manual file copying or changes to Aside's built-in connector are needed.

You can then ask Aside to:

- Find a conversation with a specific person.
- Read and summarize messages in that conversation.
- Prepare a reply, show you the recipient and text, and send it after approval.
- Send an image you provide to a person you specify after approval.

**You do not need Aside to use the CLI.** Skip this step if you prefer the terminal or another agent.

## Use from the terminal

### Find a conversation and read messages

```sh
kakao-headless chats --search 'Room name' --ack-risk
kakao-headless history 'CHAT_ID' --count 30 --ack-risk
```

Use the exact chat ID returned by the first command.

### Send text

```sh
printf '%s' 'Hello! Here is the update.' > message.txt
kakao-headless preview 'CHAT_ID' --text-file message.txt --ack-risk
# Check the recipient and text, then use the returned preview ID:
kakao-headless send 'PREVIEW_ID' --confirm --ack-risk
```

### Send an image

```sh
kakao-headless preview 'CHAT_ID' --image-file ./image.png --ack-risk
# Check the recipient and image, then use the returned preview ID:
kakao-headless send 'PREVIEW_ID' --confirm --ack-risk
```

### Check the result

```sh
kakao-headless receipt 'PREVIEW_ID'
```

If a send result is unclear, check history rather than sending again. The read-only `reconcile` command can verify an existing message:

```sh
kakao-headless reconcile 'PREVIEW_ID' --log-id 'LOG_ID' --ack-risk
```

A history match confirms the message in your own history, not that the recipient has read it.

## Update or remove the Aside skill

After upgrading the CLI, run `kakao-headless aside install --account 0` again to update the skill. Files you have edited are preserved.

To remove the managed skill:

```sh
kakao-headless aside uninstall --account 0
```

## Development

```sh
git clone https://github.com/JSap0914/kakao-headless.git
cd kakao-headless
npm ci --ignore-scripts
npm test
```

[Technical reference](docs/SPEC.md) · [Security](SECURITY.md) · [Third-party notes](THIRD_PARTY.md) · [MIT license](LICENSE)
