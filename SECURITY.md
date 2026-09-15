# Security and operational limits

Experimental software. Do not use your main Kakao account for initial testing.
Unofficial LOCO access may violate provider terms and cause restrictions. Device
registration/login may affect other sessions. This software does not bypass
registration or account controls and does not force-replace another device.

## Trust boundary

The local OS user, installed Node/Swift runtime, optional provider, and state
directory are trusted. A local process with equivalent privileges can bypass the
CLI, edit/delete approvals, read plaintext previews, or access Keychain through
OS-authorized processes. This is not a sandbox against malicious local agents.
The exported raw transport is a low-level SDK, not an authorization boundary;
agent workflows must go through the guarded CLI.

Credentials go over stdin to a Swift Security-framework helper and are stored as
non-synchronizing generic-password Keychain items. They are not passed as command
arguments, environment variables, or application logs. Passwords are not saved.
The helper runs with local command-line tools and is not a signed standalone
credential broker. Keychain access may require local OS approval. Registration
codes appear only in the local auth command result: never paste them into public
issues or agent transcripts. Secret input buffers are not guaranteed zeroized.

## Sending

A successful packet is insufficient proof of recipient delivery. Explicit
nonzero provider status is rejection; lost/malformed replies are unknown.
History verification matches log ID, sender and exact text but is not a receipt
of the recipient seeing/reading it. Network failures never trigger WRITE retry.
Durable per-preview reservation survives crashes. Do not delete it and retry.
Approval is bound to a snapshot of room identity/members; server-side membership
can still change between the final check and WRITE. Use a known test conversation.

## Local data

Preview files contain private text and member IDs; receipts and provider cache
contain IDs. Files are mode 0600 and the state directory is 0700, but previews
are not encrypted. Do not put state inside a repository or shared/symlinked
folder. The threat model excludes an attacker controlling the local filesystem.
Explicitly clean private state only after reconciling all outstanding sends;
cleanup discards duplicate suppression. There is no telemetry, hosted endpoint,
automatic listener, or scheduled sender in this bridge.

Report a vulnerability without tokens, messages or real chat IDs. Use a GitHub
private vulnerability report if enabled; otherwise open a minimal issue asking
for a private contact without disclosing exploitable or personal details.
