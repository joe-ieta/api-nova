import { Buffer } from 'node:buffer';
import { JSON_SCHEMA, load } from 'js-yaml';
import {
  UpstreamCredentialValidationError,
  validateUpstreamCredentialBindings,
} from './schema';
import type { UpstreamCredentialBindingsCandidate } from './types';

export type UpstreamCredentialTextFormat = 'json' | 'yaml';
export type UpstreamCredentialTextErrorCode =
  | 'INVALID_TEXT_INPUT'
  | 'INVALID_TEXT_FORMAT'
  | 'INVALID_TEXT_SYNTAX'
  | 'UNSUPPORTED_YAML_SYNTAX';

export class UpstreamCredentialTextError extends Error {
  constructor(readonly code: UpstreamCredentialTextErrorCode) {
    super(code);
    this.name = 'UpstreamCredentialTextError';
  }
}

export const UPSTREAM_CREDENTIAL_TEXT_LIMITS = Object.freeze({
  maxUtf8Bytes: 1048576,
  // Parser events include mapping keys and speculative mapping nodes.
  // The schema independently enforces its stricter structural limits.
  maxParseDepth: 32,
  maxParseNodes: 60000,
});

/**
 * Pure, synchronous text-to-candidate conversion. Format is never inferred.
 *
 * YAML intentionally supports only a conservative subset: raw !, & and *
 * are forbidden everywhere, even inside quotes or comments. Directives are
 * forbidden too. This excludes tags, anchors and aliases before parsing,
 * rather than depending on undocumented js-yaml alias-expansion controls.
 * Use JSON when a literal string needs one of these characters.
 *
 * js-yaml JSON_SCHEMA excludes merge/timestamp/custom constructors; json:false
 * rejects duplicate mapping keys and load rejects multiple documents. JSON
 * additionally passes JSON.parse so YAML-only syntax is not accepted as JSON.
 * Parser exceptions, marks, input fragments and causes are never exposed.
 *
 * No file, environment, network, provider, asset or activation operations.
 * The resulting independent deep-frozen candidate is produced by the schema.
 */
export function parseUpstreamCredentialBindings(
  text: string,
  format: UpstreamCredentialTextFormat,
): UpstreamCredentialBindingsCandidate {
  try {
    if (typeof text !== 'string') throw new UpstreamCredentialTextError('INVALID_TEXT_INPUT');
    if (format !== 'json' && format !== 'yaml') {
      throw new UpstreamCredentialTextError('INVALID_TEXT_FORMAT');
    }
    if (text.length > UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxUtf8Bytes ||
      Buffer.byteLength(text, 'utf8') > UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxUtf8Bytes) {
      throw new UpstreamCredentialValidationError('INPUT_LIMIT_EXCEEDED');
    }
    // Reject malformed UTF-16 instead of measuring replacement characters as
    // though the caller supplied valid UTF-8 text.
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new UpstreamCredentialTextError('INVALID_TEXT_INPUT');
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new UpstreamCredentialTextError('INVALID_TEXT_INPUT');
      }
    }

    let jsonValue: unknown;
    if (format === 'json') {
      // Native JSON parsing cannot create aliases or invoke custom constructors.
      // Its input allocation is bounded above; duplicate detection follows below.
      jsonValue = JSON.parse(text) as unknown;
    } else if (/[!&*]/.test(text) || /^[\t \uFEFF]*%/m.test(text)) {
      throw new UpstreamCredentialTextError('UNSUPPORTED_YAML_SYNTAX');
    }

    let depth = 0;
    let nodes = 0;
    const parsed = load(text, {
      schema: JSON_SCHEMA,
      json: false,
      onWarning: () => { throw new UpstreamCredentialTextError('INVALID_TEXT_SYNTAX'); },
      listener: (event, state) => {
        if (event === 'open') {
          if (++depth > UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxParseDepth ||
            ++nodes > UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxParseNodes) {
            throw new UpstreamCredentialValidationError('INPUT_LIMIT_EXCEEDED');
          }
        } else {
          depth--;
          // Reject dangerous keys before a completed child is attached to its
          // parent. The schema repeats this check on the full candidate.
          const value: unknown = state.result;
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const key of Object.keys(value)) {
              if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key === '<<') {
                throw new UpstreamCredentialValidationError('UNSAFE_OBJECT');
              }
            }
          }
        }
      },
    });
    return validateUpstreamCredentialBindings(format === 'json' ? jsonValue : parsed);
  } catch (error) {
    if (error instanceof UpstreamCredentialValidationError || error instanceof UpstreamCredentialTextError) {
      throw error;
    }
    throw new UpstreamCredentialTextError('INVALID_TEXT_SYNTAX');
  }
}
