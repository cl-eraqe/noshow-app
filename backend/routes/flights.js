const express = require('express');
const router  = express.Router();
const flights = require('../flights.json');
const { normalizeFlightNumber, resolveFlight } = require('../flight-lookup');

// flights.json is the only source. It is updated by merging the schedule
// exports (scripts/csv_to_flights_json.py); there is no in-app editing.

// GET /api/flights/terminals — { flightNumber: terminal }
router.get('/terminals', (_req, res) => {
  const map = {};
  for (const k of Object.keys(flights)) map[k] = flights[k].terminal;
  res.json(map);
});

// GET /api/flights — all known flight numbers
router.get('/', (_req, res) => {
  res.json(Object.keys(flights).sort());
});

// GET /api/flights/:flightNumber[?direction=past|future]
//
// direction picks which occurrence of the recurring departure time is meant:
// the most recent one already gone, or the next one still to come.
router.get('/:flightNumber', async (req, res) => {
  try {
    const key = normalizeFlightNumber(req.params.flightNumber);
    const direction = req.query.direction === 'future' ? 'future' : 'past';

    const hit = await resolveFlight(key, direction);
    if (!hit) return res.status(404).json({ error: `Flight ${key} not found` });
    res.json(hit);
  } catch (e) {
    console.error('[GET /flights/:flightNumber]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
