import { describe, expect, it } from 'vitest';
import { redact } from '../../src/quality/redact.ts';

// All secrets below are synthetic: random-looking strings built for these tests, not real credentials.
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const GH_PAT = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123';
const ANT = 'sk-ant-api03-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe-AbCdEf';
const OPENAI = 'sk-proj-' + 'abc123DEF456ghi789JKL012mno345';
const OPENAI_LEGACY = 'sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPL3';
const GOOGLE = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const SLACK = 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QifQ' +
  '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const STRIPE = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const NPM = 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const GLPAT = 'glpat-' + 'AbCdEf1234567890xyzW';
const GLDT = 'gldt-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm';
const GLRT = 'glrt-' + 'q1W2e3R4t5Y6u7I8o9P0a';
const HF = 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345678';
const SENDGRID = 'SG.' + 'abcdefghij0123456789uv' + '.' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk012345';
const DISCORD = 'MTk4NjIyNDgzNDcxOTI1MjQ4' + '.Cl2FMQ.' + 'ZnCjm1XVW7vRze4b7Cq4se7kKWs';
const TWILIO = 'SK' + '0123456789abcdef0123456789abcdef';
const DATABRICKS = 'dapi' + 'fedcba9876543210fedcba9876543210';
const DIGITALOCEAN = 'dop_v1_' + '0123456789abcdef'.repeat(4);
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

interface Case {
  name: string;
  input: string;
  /** Substring that must be gone after redaction. */
  secret: string;
  /** Expected marker kind. */
  kind: string;
  /** Substrings that must survive (e.g. the key name). */
  keep?: string[];
}

