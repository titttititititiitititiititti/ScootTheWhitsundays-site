// Private file storage on the data disk. Nothing here is publicly served:
// licence photos and videos are only ever streamed to the logged-in admin
// (or, for trip videos, the customer's own booking link).
import { mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { dataDir } from './db.js';

export const MAX_LICENCE_PHOTO_BYTES = 4 * 1024 * 1024;

export function uploadsRoot() {
  return path.join(dataDir(), 'uploads');
}

/** Decodes "data:image/jpeg;base64,..." and checks it really is a JPEG/PNG/WebP. */
export function decodeImageDataUrl(s) {
  const m = typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_LICENCE_PHOTO_BYTES) return null;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;
  const type = isJpeg ? 'jpeg' : isPng ? 'png' : 'webp';
  return { buf, mime: `image/${type}`, ext: type === 'jpeg' ? 'jpg' : type };
}

/** Writes licence photos for a booking; returns [{ relPath, mime, size }]. */
export async function saveLicencePhotos(bookingId, images) {
  const rel = path.join('licences', bookingId);
  await mkdir(path.join(uploadsRoot(), rel), { recursive: true });
  const out = [];
  for (const [i, img] of images.entries()) {
    const relPath = path.join(rel, `licence-${i + 1}.${img.ext}`).split(path.sep).join('/');
    await writeFile(path.join(uploadsRoot(), relPath), img.buf);
    out.push({ relPath, mime: img.mime, size: img.buf.length });
  }
  return out;
}

/** Removes the licence photos saved for a booking that never went ahead. */
export async function deleteBookingFiles(bookingId) {
  await rm(path.join(uploadsRoot(), 'licences', bookingId), { recursive: true, force: true });
}

// ── Pickup / return videos and photos ───────────────────────────────────────
export const MAX_TRIP_FILE_BYTES = 600 * 1024 * 1024;       // one phone video (≈ a few minutes of 1080p)
export const MAX_TRIP_BYTES_PER_BOOKING = 3 * 1024 * 1024 * 1024;

/** Works out the real file type from its first bytes (never trusts the name or the browser). */
export function sniffMedia(head) {
  if (head.length < 12) return null;
  const at = (i, n) => head.subarray(i, i + n).toString('latin1');
  if (at(4, 4) === 'ftyp') {
    const brand = at(8, 4);
    if (['heic', 'heix', 'mif1', 'msf1', 'heis', 'hevc'].includes(brand)) return { mime: 'image/heic', ext: 'heic', kind: 'photo' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    if (brand.startsWith('3g')) return { mime: 'video/3gpp', ext: '3gp', kind: 'video' };
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'photo' };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', kind: 'photo' };
  return null;
}

/**
 * Streams an upload (the raw request body) to the disk without holding it in memory.
 * Resolves { relPath, mime, kind, size } or rejects with err.status 400 / 413.
 */
export async function saveTripUpload(req, { bookingId, phase, bikeNumber, maxBytes }) {
  const rel = path.posix.join('trips', bookingId);
  const dir = path.join(uploadsRoot(), rel);
  await mkdir(dir, { recursive: true });
  const id = `${phase}-bike${bikeNumber}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(dir, id + '.part');
  const fail = (status, message) => Object.assign(new Error(message), { status });

  return new Promise((resolve, reject) => {
    let size = 0, head = Buffer.alloc(0), type = null, done = false;
    const out = createWriteStream(tmp);
    const abort = (err) => {
      if (done) return;
      done = true;
      req.unpipe?.(out);
      out.destroy();
      req.resume(); // drain the rest so the reply can be sent
      rm(tmp, { force: true }).finally(() => reject(err));
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) return abort(fail(413, 'That file is too big. Please record a shorter video (about 1 minute).'));
      if (!type) {
        head = Buffer.concat([head, chunk]).subarray(0, 32);
        if (head.length >= 12) {
          type = sniffMedia(head);
          if (!type) return abort(fail(400, 'That file is not a video or photo we can use. Please try again with your camera.'));
        }
      }
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => {
      if (done) return;
      if (!type) return abort(fail(400, 'That file is empty or not a video/photo.'));
      done = true;
      out.end(async () => {
        try {
          const relPath = `${rel}/${id}.${type.ext}`;
          await rename(tmp, path.join(uploadsRoot(), relPath));
          resolve({ relPath, mime: type.mime, kind: type.kind, size });
        } catch (e) { reject(e); }
      });
    });
    req.on('aborted', () => abort(fail(400, 'The upload was interrupted. Please try again.')));
    req.on('error', (e) => abort(e));
    out.on('error', (e) => abort(e));
  });
}
