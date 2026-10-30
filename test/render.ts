import { writeFileSync, mkdirSync } from 'node:fs';
import { Model } from '../src/town/model';
import { renderSVG } from '../src/render/svg';
import { makeZone } from '../src/town/zones';
import { Pt } from '../src/core/geom';

mkdirSync('out', { recursive: true });

const zone = makeZone('z1', '禁建', { kind: 'rect', a: new Pt(-45, -20), b: new Pt(-10, 25) });

const cases: {
  name: string;
  opts: ConstructorParameters<typeof Model>[0] & { zones?: ReturnType<typeof makeZone>[] };
}[] = [
  { name: 'city-modern-24', opts: { nPatches: 24, seed: 8, plaza: true } },
  { name: 'city-modern-15', opts: { nPatches: 15, seed: 682063530, plaza: true } },
  { name: 'city-modern-zone', opts: { nPatches: 24, seed: 8, plaza: true, zones: [zone] } },
  // 三种街网形态，同种子同规模，只换布局
  { name: 'layout-grid', opts: { nPatches: 24, seed: 8, plaza: true, layout: 'grid' } },
  { name: 'layout-field', opts: { nPatches: 24, seed: 8, plaza: true, layout: 'field' } },
  { name: 'layout-radial', opts: { nPatches: 24, seed: 8, plaza: true, layout: 'radial' } },
  { name: 'layout-tensor', opts: { nPatches: 24, seed: 8, plaza: true, layout: 'tensor' } },
  { name: 'city-15', opts: { nPatches: 15, seed: 682063530, plaza: true } },
  { name: 'city-24', opts: { nPatches: 24, seed: 12, plaza: true } },
  { name: 'town-10', opts: { nPatches: 10, seed: 4, plaza: true } },
];

for (const c of cases) {
  const m = new Model(c.opts);
  m.generate();
  const svg = renderSVG(m, {
    showPatches: false,
    showZones: true,
    zones: c.opts.zones ?? [],
  });
  writeFileSync(`out/${c.name}.svg`, svg);
  console.log(`${c.name}: ${m.stats().buildings} 建筑`);
}