const POSITIVES: Case[] = [
  { name: 'github classic token', input: `export GH=${GHP}`, secret: GHP, kind: 'github_token' },
  { name: 'github fine-grained pat', input: `token ${GH_PAT} used`, secret: GH_PAT, kind: 'github_token' },
  { name: 'anthropic key', input: `key is ${ANT}.`, secret: ANT, kind: 'anthropic_key' },
  { name: 'openai project key', input: `"${OPENAI}"`, secret: OPENAI, kind: 'openai_key' },
  { name: 'openai legacy key', input: `use ${OPENAI_LEGACY} here`, secret: OPENAI_LEGACY, kind: 'openai_key' },
  { name: 'aws access key id', input: `aws_access_key_id = ${AWS}`, secret: AWS, kind: 'aws_access_key' },
  { name: 'google api key', input: `maps key ${GOOGLE} in config`, secret: GOOGLE, kind: 'google_api_key' },
  { name: 'slack bot token', input: `SLACK=${SLACK}`, secret: SLACK, kind: 'slack_token' },
  { name: 'jwt', input: `cookie: session=${JWT}; Path=/`, secret: JWT, kind: 'jwt' },
  { name: 'stripe live key', input: `stripe ${STRIPE}`, secret: STRIPE, kind: 'stripe_key' },
  { name: 'npm token', input: `//registry.npmjs.org/:_authToken=${NPM}`, secret: NPM, kind: 'npm_token' },
  { name: 'private key block', input: `before\n${PEM}\nafter`, secret: 'MIIBOgIBAAJBAKj34', kind: 'private_key', keep: ['before', 'after'] },
  {
    name: 'authorization bearer header',
    input: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://api.example.test',
    secret: 'abcdefghijklmnop1234',
    kind: 'bearer_token',
    keep: ['Authorization: Bearer ', 'https://api.example.test'],
  },
  {
    name: 'authorization basic header',
    input: 'Authorization: Basic dXNlcjpodW50ZXIyMjI=',
    secret: 'dXNlcjpodW50ZXIyMjI=',
    kind: 'bearer_token',
  },
  {
    name: 'url with credentials',
    input: 'DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app',
    secret: 's3cr3tP4ss',
    kind: 'url_credentials',
    keep: ['postgres://admin:', '@db.internal:5432/app'],
  },
  { name: 'env PASSWORD', input: 'DB_PASSWORD=hunter2', secret: 'hunter2', kind: 'secret', keep: ['DB_PASSWORD='] },
  { name: 'env SECRET quoted', input: 'JWT_SECRET="my super secret value"', secret: 'my super secret value', kind: 'secret', keep: ['JWT_SECRET="'] },
  { name: 'export TOKEN', input: 'export API_TOKEN=abc123xyz', secret: 'abc123xyz', kind: 'secret', keep: ['export API_TOKEN='] },
  { name: 'yaml password', input: 'database:\n  password: Tr0ub4dor&3\n', secret: 'Tr0ub4dor&3', kind: 'secret', keep: ['password: '] },
  { name: 'json client secret', input: '{"clientSecret": "q8w7e6r5t4y3"}', secret: 'q8w7e6r5t4y3', kind: 'secret', keep: ['"clientSecret": "'] },
  { name: 'cli flag', input: 'mysql --password=letmein99 -u root', secret: 'letmein99', kind: 'secret', keep: ['--password=', '-u root'] },
  {
    name: 'weak KEY name with token-like value',
    input: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY',
    secret: 'wJalrXUtnFEMI',
    kind: 'secret',
  },
  { name: 'ENCRYPTION_KEY value', input: 'ENCRYPTION_KEY=9f8e7d6c5b4a39281706f5e4', secret: '9f8e7d6c5b4a39281706f5e4', kind: 'secret' },
  { name: 'db_pass segment', input: 'db_pass = "pa55word"', secret: 'pa55word', kind: 'secret' },
  {
    name: 'docker -e password',
    input: 'docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16',
    secret: '=postgres ',
    kind: 'secret',
    keep: ['-p 5432:5432 postgres:16'],
  },
  { name: 'api key header', input: 'X-Api-Key: 8f14e45fceea167a5a36dedd4bea2543abcd', secret: '8f14e45f', kind: 'secret' },
  {
    name: 'mongodb+srv url credentials',
    input: 'mongodb+srv://user:p%40ss123@cluster0.example.net/db',
    secret: 'p%40ss123',
    kind: 'url_credentials',
  },
  // Coverage added after the security review (P9).
  { name: 'gitlab pat in assignment', input: `GITLAB=${GLPAT}`, secret: GLPAT, kind: 'gitlab_token', keep: ['GITLAB='] },
  { name: 'gitlab pat in prose', input: `gitlab token ${GLPAT} expires`, secret: GLPAT, kind: 'gitlab_token' },
  { name: 'gitlab deploy token', input: `deploy with ${GLDT}`, secret: GLDT, kind: 'gitlab_token' },
  { name: 'gitlab runner token', input: `runner registered: ${GLRT}`, secret: GLRT, kind: 'gitlab_token' },
  { name: 'hugging face token', input: `huggingface-cli login --token ${HF}`, secret: HF, kind: 'huggingface_token' },
  { name: 'sendgrid key', input: `SENDGRID=${SENDGRID}`, secret: SENDGRID, kind: 'sendgrid_key' },
  { name: 'discord bot token', input: `DISCORD_BOT=${DISCORD}`, secret: DISCORD, kind: 'discord_token' },
  { name: 'twilio api key', input: `twilio key ${TWILIO} for sms`, secret: TWILIO, kind: 'twilio_key' },
  { name: 'databricks token', input: `databricks token ${DATABRICKS}`, secret: DATABRICKS, kind: 'databricks_token' },
  { name: 'digitalocean token', input: `doctl auth init -t ${DIGITALOCEAN}`, secret: DIGITALOCEAN, kind: 'digitalocean_token' },
  {
    name: 'mysql -p<password>',
    input: 'mysql -u root -pS3cretPassw0rd db',
    secret: 'S3cretPassw0rd',
    kind: 'password',
    keep: ['mysql -u root -p', ' db'],
  },
  {
    name: 'mysqldump -p quoted password',
    input: "mysqldump -uroot -p'p@ss w0rd' app > dump.sql",
    secret: 'p@ss w0rd',
    kind: 'password',
    keep: ["-p'", "' app > dump.sql"],
  },
  { name: 'PGPASSWORD env prefix', input: 'PGPASSWORD=s3cret psql -h db -U app', secret: 's3cret', kind: 'secret', keep: ['psql -h db -U app'] },
  {
    name: 'psql connection url',
    input: 'psql postgresql://admin:S3cr3tPw@db.example:5432/app',
    secret: 'S3cr3tPw',
    kind: 'url_credentials',
  },
  { name: 'prose: password is', input: 'the password is hunter2!', secret: 'hunter2', kind: 'password', keep: ['the password is '] },
  {
    name: 'prose: password was quoted, sentence end kept',
    input: 'The password was "Tr0ub4dor&3".',
    secret: 'Tr0ub4dor&3',
    kind: 'password',
    keep: ['The password was "', '".'],
  },
  { name: 'prose: passphrase is with colon', input: 'passphrase is: c0rrect-h0rse!.', secret: 'c0rrect-h0rse', kind: 'password', keep: ['passphrase is: ', '].'] },
  {
    name: 'azure connection string AccountKey',
    input: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd==;EndpointSuffix=core.windows.net',
    secret: 'abcdEFGH1234',
    kind: 'secret',
    keep: ['AccountName=x;', 'EndpointSuffix=core.windows.net'],
  },
  { name: 'truncated anthropic key', input: 'sk-ant-api03-short', secret: 'api03-short', kind: 'anthropic_key' },
];

