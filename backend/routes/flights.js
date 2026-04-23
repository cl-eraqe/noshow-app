const express = require('express');
const router = express.Router();
const flights = require('../flights.json');
const { getDb } = require('../db');

function jeddahNow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Merge JSON + custom table into one flight record (custom wins / can mark deleted)
function lookupFlight(key) {
  const db = getDb();
  const custom = db.prepare('SELECT * FROM flights_custom WHERE flight_number = ?').get(key);
  if (custom) {
    if (custom.deleted) return null;
    return { destination: custom.destination, std: custom.std, city: custom.city, country: custom.country, nationality: custom.nationality };
  }
  return flights[key] || null;
}

// GET /api/flights/:flightNumber
router.get('/:flightNumber', (req, res) => {
  const key = req.params.flightNumber.toUpperCase().trim();
  const flight = lookupFlight(key);
  if (!flight) return res.status(404).json({ error: `Flight ${key} not found` });
  res.json(flight);
});

// GET /api/flights — all known flight numbers (JSON base + custom additions, minus deleted)
router.get('/', (_req, res) => {
  const db = getDb();
  const customs = db.prepare('SELECT * FROM flights_custom').all();
  const customMap = {};
  customs.forEach(c => { customMap[c.flight_number] = c; });

  const jsonKeys = Object.keys(flights).filter(k => !customMap[k]?.deleted);
  const customAdditions = customs.filter(c => !c.deleted && !flights[c.flight_number]).map(c => c.flight_number);

  res.json([...jsonKeys, ...customAdditions].sort());
});

// GET /api/flights/custom/list — list all custom entries (for Flight Manager UI)
router.get('/custom/list', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM flights_custom ORDER BY flight_number ASC').all();
  const enriched = rows.map(r => ({
    ...r,
    isOverride: !!flights[r.flight_number],
  }));
  res.json(enriched);
});

// POST /api/flights — add or update a flight (supervisor only)
router.post('/', express.json(), (req, res) => {
  const { flight_number, destination, std, city, country, nationality } = req.body;
  if (!flight_number) return res.status(400).json({ error: 'flight_number required' });

  const key = flight_number.toUpperCase().trim();
  const db = getDb();

  db.prepare(`
    INSERT INTO flights_custom (flight_number, destination, std, city, country, nationality, deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(flight_number) DO UPDATE SET
      destination = excluded.destination, std = excluded.std, city = excluded.city,
      country = excluded.country, nationality = excluded.nationality,
      deleted = 0, updated_at = excluded.updated_at
  `).run(key, destination || '', std || '', city || '', country || '', nationality || '', jeddahNow());

  res.json({ success: true, flight_number: key });
});

// DELETE /api/flights/:flightNumber — soft-delete (marks as deleted in custom table)
router.delete('/:flightNumber', (req, res) => {
  const key = req.params.flightNumber.toUpperCase().trim();
  const db = getDb();

  db.prepare(`
    INSERT INTO flights_custom (flight_number, deleted, updated_at)
    VALUES (?, 1, ?)
    ON CONFLICT(flight_number) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at
  `).run(key, jeddahNow());

  res.json({ success: true });
});

module.exports = router;
