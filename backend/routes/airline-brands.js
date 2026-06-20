const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();
const { getDb, jeddahNowStr, logAudit } = require('../db');
const { uploadAirlineFile, streamAirlineFile, deleteAirlineFile } = require('../storage');
const { requireAuth, requireRole } = require('../middleware/auth');

// This route only stores and serves *overrides*. The bundled defaults
// (brand names, paths to the bundled logos) live in the frontend at
// frontend/src/data/airline-brands.json and the dashboard merges them
// with whatever this endpoint returns. Keeping the backend ignorant of
// the brand list means it doesn't need to reach across folders that
// Railway doesn't include in the deploy.
//
// Note: we deliberately do NOT composite the uploaded image onto a
// brand-color square. The frontend renders the raw upload in a circular
// <img> with object-fit:cover — what you upload is what you see.

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

// ── GET overrides — keyed by IATA. Empty object if no airline has been overridden. ─
router.get('/overrides', requireAuth, async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(
      'SELECT iata, logo_file, avatar_file, updated_at FROM airline_brand_overrides'
    );
    const out = {};
    for (const r of rows) {
      const iata = (r.iata || '').toUpperCase();
      const bust = encodeURIComponent(r.updated_at || '');
      // logo_file and avatar_file can point at the same file — that's fine.
      out[iata] = {
        iata,
        logo:       `/api/airline-brands/file/${r.logo_file}?v=${bust}`,
        avatar:     `/api/airline-brands/file/${r.avatar_file}?v=${bust}`,
        updated_at: r.updated_at,
      };
    }
    res.json(out);
  } catch (e) {
    console.error('[GET /airline-brands/overrides]', e?.message || e);
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
    if (!/^[A-Z0-9]{2,3}$/.test(iata)) {
      return res.status(400).json({ error: 'Invalid IATA code.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Store the file exactly as uploaded. Same file is used for both the
    // avatar (clipped to a circle on the frontend) and the bar logo.
    const ts = Date.now();
    const origExt = (path.extname(req.file.originalname || '').toLowerCase() || '.png').replace(/^\.+/, '.');
    const filename = `${iata}-${ts}${origExt}`;

    await uploadAirlineFile(filename, req.file.buffer, req.file.mimetype);

    const pool = getDb();
    const now  = jeddahNowStr();

    // Read previous row so we can delete the stale files after the row is replaced.
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
      [iata, filename, filename, now, req.username || null]
    );

    if (prev[0]) {
      const stale = new Set([prev[0].logo_file, prev[0].avatar_file].filter(Boolean));
      stale.delete(filename); // never delete the file we just uploaded
      Promise.all([...stale].map(f => deleteAirlineFile(f).catch(() => {}))).catch(() => {});
    }

    await logAudit({
      user:   req.username || req.role,
      action: 'airline_logo_upload',
      changes: { iata, file: filename },
    });

    const bust = encodeURIComponent(now);
    const url  = `/api/airline-brands/file/${filename}?v=${bust}`;
    res.json({
      iata,
      logo:       url,
      avatar:     url,
      updated_at: now,
    });
  } catch (e) {
    console.error('[POST /airline-brands/:iata/logo]', e?.message || e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE override — supervisor only (reverts to bundled default if any) ────
router.delete('/:iata/logo', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const iata = String(req.params.iata || '').toUpperCase();
    if (!/^[A-Z0-9]{2,3}$/.test(iata)) {
      return res.status(400).json({ error: 'Invalid IATA code.' });
    }

    const pool = getDb();
    const { rows } = await pool.query(
      'SELECT logo_file, avatar_file FROM airline_brand_overrides WHERE iata = $1',
      [iata]
    );
    if (!rows[0]) return res.json({ success: true, reverted: false });

    await pool.query('DELETE FROM airline_brand_overrides WHERE iata = $1', [iata]);
    const stale = new Set([rows[0].logo_file, rows[0].avatar_file].filter(Boolean));
    Promise.all([...stale].map(f => deleteAirlineFile(f).catch(() => {}))).catch(() => {});

    await logAudit({
      user: req.username || req.role,
      action: 'airline_logo_revert',
      changes: { iata },
    });

    res.json({ success: true, reverted: true });
  } catch (e) {
    console.error('[DELETE /airline-brands/:iata/logo]', e?.message || e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