const NEGATIVES: { name: string; input: string }[] = [
  { name: 'git sha in log', input: 'commit 3f786850e387550fdab836ed7e6dc881de23001b\nAuthor: Dev <dev@example.com>' },
  { name: 'git sha in prose', input: 'Fixed in a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 (see PR).' },
  { name: 'sha key in yaml', input: 'sha: da39a3ee5e6b4b0d3255bfef95601890afd80709' },
  { name: 'uuid', input: 'session 550e8400-e29b-41d4-a716-446655440000 started' },
  { name: 'uuid as id field', input: '"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"' },
  { name: 'npm integrity hash', input: '"integrity": "sha512-Sh8ZQ4jRk1xUOVKhNbz7xZ6F2uKRz8MGt4m8dXfJuQ2CiGcXvGq1Wp1vbP8qkqT5w7UoJvR9cZy0KX7HZbF0vQ=="' },
  { name: 'the word token in prose', input: 'The token is refreshed by the auth middleware before it expires.' },
  { name: 'password reset flow', input: 'We fixed the password reset flow; users get an email link.' },
  { name: 'prose with colon', input: 'Password: see the team vault.\nToken: none needed locally.' },
  { name: 'typescript annotations', input: 'interface Auth { token: string; password?: string; apiKey: string }' },
  { name: 'code references', input: 'const token = getToken();\nconst password = req.body.password;\nif (token === null) return;' },
  { name: 'env placeholders', input: 'API_TOKEN=${API_TOKEN}\nDB_PASSWORD=<your password>\nSECRET=changeme\nGITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}' },
  { name: 'ports and urls', input: 'dev server listening on :5173 — open http://localhost:5173/app and ssh://git@github.com/org/repo' },
  { name: 'semver', input: 'upgrade typescript to 5.9.3 and vitest@4.0.1 (node >=22.13.0)' },
  { name: 'file paths', input: 'edit src/auth/token.ts and C:\\Users\\dev\\secrets\\README.md; PWD=/home/dev/project' },
  { name: 'numeric settings', input: 'TOKEN_TTL=3600\nmax_tokens=4096\nPASSWORD_MIN_LENGTH=12' },
  { name: 'base64-free prose with long words', input: 'Internationalization and characterization of counterrevolutionaries.' },
  { name: 'bearer in prose', input: 'Use bearer authentication for the internal API; Bearer tokens are documented.' },
  { name: 'hyphenated sk- word', input: 'the task-sk-runner and risk-assessment-framework-for-teams-v2 docs' },
  { name: 'email addresses', input: 'contact dev@example.com or ops+alerts@example.org' },
  { name: 'sort key without entropy', input: 'sort_key = "created_at"\nprimary_key: id\npublic_key=ssh-ed25519AAAAC3NzaC1lZDI1NTE5AAAAI' },
  { name: 'comparison operators', input: 'if (password == confirm && token != prev) ok = password !== "";' },
  { name: 'aws-like but too short', input: 'AKIA1234 is not a key, nor is AKIAEXAMPLE.' },
  { name: 'markdown code with redacted marker', input: 'API_KEY=[REDACTED:secret]' },
  { name: 'uuid under a weak key name', input: 'idempotencyKey: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"' },
  { name: 'yaml tag and block scalar', input: 'secret: !vault |\ntoken: >' },
  { name: 'compound key names', input: 'cache_key: user:42:profile\nresetPasswordToken: string | null\nTOKEN: The Lexer emits a TOKEN' },
  { name: 'npm error text', input: 'npm ERR! code E401 Incorrect or missing password.' },
  { name: 'prefixed hash', input: 'hash: sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
  // Negatives for the rules added after the security review (P9).
  { name: 'hf_ inside identifiers', input: 'check shelf_life, call hf_hub_download() and set HF_HOME=/data/hf' },
  { name: 'SG. in prose', input: 'Signed: SG. Smith, Dr. SG. Jones and the SG.team channel.' },
  { name: 'gl- words', input: 'use glpat-style tokens; see the gldt- docs and glrt-runner notes' },
  { name: 'mysql bare -p prompts', input: 'mysql -u root -p app\nmysql -h db -P 3306 -u app -p' },
  { name: '-p on a non-mysql command', input: 'mkdir -pv build && docker run -p8080:80 nginx && ssh -p2222 host' },
  { name: 'prose: password is <word>', input: 'The password is required. The password was reset. The password is too short.' },
  { name: 'prose: password is hashed', input: 'the password was sha256-hashed and the password is bcrypt-hashed' },
  { name: 'prose: password is placeholder/path', input: 'the password is ${DB_PASSWORD}; the passphrase is ~/.ssh/key.txt' },
  { name: 'prose: password is in a tool', input: 'the password is in 1Password.' },
  { name: 'dotted identifiers', input: 'Object.prototype.hasOwnProperty.call(x, y) and NODE_OPTIONS.max.old' },
  { name: 'SK-prefixed words', input: 'SKIP_TESTS=1 and SKU 12345 and SK-1234' },
];

describe('redact — positives', () => {
  it('has at least 15 positive cases', () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(15);
  });
  it.each(POSITIVES)('$name', ({ input, secret, kind, keep }) => {
    const r = redact(input);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain(`[REDACTED:${kind}]`);
    expect(r.count).toBeGreaterThanOrEqual(1);
    for (const k of keep ?? []) expect(r.text).toContain(k);
  });
});

