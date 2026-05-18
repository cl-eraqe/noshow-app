const { verifyToken } = require('../routes/auth');

function requireAuth(req, res, next) {
  // Cookie is the primary auth method; Bearer header kept as fallback for non-browser clients.
  const cookieToken = req.cookies?.noshow_token || null;
  const header      = req.headers.authorization || '';
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const role        = verifyToken(cookieToken) || verifyToken(bearerToken);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  req.role = role;
  next();
}

// Returns middleware that rejects requests whose role does not match.
// Must be placed after requireAuth so that req.role is already set.
function requireRole(role) {
  return (req, res, next) => {
    if (req.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = { requireAuth, requireRole };
