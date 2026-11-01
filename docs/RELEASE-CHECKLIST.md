# 1.0 release checklist

- [x] Run build and complete tests locally (67 passing); release commit must also pass CI.
- [x] Run `npm audit` and `npm audit --omit=dev` on the exact lockfile.
- [x] Inspect `npm pack --dry-run` and the resulting tarball for unintended files.
- [ ] Smoke-test the installed tarball in an isolated prefix and Vault.
- [x] Verify Chinese/English memory management and history in a local browser using synthetic data.
- [ ] Require CI on macOS, Windows, and Linux; Node 20, 22, and 24.
- [ ] Build and smoke-test the standalone Windows EXE on Windows.
- [x] Confirm package, embedded version, and release tag match.
- [ ] Publish the stable release only after required checks pass; record exact commit and artifact hashes.
- [ ] Report registry publication and installed runtime status separately; a prepared tarball is not an npm publication.

Scope: plaintext v1 Vault compatibility; encryption and secure erasure are deferred. No production Vault is used for validation. Real multi-device cloud sync and a manual Windows desktop session remain outside automated verification.
