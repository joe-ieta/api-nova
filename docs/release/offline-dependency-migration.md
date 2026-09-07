# Offline Dependency Migration

The integrated repository uses npm workspaces and the root package-lock.json. Its preinstall check rejects other package managers.

Follow the existing [offline development migration guide](../development/offline-dev-migration.md) and [package management policy](../guides/package-management-policy.md). Use the repository's offline-kit preparation script on the matching platform, then follow the generated kit instructions on the target machine.

Do not mix an old pnpm store or pnpm lockfile with this checkout. The source branch's machine-specific pnpm instructions are retained in [the archive](../archive/guides/offline-dependency-migration-pnpm.md).

Product packaging follows [RELEASE_STANDARD](../../RELEASE_STANDARD.md), including native platform validation and complete offline dependencies.
