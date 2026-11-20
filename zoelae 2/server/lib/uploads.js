'use strict';
// Uploaded files live outside the served public/ tree and are only ever streamed back through a
// route that has already checked ownership or viewer permission. There is no static path to them.
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('./../config');
const tokens = require('./tokens');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);
const DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf'
};

function storagePathFor(mimeType) {
  const name = tokens.randomString(24) + (EXTENSIONS[mimeType] || '.bin');
  const bucket = name.slice(0, 2).toLowerCase();       // spread files over subdirectories
  return path.join(bucket, name);
}

/** Writes a buffer into the uploads root and returns its relative path. */
function writeFile(buffer, mimeType) {
  const rel = storagePathFor(mimeType);
  const abs = path.join(config.uploadsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

/** Resolves a stored relative path, refusing anything that escapes the uploads root. */
function absolutePath(relative) {
  const abs = path.resolve(config.uploadsDir, relative);
  if (!abs.startsWith(path.resolve(config.uploadsDir) + path.sep)) throw new Error('path traversal blocked');
  return abs;
}

function removeFile(relative) {
  try { fs.rmSync(absolutePath(relative)); } catch { /* already gone */ }
}

/**
 * Headers for every uploaded file we stream. nosniff stops a browser guessing a type; the sandbox
 * CSP means that even if a file were somehow interpreted as a document it could run nothing.
 */
function protectiveHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 12 }
});

module.exports = { upload, protectiveHeaders, writeFile, absolutePath, removeFile, IMAGE_TYPES, DOCUMENT_TYPES };
