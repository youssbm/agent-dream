/**
 * Secret redaction. Runs on every memory file before it is written, so precision matters as much as recall:
 * git commit ids, UUIDs, npm integrity hashes, ports, versions, paths and ordinary prose about "tokens" or
 * "passwords" must pass through untouched.
 *
 * Each secret is replaced with `[REDACTED:<kind>]`. For key/value assignments and URLs the key name / user
 * name is kept and only the value is replaced.
 */
import type { RedactionResult } from '../types.ts';

const MARK = (kind: string): string => `[REDACTED:${kind}]`;

interface Rule {
  kind: string;
  re: RegExp;
  /** Return the replacement for a match, or null to keep the original text. */
  replace?: (m: string[], kind: string) => string | null;
}

const hasDigit = (s: string): boolean => /\d/.test(s);
const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);

/** Ordered: specific token formats first, then header/URL forms, then generic assignments. */
const RULES: Rule[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g,
  },
  // The `sk-ant-` prefix is distinctive enough that even a truncated key is worth hiding.
  { kind: 'anthropic_key', re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'openai_key',
    re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g,
    // Real keys mix letters and digits; skips hyphenated prose such as "sk-something-like-this-example".
    replace: (m, kind) => {
      const body = (m[0] ?? '').slice(3);
      return hasDigit(body) && hasLetter(body) ? MARK(kind) : null;
    },
  },
  { kind: 'stripe_key', re: /(?<![A-Za-z0-9_])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'github_token', re: /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}(?![A-Za-z0-9_])/g },
  { kind: 'github_token', re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}(?![A-Za-z0-9_])/g },
  {
    kind: 'npm_token',
    re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
    replace: (m, kind) => (hasDigit((m[0] ?? '').slice(4)) ? MARK(kind) : null),
  },
  { kind: 'slack_token', re: /(?<![A-Za-z0-9_-])xox[abprse]-[A-Za-z0-9-]{10,}/g },
  {
    // GitLab personal/deploy/runner/trigger/feed/... tokens.
    kind: 'gitlab_token',
    re: /(?<![A-Za-z0-9_-])gl(?:pat|dt|rt|ptt|ft|imt|oas|cbt|soat|agent)-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: 'huggingface_token',
    re: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/g,
    replace: (m, kind) => {
      const body = (m[0] ?? '').slice(3);
      return hasDigit(body) && hasLetter(body) ? MARK(kind) : null;
    },
  },
  { kind: 'sendgrid_key', re: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  {
    // Discord bot token: base64(user id) . timestamp . hmac
    kind: 'discord_token',
    re: /(?<![A-Za-z0-9_.-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])/g,
    replace: (m, kind) => (hasDigit(m[0] ?? '') ? MARK(kind) : null),
  },
  { kind: 'twilio_key', re: /(?<![A-Za-z0-9_])SK[0-9a-f]{32}(?![A-Za-z0-9_])/g },
  { kind: 'databricks_token', re: /(?<![A-Za-z0-9_])dapi[0-9a-f]{32}(?:-\d+)?(?![A-Za-z0-9_])/g },
  { kind: 'digitalocean_token', re: /(?<![A-Za-z0-9_])do[opr]_v1_[0-9a-f]{64}(?![A-Za-z0-9_])/g },
  {
    kind: 'aws_access_key',
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  },
  { kind: 'google_api_key', re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  {
    kind: 'jwt',
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  },
  {
    // Authorization header (HTTP, curl -H, fetch headers objects): keep the header name and scheme.
    kind: 'bearer_token',
    re: /(authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic|token|digest)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (m, kind) => {
      const value = m[2] ?? '';
      if (value.startsWith('[REDACTED')) return null;
      return `${m[1] ?? ''}${MARK(kind)}`;
    },
  },
  {
    // Bare "Bearer <token>" outside a header: require a token-looking value (long, letters and digits).
    kind: 'bearer_token',
    re: /(\bbearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
    replace: (m, kind) => {
      const value = m[2] ?? '';
      if (!hasDigit(value) || !hasLetter(value)) return null;
      return `${m[1] ?? ''}${MARK(kind)}`;
    },
  },
  {
    // scheme://user:password@host — keep scheme and user, redact the password.
    kind: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@?#]+):([^\s/@?#]+)@/gi,
    replace: (m, kind) => {
      const password = m[3] ?? '';
      if (isPlaceholder(password)) return null;
      return `${m[1] ?? ''}${m[2] ?? ''}:${MARK(kind)}@`;
    },
  },
  {
    // `mysql -u root -pS3cret db`: the password is glued to `-p` (a bare `-p` prompts and is left alone).
    kind: 'password',
    re: /(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlsh|mariadb(?:-dump|-admin)?)(?![A-Za-z0-9_-])[^\r\n|;&]{0,200}?[ \t]-p)(?:(["'])([^"'\r\n]*)\2|([^\s"'`-][^\s"'`]*))/g,
    replace: (m, kind) => {
      const value = m[3] || m[4] || '';
      if (isPlaceholder(value)) return null;
      const q = m[2] ?? '';
      return `${m[1] ?? ''}${q}${MARK(kind)}${q}`;
    },
  },
  {
    // Prose: "the password is hunter2!" / "passphrase was: c0rrect-h0rse". Only token-looking values
    // (≥ 6 chars with a digit or symbol), so "the password is required" / "was sha256-hashed" stay.
    kind: 'password',
    re: /(\b(?:password|passwd|passphrase)\s+(?:is|was)(?:\s*:\s*|\s+))(["'`]?)([^\s"'`]+)\2/gi,
    replace: (m, kind) => {
      const raw = m[3] ?? '';
      const quote = m[2] ?? '';
      const trail = quote ? '' : (/[.,;:)\]}]+$/.exec(raw)?.[0] ?? '');
      const value = raw.slice(0, raw.length - trail.length);
      if (value.length < 6 || !(hasDigit(value) || /[^A-Za-z]/.test(value))) return null;
      if (isPlaceholder(value) || isCodeReference(value) || isPathLike(value) || value.includes('://')) return null;
      if (/^[A-Za-z]+\d*(?:-[A-Za-z]+\d*)+$/.test(value)) return null; // hyphenated words: "sha256-hashed"
      return `${m[1] ?? ''}${quote}${MARK(kind)}${quote}${trail}`;
    },
  },
];

