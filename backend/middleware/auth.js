const { verifyToken } = require('../routes/auth');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const role   = verifyToken(token);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  req.role = role;
  next();
}

module.exports = { requireAuth };