describe('redact — negatives (must not change)', () => {
  it('has at least 15 negative cases', () => {
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(15);
  });
  it.each(NEGATIVES)('$name', ({ input }) => {
    const r = redact(input);
    expect(r.text).toBe(input);
    expect(r.count).toBe(0);
  });
});

describe('redact — behaviour', () => {
  it('counts every replaced secret', () => {
    const r = redact(`a ${GHP} b ${AWS} c DB_PASSWORD=hunter2`);
    expect(r.count).toBe(3);
  });

  it('is idempotent', () => {
    const once = redact(`x ${OPENAI} y\nSECRET_KEY=abcd1234efgh5678\n${PEM}`);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it('is idempotent for every positive case', () => {
    for (const { input } of POSITIVES) {
      const once = redact(input);
      const twice = redact(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(twice.count, input).toBe(0);
    }
  });

  it('does not double-redact a key inside an assignment', () => {
    const r = redact(`OPENAI_API_KEY=${OPENAI}`);
    expect(r.text).toBe('OPENAI_API_KEY=[REDACTED:openai_key]');
    expect(r.count).toBe(1);
  });

  it('keeps surrounding markdown and CRLF line endings', () => {
    const input = '# Setup\r\n\r\nRun `npm test`.\r\nDB_PASSWORD=hunter2\r\nDone.\r\n';
    const r = redact(input);
    expect(r.text).toBe('# Setup\r\n\r\nRun `npm test`.\r\nDB_PASSWORD=[REDACTED:secret]\r\nDone.\r\n');
  });

  it('returns empty input unchanged', () => {
    expect(redact('')).toEqual({ text: '', count: 0 });
  });

  it('redacts all secrets in a multi-line env file', () => {
    const env = ['NODE_ENV=production', 'PORT=8080', 'STRIPE_SECRET=whsec_abc123', 'SESSION_TOKEN="t0k3n-value"', 'LOG_LEVEL=info'].join('\n');
    const r = redact(env);
    expect(r.count).toBe(2);
    expect(r.text).toContain('NODE_ENV=production');
    expect(r.text).toContain('PORT=8080');
    expect(r.text).toContain('LOG_LEVEL=info');
    expect(r.text).not.toContain('whsec_abc123');
    expect(r.text).not.toContain('t0k3n-value');
  });
});
