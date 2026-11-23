# Releasing Drive-It

A release is a git tag on a commit on `main`. Nothing is bumped by hand: CI stamps the version from the tag.

## Cut a release

```sh
git fetch origin
git tag -a v0.2.0 origin/main -m "Drive-It 0.2.0"
git push origin v0.2.0
```

Watch **Actions › release**. When it finishes, the release is at `https://github.com/jedbjorn/drive-it/releases/tag/v0.2.0`, titled "Drive-It v0.2.0".

- `v<major>.<minor>.<patch>` (exactly `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`) is a **full release**. Only full releases can be pinned by RST's tray.
- `v<major>.<minor>.<patch>-<suffix>` (`v0.2.0-rc.1`) builds and publishes a GitHub **prerelease**. RST never installs a prerelease.
- Any other tag, a version past the MSI range (255.255.65535), or a tag on a commit that is not on `main` fails before anything is built.

## What a release contains

| Asset | What it is |
|---|---|
| `DriveIt-<version>.msi` | The per-user installer. Exactly one `.msi` per release. Its ProductVersion is the tag without `v` (the numeric part for a prerelease). |
| `DriveIt-<version>.zip` | The add-in and server bundle. |
| `SHA256SUMS.txt` | `sha256sum` output over every asset above, from the final (signed) bytes, verified with `sha256sum -c` before publishing. |

The release fails unless the MSI passes `installer/inspect-msi.ps1` and `test/msi.Tests.ps1` (the RST companion contract, see the README's Development section), its ProductVersion and ProductName read back from the file match the tag and `Drive-It`, and it is at most 450 MB (the contract limit is 512 MB).

## Code signing

On a pushed tag, `_build.yml` can Authenticode-sign the first-party `DriveIt.*.dll`/`.exe` before the zip and MSI pack them, then the MSI, with Azure Artifact Signing (description "Designs/OS Drive-It", SHA-256, RFC 3161 timestamp). The bundled Node.js and Python keep their vendors' signatures. `installer/verify-signatures.ps1` then requires every first-party binary and the MSI to be validly signed by AnJ Arch-Tech LLC and timestamped. Every other build is checked to be unsigned.

Signing is **off** until the operator turns it on. While it is off, a tag still releases, unsigned, and the release workflow warns that RST must not pin it. To turn it on, once, in the repository settings:

1. Create the environment `signing` (Settings › Environments), limited to tags `v*`.
2. Federate it with Azure: an Entra app registration with a federated credential for subject `repo:jedbjorn/drive-it:environment:signing`, holding the Artifact Signing Certificate Profile Signer role on the signing account (the same account and profile as the sibling companions).
3. Add these environment variables to `signing`: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SIGNING_ENDPOINT`, `SIGNING_ACCOUNT`, `SIGNING_PROFILE`. They are identifiers, not secrets; no secret is used.
4. Add the repository variable `SIGNING_ENABLED` = `true` (Settings › Secrets and variables › Actions › Variables).

The next pushed tag signs. To turn signing off again, delete `SIGNING_ENABLED` or set it to anything but `true`.

## Before RST pins a release

RST re-verifies the companion contract (C1-C7) on the downloaded asset before pinning (rst-c `companions/README.md`). Its pin needs the tag, the asset name, its `sha256` (from `SHA256SUMS.txt`), the UpgradeCode `6561188A-BD8D-43A9-B116-BA0894F8001B`, and the version. RST pins only a signed full release.
