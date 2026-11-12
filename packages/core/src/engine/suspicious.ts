/**
 * Obvious prompt-injection / command-execution patterns. Memory is loaded into every future session, so the
 * server refuses to store index lines and page bodies that look like planted instructions, and flags inbox
 * notes that do (they are still shown to the model, as untrusted data).
 */

const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, why: 'pipes a download into a shell (curl/wget … | sh)' },
  { re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i, why: 'pipes a download into Invoke-Expression' },
  { re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\*|\/\*)(?=\s|$|["'`;])/i, why: 'recursive delete of / or ~ (rm -rf /)' },
  { re: /\bignore\s+(?:all\s+)?(?:the\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)/i, why: '"ignore previous instructions"' },
  { re: /\byou\s+must\s+(?:now\s+|always\s+|first\s+)?(?:run|execute)\b/i, why: '"you must run …"' },
  { re: /<\s*script\b/i, why: 'a <script> tag' },
  { re: /[A-Za-z0-9+/]{200,}={0,2}/, why: 'a base64-like blob over 200 characters' },
];

/** Reasons `text` looks like an injected instruction or a dangerous command (empty when clean). */
export function suspiciousReasons(text: string): string[] {
  const out: string[] = [];
  for (const p of PATTERNS) if (p.re.test(text)) out.push(p.why);
  return out;
}
