import sharp from 'sharp';
import { readdirSync } from 'node:fs';
for (const f of readdirSync('out').filter(f => f.endsWith('.svg'))) {
  const name = f.replace('.svg', '.png');
  await sharp('out/' + f, { density: 96 }).resize({ width: 1100 }).png().toFile('out/' + name);
  console.log('ok', name);
}
