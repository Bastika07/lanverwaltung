'use strict';
const crypto = require('node:crypto');

const zlib = require('node:zlib');
const MAX_BYTES = 128 * 1024;
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function decode(data, HttpError) {
  const invalid = () => { throw new HttpError(400, 'PNG erwartet: höchstens 128 KiB, 2048 × 2048, 1.048.576 Pixel; 8-Bit RGB/RGBA, nicht interlaced oder animiert'); };
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) invalid();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_BYTES || bytes.length < 57 || bytes.toString('base64') !== data || !bytes.subarray(0, 8).equals(SIGNATURE)) invalid();
  let offset = 8, header, width, height, channels, ended = false, idatEnded = false, palette = false;
  const compressed = [], retained = [SIGNATURE];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    const body = bytes.subarray(offset + 8, end - 4), whole = bytes.subarray(offset, end);
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      header = body; width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (!width || !height || width > 2048 || height > 2048 || width * height > 1048576 || body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] || body[11] || body[12]) invalid();
      channels = body[9] === 6 ? 4 : 3; retained.push(whole);
    } else if (type === 'IDAT') {
      if (idatEnded) invalid();
      compressed.push(body); retained.push(whole);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== bytes.length) invalid();
      retained.push(whole); ended = true;
    } else {
      if (compressed.length) idatEnded = true;
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
      if (type === 'PLTE') {
        if (palette || compressed.length || !length || length > 768 || length % 3) invalid();
        palette = true;
      } else if (!(bytes[offset + 4] & 32)) invalid();
      // Do not publish ancillary text/profile metadata or embedded payloads.
    }
    offset = end;
  }
  if (!ended) invalid();
  const packed = Buffer.concat(compressed), stride = width * channels + 1, expected = stride * height;
  let result;
  try { result = zlib.inflateSync(packed, { maxOutputLength: expected, info: true }); } catch { invalid(); }
  if (result.buffer.length !== expected || result.engine.bytesWritten !== packed.length) invalid();
  for (let row = 0; row < height; row++) if (result.buffer[row * stride] > 4) invalid();
  return { id: crypto.randomBytes(16).toString('hex'), data: Buffer.concat(retained).toString('base64'), width, height };
}
function view(image) {
  return image ? { id: image.id, width: image.width, height: image.height, url: `/api/website/sponsor-images/${image.id}` } : null;
}
module.exports = { decode, view };
