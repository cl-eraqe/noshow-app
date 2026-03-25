/**
 * Convert your flights CSV to flights.json
 *
 * CSV format expected (with header row):
 *   Flight,Destination,STD,City,Country,Nationality
 *
 * Usage:
 *   node scripts/csv-to-json.js path/to/flights.csv
 *
 * Output: overwrites backend/flights.json
 */
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/csv-to-json.js <path-to-csv>');
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

// Skip header row
const header = lines[0].toLowerCase().split(',');
const flightIdx      = header.indexOf('flight');
const destIdx        = header.indexOf('destination');
const stdIdx         = header.indexOf('std');
const cityIdx        = header.indexOf('city');
const countryIdx     = header.indexOf('country');
const nationalityIdx = header.indexOf('nationality');

if ([flightIdx, destIdx, stdIdx, cityIdx, countryIdx, nationalityIdx].includes(-1)) {
  console.error('CSV must have columns: Flight,Destination,STD,City,Country,Nationality');
  process.exit(1);
}

const result = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  const flight = cols[flightIdx]?.trim().toUpperCase();
  if (!flight) continue;
  result[flight] = {
    destination: cols[destIdx]?.trim().toUpperCase(),
    std:         cols[stdIdx]?.trim(),
    city:        cols[cityIdx]?.trim(),
    country:     cols[countryIdx]?.trim(),
    nationality: cols[nationalityIdx]?.trim(),
  };
}

const outPath = path.join(__dirname, '..', 'flights.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`Done! Wrote ${Object.keys(result).length} flights to ${outPath}`);
