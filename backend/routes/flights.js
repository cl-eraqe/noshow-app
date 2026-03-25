const express = require('express');
const router = express.Router();
const flights = require('../flights.json');

// GET /api/flights/:flightNumber — single flight lookup
router.get('/:flightNumber', (req, res) => {
  const key = req.params.flightNumber.toUpperCase().trim();
  const flight = flights[key];
  if (!flight) return res.status(404).json({ error: `Flight ${key} not found` });
  res.json(flight);
});

// GET /api/flights — list all flight numbers (used for autocomplete)
router.get('/', (_req, res) => {
  res.json(Object.keys(flights));
});

module.exports = router;
