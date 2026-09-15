# Third-party boundaries

This repository contains an original integration layer, not a fork or copy of agent-messenger's protocol implementation. No upstream source is bundled.

- `bson@6.10.4`: Apache-2.0, resolved and integrity-pinned in package-lock.json.
- Optional runtime peer `agent-messenger@2.37.1`:
  https://github.com/agent-messenger/agent-messenger
  Reviewed main commit: db084a7a89ba69c549802f32b83e898b5da3526f.
  npm integrity: sha512-Lj7Pz2XmkWOJvczigwWYOLt2ZQgYyDVQ87dPv1hsi5A2GF9rPfSljOHG0qbe4jUoBMIqyhPEqQtVMVX7LE73AQ==
  The repository README says MIT, but the inspected repository has no root LICENSE file and package metadata has no license field. Its protocol NOTICE also references research under differing terms. Do not interpret this bridge's MIT license as a license grant over that provider or its dependencies.

The provider is installed explicitly by the operator, never fetched dynamically by the CLI. Its source and transitive dependencies require independent review. This release validates the actual `agent-messenger@2.37.1` installation with offline contracts and imports its private connection/config surfaces through version-checked `file:` URLs. That is a deliberate compatibility coupling to this exact provider version and installation layout, not a claim of support for a public provider API. A changed or unpinned provider must fail closed rather than select another transport path.

The provider's transitive dependency tree is not pinned by this bridge's lockfile; retain the consumer installation's package-lock.json for reproducibility.

`agent-kakaotalk@0.0.1` is a separate defensive package-name reservation containing no runtime. It must not be confused with the agent-kakaotalk executable supplied by agent-messenger.
