const PREFIX = 'data:image/webp;base64,';
const SCREENSHOT_LIMIT = 64000;

function readScreenshot(value) {
  if (typeof value !== 'string' || value.length > SCREENSHOT_LIMIT || !value.startsWith(PREFIX)) return null;
  const base64 = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) return null;
  const data = Buffer.from(base64, 'base64');
  if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' ||
      data.readUInt32LE(4) + 8 !== data.length) return null;
  return data;
}

function singleFrame(data) {
  const type = data.toString('ascii', 12, 16);
  const length = data.readUInt32LE(16);
  if (20 + length + (length & 1) !== data.length) return false;
  let width, height;
  if (type === 'VP8 ' && !(data[20] & 1) && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    width = data.readUInt16LE(26) & 0x3fff;
    height = data.readUInt16LE(28) & 0x3fff;
  } else if (type === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    if (bits >>> 29) return false;
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  } else return false;
  return width >= 1 && height >= 1 && width <= 800 && height <= 800;
}

function validScreenshot(value) {
  const data = readScreenshot(value);
  return !!data && singleFrame(data);
}

function canonicalScreenshot(value) {
  const data = readScreenshot(value);
  if (!data) return null;
  if (singleFrame(data)) return value;
  // Chromium may attach an ICC profile to an opaque canvas. Keep only its still image.
  if (data.toString('ascii', 12, 16) !== 'VP8X' || data.readUInt32LE(16) !== 10 || data[20] !== 0x20) return null;
  if (data.length < 38 || data.toString('ascii', 30, 34) !== 'ICCP') return null;
  const profileBytes = data.readUInt32LE(34);
  const start = 38 + profileBytes + (profileBytes & 1);
  if (data.length - start < 18) return null;
  const result = Buffer.concat([data.subarray(0, 12), data.subarray(start)]);
  result.writeUInt32LE(result.length - 8, 4);
  return singleFrame(result) ? PREFIX + result.toString('base64') : null;
}

module.exports = { validScreenshot, canonicalScreenshot };
