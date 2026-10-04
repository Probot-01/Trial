'use strict';



const cfg = require('../services/authConfig');

function requireRole(...roles) {
  const allowed = roles.flat();
  for (const r of allowed) {
    if (!cfg.ROLES.includes(r)) throw new Error(`requireRole: unknown role '${r}'`);
  }

  return function roleGuard(req, res, next) {
    if (!cfg.AUTH_ENABLED) return next();
    if (!req.user) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Log in to continue.' });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `This action requires the ${allowed.join(' or ')} role.`,
      });
    }
    return next();
  };
}

module.exports = requireRole;
