const fs   = require('fs');
const path = require('path');

const USE_R2 = !!(process.env.R2_ENDPOINT && process.env.R2_KEY && process.env.R2_SECRET && process.env.R2_BUCKET);

let s3, presigner;
if (USE_R2) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_KEY, secretAccessKey: process.env.R2_SECRET },
  });
  presigner = { getSignedUrl, GetObjectCommand, DeleteObjectCommand, PutObjectCommand };
}

const BUCKET = process.env.R2_BUCKET;
const LOCAL_DIR = path.join(__dirname, 'uploads');
const AIRLINE_LOCAL_DIR = path.join(__dirname, 'airline-uploads');

async function uploadFile(filename, buffer, mimetype) {
  if (USE_R2) {
    await s3.send(new presigner.PutObjectCommand({
      Bucket: BUCKET, Key: `uploads/${filename}`, Body: buffer, ContentType: mimetype,
    }));
  } else {
    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer);
  }
  return `/uploads/${filename}`;
}

// ── Airline brand assets (logos + generated avatars) ─────────────────────────
// Stored under a separate R2 prefix / local folder so they're not mixed with
// passenger report attachments.

async function uploadAirlineFile(filename, buffer, mimetype) {
  if (USE_R2) {
    await s3.send(new presigner.PutObjectCommand({
      Bucket: BUCKET, Key: `airlines/${filename}`, Body: buffer, ContentType: mimetype,
    }));
  } else {
    if (!fs.existsSync(AIRLINE_LOCAL_DIR)) fs.mkdirSync(AIRLINE_LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(AIRLINE_LOCAL_DIR, filename), buffer);
  }
  return filename;
}

async function streamAirlineFile(filename, res) {
  // The dashboard runs on a different origin from the API in production
  // (Vercel ↔ Railway). Helmet sets a default Cross-Origin-Resource-Policy:
  // same-origin header that would otherwise make the browser block these
  // images when loaded directly via <img src="https://railway/...">.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (USE_R2) {
    const response = await s3.send(new presigner.GetObjectCommand({ Bucket: BUCKET, Key: `airlines/${filename}` }));
    if (response.ContentType) res.setHeader('Content-Type', response.ContentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    const bytes = await response.Body.transformToByteArray();
    res.send(Buffer.from(bytes));
    return true;
  }
  const fp = path.join(AIRLINE_LOCAL_DIR, filename);
  if (!fs.existsSync(fp)) return false;
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(fp);
  return true;
}

async function deleteAirlineFile(filename) {
  if (USE_R2) {
    await s3.send(new presigner.DeleteObjectCommand({ Bucket: BUCKET, Key: `airlines/${filename}` })).catch(() => {});
  } else {
    const fp = path.join(AIRLINE_LOCAL_DIR, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
}

// Serve a file from R2 directly through the Express response
async function streamFile(filename, res) {
  if (!USE_R2) return false;
  const response = await s3.send(new presigner.GetObjectCommand({ Bucket: BUCKET, Key: `uploads/${filename}` }));
  if (response.ContentType) res.setHeader('Content-Type', response.ContentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  // transformToByteArray is the SDK v3-safe way (Body.pipe is unreliable with web-stream Body)
  const bytes = await response.Body.transformToByteArray();
  res.send(Buffer.from(bytes));
  return true;
}

// Returns a signed R2 URL (kept for internal use / future needs)
async function getFileUrl(filename) {
  if (USE_R2) {
    return getSignedUrl(s3, new presigner.GetObjectCommand({ Bucket: BUCKET, Key: `uploads/${filename}` }), { expiresIn: 3600 });
  }
  return null;
}

async function deleteFile(filename) {
  if (USE_R2) {
    await s3.send(new presigner.DeleteObjectCommand({ Bucket: BUCKET, Key: `uploads/${filename}` })).catch(() => {});
  } else {
    const fp = path.join(LOCAL_DIR, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
}

module.exports = {
  uploadFile, getFileUrl, streamFile, deleteFile, USE_R2, LOCAL_DIR,
  uploadAirlineFile, streamAirlineFile, deleteAirlineFile, AIRLINE_LOCAL_DIR,
};
