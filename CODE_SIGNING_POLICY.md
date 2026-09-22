# ToolKnit Code Signing Policy

## Current status

ToolKnit has been provisioned with a SignPath project and a valid test-signing policy under the SignPath Foundation open-source program. As of September 22, 2026, the production certificate is still pending; production signing is not yet operational.

ToolKnit Desktop 2.1.1 is **not** signed through SignPath. Its release integrity is verified with the SHA-256 checksum published alongside the installer.

## Signing service and scope

After approval, official Windows release artifacts will be built from the public [ToolKnit repository](https://github.com/ZihangDong/toolknit-desktop) by GitHub Actions and submitted to [SignPath.io](https://signpath.io/) under the [SignPath Foundation](https://signpath.org/) open-source program.

SignPath Foundation will sponsor the code-signing certificate, and SignPath.io will perform signing. Private signing keys will remain in the signing service and will not be stored in this repository, GitHub Actions secrets, or on a maintainer device.

Only production release artifacts that meet all of the following conditions may be submitted for release signing:

- The release tag is reachable from the protected `main` branch.
- Required build, test, security, and version checks have passed.
- The artifact was produced by the repository's documented GitHub Actions workflow.
- The signing request can be traced to its source commit and workflow run.

## Project roles

| Role | Assigned account | Responsibility |
| --- | --- | --- |
| Committer | [ZihangDong](https://github.com/ZihangDong) | Maintains source code, build definitions, tests, and release metadata. |
| Reviewer | [ZihangDong](https://github.com/ZihangDong) | Reviews the release diff, dependency and security results, and required CI checks before a signing request is created. |
| Approver | [ZihangDong](https://github.com/ZihangDong) | Confirms artifact provenance and explicitly approves or rejects each release signing request. |

Production signing approval is never automatic. A failed, untraceable, locally built, or otherwise non-compliant release artifact must be rejected.

## Test signing

The separate [Test signing workflow](.github/workflows/test-signing.yml) builds the V3 branch on a GitHub-hosted Windows runner and submits only to `test-signing`. The test policy currently completes requests without manual approval. Its API token is stored only in the repository's `SIGNPATH_API_TOKEN` Actions secret.

This initial integration signs the outer NSIS installer as a Portable Executable using the project's default artifact configuration. It does not sign the embedded application or third-party executables. The signed installer, SHA-256 checksum, cryptographic verification report and source/build provenance are retained as temporary workflow artifacts. The verifier checks the CMS signature, the SHA-256 Authenticode digest, the pinned test certificate and that the installer payload is unchanged. Windows may report the self-signed test certificate as `UnknownError`; only the specific untrusted-root error is accepted, with an exact certificate fingerprint and a chain containing no other errors. The actual Windows status and chain result are recorded explicitly. It never installs a trusted root on the runner or a maintainer's computer.

Test signing does not create a GitHub Release, update `main`, or publish an installer to users. Test certificates are not publicly trusted and must not be described as production signing. A successful test does not itself confirm that a production certificate has been issued.

To run the initial integration, configure the CI user's API token in the Actions secret, then push the workflow to the V3 branch. Later runs can rerun the existing workflow; manual dispatch is also defined for when GitHub exposes the workflow from the default branch. No production tag is needed. Details are in the [test-signing guide](toolknit-desktop/docs/SIGNPATH_TEST_SIGNING.zh-CN.md).

## Release handling

Once the SignPath workflow is active, signed installers will be published only after the signing result and artifact identity have been verified. Release notes will state whether an artifact is signed, and SHA-256 checksums will continue to be published.

## Privacy and security

Code signing processes release artifacts and build metadata only. ToolKnit user files, tool inputs, passwords, API keys, and application usage data are never part of a signing request.

- ToolKnit privacy statement: [https://toolknit.com/privacy.html](https://toolknit.com/privacy.html)
- SignPath privacy policy: [https://signpath.io/privacy-policy](https://signpath.io/privacy-policy)
- Security reporting: [SECURITY.md](toolknit-desktop/SECURITY.md)

Suspected certificate misuse, compromised release infrastructure, or unauthorized signed artifacts must be reported immediately through the security contact documented in `SECURITY.md`. Affected releases will be withdrawn while the incident is investigated with SignPath Foundation and SignPath.io.
