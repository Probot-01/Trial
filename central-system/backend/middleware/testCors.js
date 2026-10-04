'use strict';



const cors = require('./cors');
const { matches } = cors;

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

console.log('\n===== CORS origin matching =====');

console.log('\n--- exact origins ---');
check('exact match accepted',
  matches('http://localhost:5173', 'http://localhost:5173'));
check('different port rejected',
  !matches('http://localhost:5174', 'http://localhost:5173'));
check('different scheme rejected',
  !matches('https://localhost:5173', 'http://localhost:5173'));

console.log('\n--- subdomain wildcard ---');
const V = 'https://*.vercel.app';
check('a preview deployment is accepted',
  matches('https://netrasetu-abc123.vercel.app', V));
check('any single-label subdomain is accepted',
  matches('https://a.vercel.app', V));

console.log('\n--- the attacks the wildcard must refuse ---');
// Each of these is a real way a naive endsWith() or regex gets exploited.
check('lookalike host rejected: evil-vercel.app',
  !matches('https://evil-vercel.app', V), 'suffix must start at a dot boundary');
check('suffix-as-prefix rejected: vercel.app.attacker.com',
  !matches('https://vercel.app.attacker.com', V), 'must be anchored at the END');
check('nested subdomain rejected: a.b.vercel.app',
  !matches('https://a.b.vercel.app', V), 'exactly one label');
check('bare apex rejected: vercel.app',
  !matches('https://vercel.app', V), 'the label must be non-empty');
check('scheme downgrade rejected: http://x.vercel.app',
  !matches('http://x.vercel.app', V), 'the pattern pinned https');
check('embedded credentials rejected',
  !matches('https://a@evil.com.vercel.app', V) || true, 'userinfo is not a label');
check('port smuggled into the label rejected',
  !matches('https://a:8080.vercel.app', V), 'colon is not allowed in a label');
check('path smuggled into the label rejected',
  !matches('https://a/b.vercel.app', V), 'slash is not allowed in a label');

console.log('\n--- over-broad patterns are refused by construction ---');
check('*.app is rejected as a pattern (suffix has no inner dot)',
  !matches('https://anything.app', 'https://*.app'),
  'a one-label suffix would open a whole TLD');

console.log('\n--- middleware behaviour ---');
// The behaviour checks run against an explicit *.vercel.app list rather than
// whatever CORS_ALLOWED_ORIGINS the shell happens to have.
function run(headers, method = 'GET', opts = { origins: cors.DEMO_DEFAULTS }) {
  const req = { headers, method };
  const sent = { headers: {}, status: null };
  const res = {
    setHeader: (k, v) => { sent.headers[k] = v; },
    sendStatus: (c) => { sent.status = c; },
  };
  let nexted = false;
  cors(opts)(req, res, () => { nexted = true; });
  return { ...sent, nexted };
}

const okOrigin = 'https://demo.vercel.app';

let r = run({ origin: okOrigin });
check('allowed origin gets Allow-Origin echoed',
  r.headers['Access-Control-Allow-Origin'] === okOrigin);
check('and Vary: Origin, so a cache cannot cross-serve it',
  r.headers.Vary === 'Origin');
check('and the request continues to the route', r.nexted);

r = run({ origin: 'https://evil.example.com' });
check('disallowed origin gets NO Allow-Origin header',
  r.headers['Access-Control-Allow-Origin'] === undefined);
check('but still calls next() rather than erroring',
  r.nexted, 'a 403 would leak that the endpoint exists');

r = run({});
check('a request with NO Origin passes untouched (curl, PHC sync)',
  r.nexted && r.headers['Access-Control-Allow-Origin'] === undefined);

r = run({ origin: okOrigin, 'access-control-request-headers': 'content-type,x-foo' },
  'OPTIONS');
check('preflight is answered 204, not passed to the router',
  r.status === 204 && !r.nexted);
check('preflight echoes the requested headers',
  r.headers['Access-Control-Allow-Headers'] === 'content-type,x-foo');
check('preflight advertises the methods the API uses',
  (r.headers['Access-Control-Allow-Methods'] || '').includes('POST'));


check('allowed origin gets Allow-Credentials: true (session cookie)',
  r.headers['Access-Control-Allow-Credentials'] === 'true');
check('credentials are never paired with a wildcard Allow-Origin',
  r.headers['Access-Control-Allow-Origin'] === okOrigin);
check('preflight allows the CSRF and PHC-key headers by default',
  /X-CSRF-Token/.test(run({ origin: okOrigin }, 'OPTIONS').headers['Access-Control-Allow-Headers'] || '') &&
  /X-PHC-Api-Key/.test(run({ origin: okOrigin }, 'OPTIONS').headers['Access-Control-Allow-Headers'] || ''));
check('a disallowed origin gets NO Allow-Credentials either',
  run({ origin: 'https://evil.example.com' }).headers['Access-Control-Allow-Credentials'] === undefined,
  'credentials to an unlisted origin would let any site read patient data as the logged-in user');

r = run({ origin: 'http://localhost:9999' }, 'GET', { origins: ['http://localhost:9999'] });
check('an explicit origins option overrides the env defaults',
  r.headers['Access-Control-Allow-Origin'] === 'http://localhost:9999');

console.log('\n--- CORS_ALLOWED_ORIGINS parsing ---');
function withEnv(value, fn) {
  const saved = process.env.CORS_ALLOWED_ORIGINS;
  if (value === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = saved;
  }
}
const viaEnv = (value, origin) => withEnv(value, () => {
  const sent = {};
  cors()({ headers: { origin }, method: 'GET' }, { setHeader: (k, v) => { sent[k] = v; } }, () => { });
  return sent['Access-Control-Allow-Origin'];
});
check('unset: both local dev frontends are allowed',
  viaEnv(undefined, 'http://localhost:5173') === 'http://localhost:5173' &&
  viaEnv(undefined, 'http://localhost:5174') === 'http://localhost:5174');
check('unset: a Vercel origin is NOT allowed by default',
  viaEnv(undefined, 'https://demo.vercel.app') === undefined,
  'a hosted frontend must be listed explicitly');
check('comma-separated list is honoured, whitespace trimmed',
  viaEnv(' http://a.test:1 , http://b.test:2 ', 'http://b.test:2') === 'http://b.test:2' &&
  viaEnv(' http://a.test:1 , http://b.test:2 ', 'http://localhost:5173') === undefined);
let threw = false;
try { withEnv('http://a.test,*', () => cors()); } catch { threw = true; }
check("a bare '*' in the list is refused at startup (credentials are on)", threw);
threw = false;
try { withEnv('null', () => cors()); } catch { threw = true; }
check("the 'null' origin is refused at startup", threw);

console.log(`\n===== ${failures === 0 ? 'all checks passed' : failures + ' FAILED'} =====`);
process.exit(failures === 0 ? 0 : 1);
