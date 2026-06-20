const express = require('express');
const multer  = require('multer');
const path    = require('path');
const sharp   = require('sharp');
const router  = express.Router();
const { getDb, jeddahNowStr, logAudit } = require('../db');
const { uploadAirlineFile, streamAirlineFile, deleteAirlineFile } = require('../storage');
const { requireAuth, requireRole } = require('../middleware/auth');

// Static defaults (shape: { [airlineName]: { iata, color, accent, avatarBg?, logo, avatar } })
const DEFAULTS = require('../../frontend/src/data/airline-brands.json');

// Quick IATA → brand-name lookup
const NAME_BY_IATA = {};
for (const [name, brand] of Object.entries(DEFAULTS)) {
  if (brand.iata) NAME_BY_IATA[brand.iata.toUpperCase()] = name;
}

// ── Avatar generation (matches scripts/generate-airline-avatars.mjs) ─────────
const AVATAR_SIZE = 64;
const LOGO_PADDING_PCT = 0.18; // logo fills ~64% of the avatar

function hexToRgb(hex) {
  const m = String(hex || '#000000').replace('#', '');
  return {
    r: parseInt(m.slice(0, 2), 16) || 0,
    g: parseInt(m.slice(2, 4), 16) || 0,
    b: parseInt(m.slice(4, 6), 16) || 0,
    alpha: 1,
  };
}

async function buildAvatar(logoBuffer, brand) {
  const inner = Math.round(AVATAR_SIZE * (1 - 2 * LOGO_PADDING_PCT));
  const logoFit = await sharp(logoBuffer, { density: 300 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      channels: 4,
      background: hexToRgb(brand.avatarBg || brand.color),
    },
  })
    .composite([{ input: logoFit, gravity: 'center' }])
    .png()
    .toBuffer();
}

// ── File serving — public, cached briefly. Hashed filenames give us cache-busting. ─
router.get('/file/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const ok = await streamAirlineFile(filename, res);
    if (!ok && !res.headersSent) res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error('[GET /airline-brands/file/:filename]', e?.message || e);
    if (!res.headersSent) res.status(404).json({ error: 'Not found' });
  }
});

// ── GET /api/airline-brands — merged defaults + DB overrides ────────────────
router.get('/', requireAuth, async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(
      'SELECT iata, logo_file, avatar_file, updated_at FROM airline_brand_overrides'
    );
    const overrides = {};
    for (const r of rows) overrides[r.iata.toUpperCase()] = r;

    const merged = {};
    for (const [name, brand] of Object.entries(DEFAULTS)) {
      const iata = (brand.iata || '').toUpperCase();
      const ov = overrides[iata];
      if (ov) {
        const bust = encodeURIComponent(ov.updated_at || '');
        merged[name] = {
          ...brand,
          logo:   `/api/airline-brands/file/${ov.logo_file}?v=${bust}`,
          avatar: `/api/airline-brands/file/${ov.avatar_file}?v=${bust}`,
          overridden: true,
        };
      } else {
        merged[name] = brand;
      }
    }
    res.json(merged);
  } catch (e) {
    console.error('[GET /airline-brands]', e?.message || e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST upload — supervisor only ────────────────────────────────────────────
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only PNG, JPEG, SVG, or WebP files are allowed.'), { status: 400 }));
    }
    cb(null, true);
  },
});

function uploadLogoMw(req, res, next) {
  upload.single('logo')(req, res, err => {
    if (!err) return next();
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File exceeds the 5 MB limit.'
      : (err.message || 'Upload error.');
    res.status(status).json({ error: message });
  });
}

router.post('/:iata/logo', requireAuth, requireRole('supervisor'), uploadLogoMw, async (req, res) => {
  try {
    const iata = String(req.params.iata || '').toUpperCase();
    const name = NAME_BY_IATA[iata];
    if (!name) return res.status(404).json({ error: `Unknown airline IATA: ${iata}` });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const brand = DEFAULTS[name];

    // Build the avatar from the uploaded buffer using the brand's color.
    let avatarBuf;
    try {
      avatarBuf = await buildAvatar(req.file.buffer, brand);
    } catch (e) {
      console.error('[avatar build]', e?.message || e);
      return res.status(400).json({ error: 'Could not process the image. Try a different file.' });
    }

    const ts = Date.now();
    const origExt = (path.extname(req.file.originalname || '').toLowerCase() || '.png').replace(/^\.+/, '.');
    const logoFile   = `${iata}-logo-${ts}${origExt}`;
    const avatarFile = `${iata}-avatar-${ts}.png`;

    await uploadAirlineFile(logoFile, req.file.buffer, req.file.mimetype);
    await uploadAirlineFile(avatarFile, avatarBuf, 'image/png');

    const pool = getDb();
    const now  = jeddahNowStr();

    // Read previous row so we can delete the old files after the row is replaced.
    const { rows: prev } = await pool.query(
      'SELECT logo_file, avatar_file FROM airline_brand_overrides WHERE iata = $1',
      [iata]
    );

    await pool.query(
      `INSERT INTO airline_brand_overrides (iata, logo_file, avatar_file, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (iata) DO UPDATE SET
         logo_file   = EXCLUDED.logo_file,
         avatar_file = EXCLUDED.avatar_file,
         updated_at  = EXCLUDED.updated_at,
         updated_by  = EXCLUDED.updated_by`,
      [iata, logoFile, avatarFile, now, req.username || null]
    );

    // Clean up the previous files (best effort).
    if (prev[0]) {
      Promise.all([
        deleteAirlineFile(prev[0].logo_file),
        deleteAirlineFile(prev[0].avatar_file),
      ]).catch(() => {});
    }

    await logAudit({
      user:   req.username || req.role,
      action: 'airline_logo_upload',
      changes: { iata, name, logo_file: logoFile, avatar_file: avatarFile },
    });

    const bust = encodeURIComponent(now);
    res.json({
      iata, name,
      logo:       `/api/airline-brands/file/${logoFile}?v=${bust}`,
      avatar:     `/api/airline-brands/file/${avatarFile}?v=${bust}`,
      updated_at: now,
      overridden: true,
    });
  } catch (e) {
    console.error('[POST /airline-brands/:iata/logo]', e?.message || e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE override — supervisor only (reverts to bundled default) ───────────
router.delete('/:iata/logo', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const iata = String(req.params.iata || '').toUpperCase();
    const name = NAME_BY_IATA[iata];
    if (!name) return res.status(404).json({ error: `Unknown airline IATA: ${iata}` });

    const pool = getDb();
    const { rows } = await pool.query(
      'SELECT logo_file, avatar_file FROM airline_brand_overrides WHERE iata = $1',
      [iata]
    );
    if (!rows[0]) return res.json({ success: true, reverted: false });

    await pool.query('DELETE FROM airline_brand_overrides WHERE iata = $1', [iata]);
    Promise.all([
      deleteAirlineFile(rows[0].logo_file),
      deleteAirlineFile(rows[0].avatar_file),
    ]).catch(() => {});

    await logAudit({
      user: req.username || req.role,
      action: 'airline_logo_revert',
      changes: { iata, name },
    });

    res.json({ success: true, reverted: true });
  } catch (e) {
    console.error('[DELETE /airline-brands/:iata/logo]', e?.message || e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
