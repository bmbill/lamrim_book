import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'src-assets', 'app-icon-source.png');
const outDir = path.join(root, 'public', 'icons');

await mkdir(outDir, { recursive: true });

/** 以較短邊為邊長，從畫面中央裁成正方形，再縮放（橫圖會保留中央書本） */
async function squareIcon(size, filename) {
  const meta = await sharp(src).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error('無法讀取來源圖尺寸');
  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top = Math.floor((h - side) / 2);
  await sharp(src)
    .extract({ left, top, width: side, height: side })
    .resize(size, size, { fit: 'fill' })
    .png()
    .toFile(path.join(outDir, filename));
}

await squareIcon(192, 'icon-192.png');
await squareIcon(512, 'icon-512.png');
console.log('已輸出 public/icons/icon-192.png、icon-512.png');
