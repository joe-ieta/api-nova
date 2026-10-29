# Vue I18n security backport for the Node 20 baseline

This is a local, audited backport, not an official Vue I18n release or a migration
to Vue I18n 11. The application continues to use the 9.14.5 Composition API.
The official 11.4.16 packages require Node >=22. The original 9.14.5 packages
declare Node >=16; their engine declarations and the product Node >=20.0.0 / npm
>=10 baseline are unchanged. Do not use `--ignore-engines` or relax upstream
engine declarations to claim that the official v11 packages support Node 20.

## Sources and scope

- Base: official registry `vue-i18n`, `@intlify/shared`, and `@intlify/core-base`
  9.14.5 tarballs. Package names, versions, public types, dependency ranges,
  licenses, and original copyright notices are retained.
- Donor: official `@intlify/shared` and `@intlify/core-base` 11.4.16 tarballs.
  The complete production `sanitizeTranslatedHtml` implementation, including
  URL normalization and attribute helpers, is copied into every bundled 9.14.5
  implementation. The official `escapeParams` change is adapted using equivalent
  built-in type checks and a local copy of the official `escapeHtml` helper.
- [GHSA-83rm-6c8r-g728](https://github.com/intlify/vue-i18n/security/advisories/GHSA-83rm-6c8r-g728):
  neutralize the attribute name `srcdoc`, not just its entity-decoded contents.
  [Official fix](https://github.com/intlify/vue-i18n/commit/43391d20e7c85403cb59bdb21b5d542819f54042).
- [GHSA-8rc2-428q-7ww3](https://github.com/intlify/vue-i18n/security/advisories/GHSA-8rc2-428q-7ww3):
  independently escape both named and list parameters; create a fresh named
  object instead of mutating caller input.
  [Official fix](https://github.com/intlify/vue-i18n/pull/2680).
- The donor's sanitizer also retains its quoted/unquoted and encoded JavaScript
  URL handling. No HTML capability is added to application message rendering.

There are 20 patched files: five shared, seven core, and eight full/runtime Vue
browser/global entries. The three minified global production entries inline the
sanitizer; the builder replaces only that expression, preserving the surrounding
translation function. Other entry points delegate to these patched modules.
There is no postinstall hook, runtime monkey patch, or disabled security check.

`provenance.json` records all original input SHA-512 values, donor fragment
SHA-256 values, each changed file before/after SHA-256, and resulting archive
SHA-256/SHA-512. Each archive includes the original MIT LICENSE. The original
package version is deliberately preserved: registry audit may still flag
9.14.5. A raw audit warning is not silently erased or relabelled as an official
upgrade. This is limited mitigation for the identified advisories; retain the
future official-major migration item and reassess any new advisory.

## Rebuild

From the repository root, use an isolated directory and the pinned npm 10.9.2:

```text
npm pack vue-i18n@9.14.5 @intlify/shared@9.14.5 @intlify/core-base@9.14.5 @intlify/shared@11.4.16 @intlify/core-base@11.4.16 --ignore-scripts --pack-destination=.tmp/vue-i18n-candidate
node vendor/i18n-node20/build-backport.cjs .tmp/vue-i18n-candidate /absolute/path/to/npm-cli.js
node vendor/i18n-node20/build-backport.cjs .tmp/vue-i18n-candidate /absolute/path/to/npm-cli.js --check
```

The build uses the existing TypeScript parser and `tar`, verifies all input
tarballs before extraction, patches every bundled implementation, validates
JavaScript parsing and expected coverage, and packs the local archives. It
never installs into node_modules. `--check` repacks into an isolated temporary
directory and compares existing archive tar payloads/provenance without overwriting
them. It verifies all tar bytes, including file content, paths, modes, order and
dates. Node 20 and 24 use different zlib versions, so gzip bytes can differ despite
identical tar payloads; the result reports `identicalGzipBytes`. Reviewed archive
hashes must still match `provenance.json` exactly; no lock or archive is rewritten
to hide a changed input or payload. The checked-in archives were packed using
Node 24.22.1 and npm 10.9.2.

## Integration and verification

The UI manifest references the Vue tarball. The root dependency overrides must
also resolve `@intlify/shared` and `@intlify/core-base` to the two local tarballs;
otherwise same-version registry modules could be retained. The lock must record
all three file resolutions and integrity values. A clean root installation is
performed by the integration owner. Do not patch a shared node_modules tree.

The UI `prebuild` runs `verify.cjs` against all three reviewed archive hashes,
their installed patch metadata/engines, and the hashes of all 20 patched entries.
An unpatched same-version installation fails before Vite can build it. Release
gates and the Node20/24 database matrix also execute the security compatibility
regressions; vendor changes are included in the CI path filters.

```text
node --test packages/api-nova-ui/scripts/test-i18n-security-compat.cjs
```

`I18N_PACKAGE_ROOT` optionally points at an isolated package directory for
candidate validation. Tests verify actual resolved bytes before exercising each
entry, both disclosed exploits, immutable/reused parameters, obfuscated URLs,
event handlers, pluralization, all actual zh-CN/en-US messages, locale preference
and fallback, and Vue server-rendered text escaping. The current source contains
1963 merged message leaves per locale. This is runtime/compiler/SSR coverage,
not a claim of completed manual browser acceptance.

Validated with actual Node 20.0.0 and `npm install --engine-strict` in an isolated
directory, followed by direct Node test execution (24/24). npm 10.9.2 itself
warns on Node 20.0.0 because its CLI requires >=20.5.0 on the 20.x line; this is a
pre-existing tool constraint, not a newly raised product baseline. No engine
ignore option is used.
