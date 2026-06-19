#!/usr/bin/env node
// Imports airline logos from a source folder into frontend/public/airlines/
// matching free-form filenames (e.g. "Etihad_Airways_idZ6i-mTSP_0.svg",
// "Egypt air.png") to the IATA code the dashboard expects (e.g. EY.svg, MS.png).
//
// Usage:
//   node scripts/import-airline-logos.mjs <source-folder>
// Example:
//   node scripts/import-airline-logos.mjs ~/Downloads/logos

import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// IATA code → list of substrings that may appear (case-insensitive) in a filename
// for that airline. Order doesn't matter; first match wins per file.
const PATTERNS = {
  SV: ['saudia', 'saudi arabian'],
  XY: ['flynas', 'nas air'],
  F3: ['flyadeal', 'fly adeal'],
  QR: ['qatar'],
  EK: ['emirates'],
  KU: ['kuwait'],
  WY: ['oman'],
  FZ: ['flydubai', 'fly dubai'],
  AT: ['royal air maroc', 'maroc'],
  ME: ['middle east', 'mea'],
  A3: ['aegean'],
  MH: ['malaysia'],
  BA: ['british'],
  MS: ['egyptair', 'egypt air'],
  EY: ['etihad'],
  GF: ['gulf air'],
  RJ: ['royal jordanian'],
  VF: ['ajet'],
  EW: ['eurowings'],
  HU: ['hainan'],
  TK: ['turkish', 'turk hava'],
  G9: ['air arabia'],
  NE: ['nesma'],
  IY: ['yemenia'],
  PC: ['pegasus'],
  SM: ['air cairo'],
  ET: ['ethiopian'],
  PK: ['pakistan international', 'pia'],
  AI: ['air india '],
  IX: ['air india express'],
  '6E': ['indigo'],
  GA: ['garuda'],
  BG: ['biman'],
  TU: ['tunisair', 'tunis air'],
  AH: ['air algerie', 'algerie'],
  J9: ['jazeera'],
  OV: ['salam'],
  PA: ['airblue'],
  PF: ['air sial'],
  PR: ['philippine'],
  SQ: ['singapore'],
  LH: ['lufthansa'],
  AF: ['air france'],
  KL: ['klm'],
};

function detectIata(filename) {
  const stem = basename(filename, extname(filename)).toLowerCase();
  for (const [iata, needles] of Object.entries(PATTERNS)) {
    if (needles.some(n => stem.includes(n))) return iata;
  }
  // Last resort: exact IATA-code filename (e.g. "SV.png", "XY.svg")
  const direct = basename(filename, extname(filename)).toUpperCase();
  if (PATTERNS[direct]) return direct;
  return null;
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('Usage: node scripts/import-airline-logos.mjs <source-folder>');
    process.exit(1);
  }
  const srcAbs = resolve(src);
  if (!existsSync(srcAbs)) {
    console.error(`Source folder not found: ${srcAbs}`);
    process.exit(1);
  }

  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(__filename), '..');
  const destDir = join(repoRoot, 'frontend', 'public', 'airlines');
  mkdirSync(destDir, { recursive: true });

  const files = readdirSync(srcAbs).filter(f => /\.(png|jpg|jpeg|svg|webp)$/i.test(f));
  const matched = [];
  const skipped = [];

  for (const f of files) {
    const iata = detectIata(f);
    const ext = extname(f).toLowerCase();
    if (!iata) {
      skipped.push(f);
      continue;
    }
    const destName = `${iata}${ext}`;
    copyFileSync(join(srcAbs, f), join(destDir, destName));
    matched.push({ from: f, to: destName });
  }

  console.log(`\nCopied ${matched.length} logos → frontend/public/airlines/`);
  for (const { from, to } of matched) console.log(`  ${from}  →  ${to}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} (no airline match):`);
    for (const f of skipped) console.log(`  ${f}`);
    console.log('\nAdd a pattern in PATTERNS at the top of this script if you need them.');
  }
}

main();
