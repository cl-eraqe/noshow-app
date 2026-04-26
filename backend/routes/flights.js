const express = require('express');
const router = express.Router();
const flights = require('../flights.json');
const { getDb, jeddahNowStr } = require('../db');

// GET /api/flights/custom/list — must be before /:flightNumber
router.get('/custom/list', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM flights_custom ORDER BY flight_number ASC');
    const enriched = rows.map(r => ({ ...r, isOverride: !!flights[r.flight_number] }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/flights — all known flight numbers
router.get('/', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows: customs } = await pool.query('SELECT * FROM flights_custom');
    const customMap = {};
    customs.forEach(c => { customMap[c.flight_number] = c; });
    const jsonKeys = Object.keys(flights).filter(k => !customMap[k]?.deleted);
    const customAdditions = customs.filter(c => !c.deleted && !flights[c.flight_number]).map(c => c.flight_number);
    res.json([...jsonKeys, ...customAdditions].sort());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/flights/:flightNumber
router.get('/:flightNumber', async (req, res) => {
  try {
    const key = req.params.flightNumber.toUpperCase().trim();
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM flights_custom WHERE flight_number = $1', [key]);
    const custom = rows[0];
    if (custom) {
      if (custom.deleted) return res.status(404).json({ error: `Flight ${key} not found` });
      return res.json({ destination: custom.destination, std: custom.std, city: custom.city, country: custom.country, nationality: custom.nationality });
    }
    const base = flights[key];
    if (!base) return res.status(404).json({ error: `Flight ${key} not found` });
    res.json(base);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/flights — add or update a flight
router.post('/', express.json(), async (req, res) => {
  try {
    const { flight_number, destination, std, city, country, nationality } = req.body;
    if (!flight_number) return res.status(400).json({ error: 'flight_number required' });
    const key = flight_number.toUpperCase().trim();
    const pool = getDb();
    await pool.query(
      `INSERT INTO flights_custom (flight_number, destination, std, city, country, nationality, deleted, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
       ON CONFLICT (flight_number) DO UPDATE SET
         destination = EXCLUDED.destination, std = EXCLUDED.std, city = EXCLUDED.city,
         country = EXCLUDED.country, nationality = EXCLUDED.nationality,
         deleted = 0, updated_at = EXCLUDED.updated_at`,
      [key, destination || '', std || '', city || '', country || '', nationality || '', jeddahNowStr()]
    );
    res.json({ success: true, flight_number: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/flights/:flightNumber — soft-delete
router.delete('/:flightNumber', async (req, res) => {
  try {
    const key = req.params.flightNumber.toUpperCase().trim();
    const pool = getDb();
    await pool.query(
      `INSERT INTO flights_custom (flight_number, deleted, updated_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (flight_number) DO UPDATE SET deleted = 1, updated_at = EXCLUDED.updated_at`,
      [key, jeddahNowStr()]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
