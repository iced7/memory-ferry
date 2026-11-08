# Release checklist

## npm publication and cross-device updates

- Verify the publishing account with `npm whoami --registry=https://registry.npmjs.org/`; use `npm login --auth-type=web` if the session expired. Complete the registry's requested authentication; never disable 2FA to publish.
- Check ownership and existing versions with `npm view memory-ferry maintainers versions dist-tags --json`. Never replace an already-published version.
- Publish the verified GitHub release tarball, not an unbuilt working directory: `npm publish /path/to/memory-ferry-<version>.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/`. Use `--tag beta` for prereleases.
- Verify `npm view memory-ferry@latest version dist.integrity --json`, compare the downloaded registry tarball with the release artifact, and test installation into a clean temporary prefix.
- On another device use `npm install -g memory-ferry@latest`, check `memory-ferry --version`, then restart the dashboard and Agent MCP connections. Do not initialize or migrate a Vault as part of a package update.
- GitHub release creation and npm publication are separate steps. The current GitHub release workflow does not automatically publish to npm; report both outcomes separately.

## Historical 1.0 acceptance checklist

- [x] Run build and complete tests locally (67 passing); release commit must also pass CI.
- [x] Run `npm audit` and `npm audit --omit=dev` on the exact lockfile.
- [x] Inspect `npm pack --dry-run` and the resulting tarball for unintended files.
- [x] Smoke-test the installed tarball in an isolated prefix and Vault.
- [x] Verify Chinese/English memory management and history in a local browser using synthetic data.
- [ ] Require CI on macOS, Windows, and Linux; Node 20, 22, and 24.
- [ ] Build and smoke-test the standalone Windows EXE on Windows.
- [x] Confirm package, embedded version, and release tag match.
- [ ] Publish the stable release only after required checks pass; record exact commit and artifact hashes.
- [ ] Report registry publication and installed runtime status separately; a prepared tarball is not an npm publication.

Scope: plaintext v1 Vault compatibility; encryption and secure erasure are deferred. No production Vault is used for validation. Real multi-device cloud sync and a manual Windows desktop session remain outside automated verification.