/**
 * Key names whose value is a secret. Compared against the lowercased name with `_ - .` removed, as a suffix.
 * Strong names redact any non-placeholder value; weak names require a token-looking value.
 */
const STRONG_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'secretkey',
  'privatekey',
  'accesskey',
  'credential',
  'credentials',
];
const WEAK_SUFFIXES = ['key', 'auth'];
/** Names that end like a secret but are not secrets. */
const NAME_EXCEPTIONS = new Set(['publickey', 'pubkey', 'keyauth']);

type NameStrength = 'strong' | 'weak' | null;

function nameStrength(name: string): NameStrength {
  const flat = name.toLowerCase().replace(/[_.\-]/g, '');
  if (NAME_EXCEPTIONS.has(flat)) return null;
  if (STRONG_SUFFIXES.some((s) => flat.endsWith(s))) return 'strong';
  // "pass"/"pwd" only as a separate segment (DB_PASS, db.pwd) — never `PWD` (the shell's cwd) or "compass".
  if (/[_.\-](?:pass|pwd)$/i.test(name)) return 'strong';
  if (WEAK_SUFFIXES.some((s) => flat.endsWith(s))) return 'weak';
  return null;
}

const PLACEHOLDER_WORDS = new Set([
  '',
  'null',
  'none',
  'nil',
  'undefined',
  'true',
  'false',
  'yes',
  'no',
  'string',
  'str',
  'number',
  'int',
  'boolean',
  'bool',
  'any',
  'unknown',
  'object',
  'required',
  'optional',
  'redacted',
  'changeme',
  'example',
  'xxx',
  'todo',
  'tbd',
]);

