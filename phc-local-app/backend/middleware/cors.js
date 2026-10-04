'use strict';


const DEV_DEFAULTS = [
  'http://localhost:5173',   // Vite dev
  'http://localhost:4173',   // Vite preview
  'http://localhost:3000',   // CRA / Next dev
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
];


const DEMO_DEFAULTS = ['https://*.vercel.app'];

function parseOrigins(raw) {
  if (!raw) return [...DEV_DEFAULTS, ...DEMO_DEFAULTS];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}


function matches(origin, pattern) {
  if (pattern === origin) return true;
  const star = pattern.indexOf('://*.');
  if (star === -1) return false;

  const scheme = pattern.slice(0, star + 3);          // "https://"
  const suffix = pattern.slice(star + 4);             // ".vercel.app"
  if (!suffix.includes('.', 1)) return false;         // refuse "*.app"-style
  if (!origin.startsWith(scheme)) return false;

  const host = origin.slice(scheme.length);
  if (!host.endsWith(suffix)) return false;

  const label = host.slice(0, host.length - suffix.length);
  // Exactly one non-empty label, no dots, no port, no path.
  return label.length > 0 && !/[.:/]/.test(label);
}

module.exports = function cors(options = {}) {
  const allowed = options.origins || parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;


    if (!origin) return next();

    if (!allowed.some((p) => matches(origin, p))) {
      also

      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);

    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',
        req.headers['access-control-request-headers']
        || 'Content-Type,Authorization,X-Requested-With');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.sendStatus(204);
    }

    return next();
  };
};

module.exports.matches = matches;         // exported for the unit test
module.exports.DEV_DEFAULTS = DEV_DEFAULTS;
module.exports.DEMO_DEFAULTS = DEMO_DEFAULTS;
