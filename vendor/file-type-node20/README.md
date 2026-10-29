# file-type bounded ZIP compatibility for Node20

The reviewed upstream 21.3.4 tarball declares Node >=20, but its ZIP detector
constructs `DecompressionStream('deflate-raw')`, unavailable on Node20. This
local compatibility build retains that engine declaration and all upstream
security limits. It is not an official release or a downgrade.

The original Web decompressor remains preferred. Only on Node and only for its
unsupported-format error, the detector uses `node:zlib.inflateRaw` with the same
`maxOutputLength` before allocation completes. An overflow is translated to the
existing recoverable ZIP-size error. The `info` result must report that all
compressed bytes were consumed; trailing junk and a concatenated second stream
are non-recoverable errors, including under a generic ZIP MIME policy. Other
malformed compression errors still propagate through the original handler.
Browser behavior is unchanged; no global API is
patched and no install hook runs.

`provenance.json` pins the official SHA-512, original/patched core SHA-256 and
result archive SHA-256/SHA-512. The original MIT license and all other payload
files are retained. Rebuild with the official input in an isolated directory:

```text
node vendor/file-type-node20/build.cjs .tmp/file-type-node20/file-type-21.3.4.tgz /absolute/path/to/npm-cli.js
node vendor/file-type-node20/verify.cjs
```

Regression checks use the real Nest validator and core detector for PNG, valid
compressed Office XML, invalid ASF, and a bounded ZIP fixture that expands past
the 1 MiB detection budget. Both Node20 and Node24 must pass. This compatibility
fix does not relax MIME policy, output limits, or the declared Node baseline.
