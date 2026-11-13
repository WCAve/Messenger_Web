/**
 * Making a large photo smaller before it's uploaded (in the browser, so nothing big travels): when it's
 * over 4 MB, over 4096 px on a side, or in a format the networks handle badly (BMP …). It becomes a JPEG
 * (or a PNG when it has transparent parts) of at most 4096 px. The message box says so, and offers to
 * send the original as a file instead. What the browser can't read (iPhone photos in Chrome, TIFF) is
 * left to the server (server/src/convert.ts).
 */
export const SHRINK_OVER = 4 * 1024 * 1024;
const MAX_SIDE = 4096;
const AWKWARD = /^image\/(bmp|x-ms-bmp|x-bmp|x-icon|vnd\.microsoft\.icon|x-portable-\w+)$/;

export function mightShrink(file: File) {
  return file.type.startsWith('image/') && !/gif|svg/.test(file.type) && (file.size > SHRINK_OVER || AWKWARD.test(file.type) || file.size > 1024 * 1024);
}

export async function shrinkPhoto(file: File): Promise<File | null> {
  if (!mightShrink(file)) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null; // a format this browser can't read: the server converts it
  }
  try {
    const longest = Math.max(bmp.width, bmp.height);
    if (file.size <= SHRINK_OVER && longest <= MAX_SIDE && !AWKWARD.test(file.type)) return null;
    const scale = Math.min(1, MAX_SIDE / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const png = !/jpe?g/.test(file.type) && hasTransparency(bmp);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.85));
    if (!blob || (blob.size >= file.size && !AWKWARD.test(file.type))) return null;
    const name = (file.name.replace(/\.[^./]{1,8}$/, '') || 'photo') + (png ? '.png' : '.jpg');
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  } finally {
    bmp.close();
  }
}

/** Any see-through pixels? Checked on a small copy. */
function hasTransparency(bmp: ImageBitmap) {
  const c = document.createElement('canvas');
  c.width = Math.min(64, bmp.width);
  c.height = Math.min(64, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}
