import { PNG } from "pngjs";
// Preserve the scanline indexing used by pixel assertions, independent of
// the encoder's PNG filters, color type, or compression settings.
export function pngPixels(bytes, width) {
  const image = PNG.sync.read(Buffer.from(bytes));
  const stride = (width ?? image.width) * 4;
  const rows = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++)
    image.data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return rows;
}
