'use strict';


const express = require('express');
const cookieParser = require('cookie-parser');


const authConfig = require('./services/authConfig');

const gradingQueue = require('./services/gradingQueue');

const authRouter = require('./routes/auth');

const casesRouter = require('./routes/cases');
const ophthalmologistQueueRouter = require('./routes/ophthalmologistQueue');
const adminDashboardRouter = require('./routes/adminDashboard');
const referralsRouter = require('./routes/referrals');
const phcRouter = require('./routes/phc');
const patientsRouter = require('./routes/patients');
const notificationsRouter = require('./routes/notifications');

const PORT = parseInt(process.env.PORT || '5000', 10);

const app = express();


app.set('trust proxy', (() => {
  const v = (process.env.TRUST_PROXY || 'loopback').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
})());

app.use(require('./middleware/cors')());

app.use(express.json());
app.use(cookieParser());


app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', async (req, res, next) => {
  try { res.json(await require('./services/healthCheck').report()); } catch (err) { next(err); }
});


app.use('/api/v1/auth', authRouter);
app.use('/api/v1/cases', casesRouter);
app.use('/api/v1/ophthalmologist', ophthalmologistQueueRouter);
app.use('/api/v1/admin', adminDashboardRouter);
app.use('/api/v1/referrals', referralsRouter);
app.use('/api/v1/phc', phcRouter);
app.use('/api/v1/patients', patientsRouter);

app.use('/api/v1/notifications', notificationsRouter);


app.use('/media', require('./routes/media'));



app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error('[central] Unhandled error:', err);

  const expose = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: 'internal_error',
    message: expose
      ? (err.message || 'Unexpected server error')
      : 'Unexpected server error. The details are in the server log.',
  });
});


gradingQueue.start();

if (require.main === module) {

  gradingQueue.recoverStranded().catch((err) =>
    console.error('[central] stranded-case recovery failed:', err.message));


  require('./services/gradingWatchdog').start();
  require('./services/matlabSessionSupervisor').start();

  require('./services/segWorkerSupervisor').start();

  require('./services/healthCheck').probePython();

  require('./services/resourceRecommendations').start();

  require('./services/simulinkValidation').start();


  const TLS_KEY = process.env.TLS_KEY_PATH;
  const TLS_CERT = process.env.TLS_CERT_PATH;
  const useTls = !!(TLS_KEY && TLS_CERT);
  const onListen = () => {
    console.log(`central backend on ${useTls ? 'https' : 'http'}://localhost:${PORT}` +
      (useTls ? ' (TLS 1.2+)' : ' (NO TLS -- set TLS_KEY_PATH / TLS_CERT_PATH)'));
    console.log(`[central] auth: users ${authConfig.AUTH_ENABLED ? 'ENFORCED' : 'not enforced (AUTH_ENABLED=false)'}, ` +
      `PHC keys ${authConfig.PHC_AUTH_ENABLED ? 'ENFORCED' : 'not enforced (PHC_AUTH_ENABLED=false)'}, ` +
      `session cookie ${authConfig.cookieOptions.secure ? 'Secure' : 'NOT Secure (COOKIE_SECURE=false: local HTTP dev only)'}`);
    console.log(`[central] media at rest: ${require('./services/mediaCrypto').enabled()
      ? 'AES-256-GCM encrypted' : 'NOT encrypted -- set MEDIA_ENCRYPTION_KEY'}`);
  };
  const server = useTls
    ? require('https').createServer({
      key: require('fs').readFileSync(TLS_KEY),
      cert: require('fs').readFileSync(TLS_CERT),
      minVersion: 'TLSv1.2',
    }, app).listen(PORT, onListen)
    : app.listen(PORT, onListen);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[central] ${signal} — draining the grading queue`);
      await gradingQueue.stop({ drain: true });
      server.close(() => process.exit(0));
    });
  }
}

module.exports = app;