/** Values that are clearly not secrets: empty, types, placeholders, variable references, masks. */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  if (v.startsWith('[REDACTED')) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return true; // $VAR / ${VAR}
  if (/^\$?\{\{/.test(v) || /^<[^<>]+>$/.test(v) || /^%[A-Za-z_]+%$/.test(v)) return true; // {{x}}, <x>, %X%
  if (/^[*x.•]{3,}$/i.test(v)) return true; // ***, xxxx, ...
  if (/^![A-Za-z]/.test(v) || /^[|>][-+]?$/.test(v)) return true; // YAML tags (!vault) and block scalars
  if (/^(?:your|replace)[-_ ]|[-_ ]here$/i.test(v)) return true; // your-api-key, replace_me, token-goes-here
  return false;
}

/** Values that are code expressions rather than literals: `req.body.password`, `getToken()`, `process.env.X`. */
function isCodeReference(value: string): boolean {
  const v = value.trim();
  if (/[()]/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+$/.test(v)) return true;
  if (/^(?:process\.env|os\.environ|env\.|import\.meta)/.test(v)) return true;
  return false;
}

function isPathLike(value: string): boolean {
  return /^(?:\/|~\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * A value that looks like a generated credential: long-ish, no spaces, letters and digits.
 * UUIDs and git commit ids are identifiers, not credentials, under weak names like `idempotencyKey`.
 */
function looksLikeToken(value: string): boolean {
  if (UUID.test(value) || GIT_SHA.test(value)) return false;
  return value.length >= 16 && !/\s/.test(value) && hasDigit(value) && hasLetter(value);
}

/**
 * Generic assignments: `NAME=value`, `NAME = "value"`, `export NAME=value`, `name: value` (YAML),
 * `"name": "value"` (JSON), `--name=value` (CLI), `?name=value` (query string).
 *   1: opening quote of the name   2: name   3: operator   4: quote of value   5: quoted value   6: unquoted value
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.])(?<![A-Za-z0-9_.]-)(["']?)([A-Za-z_][A-Za-z0-9_.\-]*)\1(\s*(?:=(?![=>~])|:(?![:\/=]))[ \t]*)(?:(["'])([^"'\r\n]*)\4|([^\s"'`,;)}\]&<>]+))/g;

function redactAssignments(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(
    ASSIGNMENT,
    (whole: string, q1: string, name: string, op: string, q2: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const strength = nameStrength(name);
      if (!strength) return whole;
      const isQuoted = quoted !== undefined;
      const value = (isQuoted ? quoted : bare) ?? '';
      if (isPlaceholder(value) || isPathLike(value)) return whole;
      if (/^\d{1,5}$/.test(value)) return whole; // ports, TTLs, lengths
      if (!isQuoted && isCodeReference(value)) return whole;
      if (/^\s*$/.test(value)) return whole;

      const isColon = op.trim().startsWith(':');
      let redactIt: boolean;
      if (strength === 'weak') {
        redactIt = looksLikeToken(value);
      } else if (isQuoted || !isColon) {
        // Quoted: `password: "hunter2"`, `TOKEN="correct horse"`.
        // `PASSWORD=hunter2`, `--token=abc`, `?password=x`
        redactIt = true;
      } else {
        // `password: hunter2` (YAML) vs prose/type annotations like `Password: see vault`, `token: string`.
        redactIt = value.length >= 16 || (value.length >= 6 && (hasDigit(value) || /[^A-Za-z]/.test(value)));
      }
      if (!redactIt) return whole;
      count++;
      const q = q2 ?? '';
      return `${q1}${name}${q1}${op}${q}${MARK('secret')}${q}`;
    },
  );
  return { text: out, count };
}

/**
 * Replace secrets in `text` with `[REDACTED:<kind>]` markers. Kinds: private_key, anthropic_key, openai_key,
 * stripe_key, github_token, npm_token, slack_token, gitlab_token, huggingface_token, sendgrid_key,
 * discord_token, twilio_key, databricks_token, digitalocean_token, aws_access_key, google_api_key, jwt,
 * bearer_token, url_credentials, password (`mysql -p…`, "the password is …"), secret (generic
 * KEY/SECRET/TOKEN/PASSWORD assignments).
 *
 * Idempotent: redacting already-redacted text changes nothing and counts 0.
 */
export function redact(text: string): RedactionResult {
  let current = text;
  let count = 0;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    current = current.replace(rule.re, (...args: unknown[]) => {
      // args: match, ...capture groups, offset, input (no rule uses named groups).
      const m = [String(args[0]), ...args.slice(1, -2).map((g) => (typeof g === 'string' ? g : ''))];
      const replacement = rule.replace ? rule.replace(m, rule.kind) : MARK(rule.kind);
      if (replacement === null) return m[0] ?? '';
      count++;
      return replacement;
    });
  }
  const assigned = redactAssignments(current);
  return { text: assigned.text, count: count + assigned.count };
}
