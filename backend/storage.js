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

// Returns a URL for the file — either a signed R2 URL or null (local served via express)
async function getFileUrl(filename) {
  if (USE_R2) {
    return getSignedUrl(s3, new presigner.GetObjectCommand({ Bucket: BUCKET, Key: `uploads/${filename}` }), { expiresIn: 3600 });
  }
  return null; // local: caller uses res.sendFile
}

async function deleteFile(filename) {
  if (USE_R2) {
    await s3.send(new presigner.DeleteObjectCommand({ Bucket: BUCKET, Key: `uploads/${filename}` })).catch(() => {});
  } else {
    const fp = path.join(LOCAL_DIR, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
}

module.exports = { uploadFile, getFileUrl, deleteFile, USE_R2, LOCAL_DIR };
