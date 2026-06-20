#!/usr/bin/env node
// Generates circular-avatar source images for every airline registered in
// frontend/src/data/airline-brands.json:
//
//   /airlines/SV.png  →  /airlines/SV_avatar.png  (64×64 PNG)
//
// Each avatar is a square PNG filled with the airline's brand color and
// the logo composited centered on top — when the dashboard renders it in
// a 24px circle with border-radius:50%, the brand color fills the circle
// edge-to-edge (no white padding around the logo).
//
// Usage:
//   cd scripts && npm install sharp        (one-time)
//   node generate-airline-avatars.mjs

import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const publicDir = join(repoRoot, 'frontend', 'public');
const brandsJson = join(repoRoot, 'frontend', 'src', 'data', 'airline-brands.json');

const AVATAR_SIZE = 64;          // output canvas (high-density for retina)
const LOGO_PADDING_PCT = 0.18;   // 18% padding ⇒ logo fills 64% of the avatar

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
    alpha: 1,
  };
}

async function generateAvatar(name, brand) {
  const logoPath = join(publicDir, brand.logo);
  if (!existsSync(logoPath)) {
    console.log(`  ✗ ${name.padEnd(20)} logo missing: ${brand.logo}`);
    return false;
  }
  const avatarRel = brand.avatar || brand.logo.replace(/\.[^.]+$/, '_avatar.png');
  const avatarAbs = join(publicDir, avatarRel);

  const inner = Math.round(AVATAR_SIZE * (1 - 2 * LOGO_PADDING_PCT));

  // Resize the logo to fit inside the inner padded area (preserves aspect).
  // density:300 makes SVG inputs render at high quality.
  const logoBuf = await sharp(logoPath, { density: 300 })
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Composite the logo onto a brand-color square.
  // brand.avatarBg lets a single airline opt into a different background
  // (e.g. Etihad's gold logo is invisible on its gold brand color, so it
  // uses its maroon accent for the avatar only — the bar stays gold).
  await sharp({
    create: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      channels: 4,
      background: hexToRgb(brand.avatarBg || brand.color),
    },
  })
    .composite([{ input: logoBuf, gravity: 'center' }])
    .png()
    .toFile(avatarAbs);

  console.log(`  ✓ ${name.padEnd(20)} → ${avatarRel.split('/').pop()}`);
  return true;
}

const brands = JSON.parse(readFileSync(brandsJson, 'utf8'));
console.log(`Generating avatars for ${Object.keys(brands).length} airlines:\n`);
let ok = 0;
for (const [name, brand] of Object.entries(brands)) {
  if (await generateAvatar(name, brand)) ok++;
}
console.log(`\nDone — ${ok}/${Object.keys(brands).length} avatars written to ${publicDir}/airlines/`);
