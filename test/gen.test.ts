import { Model } from '../src/town/model';
import { makeZone, zoneToPolygon, area, intersectArea } from '../src/town/zones';
import { type FieldGuide, makeGuide } from '../src/town/guide';
import { Pt } from '../src/core/geom';
import { buildRoadNet, type RoadNet } from '../src/road/system';
import { buildScene } from '../src/scene/build';

let failures = 0;
let total = 0;

/** 点到线段距离 */
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function nearestRoad(net: RoadNet, p: Pt): number {
  let best = Infinity;
  for (const e of net.edges) {
    const d = distToSeg(p, e.a, e.b);
    if (d < best) best = d;
  }
  return best;
}

/** 环是否简单（无自交、无重复点） */
function isSimpleRing(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
  }
  return true;
}

function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function run(label: string, opts: ConstructorParameters<typeof Model>[0]) {
  total++;
  const m = new Model(opts);
  const t0 = Date.now();
  try {
    m.generate();
  } catch (e) {
    failures++;
    console.log(`FAIL ${label}: ${(e as Error).message}`);
    return null;
  }
  const ms = Date.now() - t0;
  const s = m.stats();
  console.log(
    `${label}: ${s.patches} 地块 / ${s.buildings} 建筑 / 半径 ${s.radius.toFixed(0)} / ${ms}ms`
  );

  check('有地块', s.patches > 0, `${s.patches}`);
  check('有建筑', s.buildings > 0, `${s.buildings}`);
  // 现代模式没有"城门引出的主街"，路网完全由街网层级给出，所以查道路图而不是 streets
  const edgeCount = buildRoadNet(m).edges.length;
  check('有路网', edgeCount > 0, `${edgeCount} 条边`);
  check('半径合理', s.radius > 20 && s.radius < 5000, `${s.radius}`);
  check(
    '建筑面积为正',
    m.patches.every((p) => p.ward === null || p.ward.geometry.every((g) => g.length >= 3 && g.square > 0.0001))
  );
  check(
    '地块无 NaN',
    m.patches.every((p) => p.shape.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)))
  );
  return m;
}

console.log('=== 基础生成（4 种规模 × 12 seeds）===');
const sizes = [6, 10, 15, 24];
for (const n of sizes) {
  for (let seed = 1; seed <= 12; seed++) {
    run(`size=${n} seed=${seed}`, { nPatches: n, seed, plaza: seed % 2 === 0 });
  }
}

console.log('\n=== 确定性：同种子两次结果一致 ===');
{
  const a = new Model({ nPatches: 15, seed: 42, plaza: true });
  a.generate();
  const b = new Model({ nPatches: 15, seed: 42, plaza: true });
  b.generate();
  check('顶点数一致', a.patches.length === b.patches.length);
  check(
    '几何一致',
    a.patches.length === b.patches.length &&
      a.patches.every((p, i) => p.shape.length === b.patches[i].shape.length && p.shape.every((v, j) => v.x === b.patches[i].shape[j].x))
  );
}

console.log('\n=== rebuild 幂等 ===');
{
  const m = new Model({ nPatches: 15, seed: 7, plaza: true });
  m.generate();
  const before = m.stats();
  m.rebuild();
  const after = m.stats();
  check('rebuild 后建筑数一致', before.buildings === after.buildings, `${before.buildings} vs ${after.buildings}`);
  check('rebuild 后地块数一致', before.patches === after.patches, `${before.patches} vs ${after.patches}`);
}

console.log('\n=== 禁建区 ===');
{
  const zone = makeZone('z1', '广场禁区', { kind: 'rect', a: new Pt(-40, -40), b: new Pt(-5, 5) });
  const m = run('禁建区矩形', { nPatches: 15, seed: 9, plaza: true, zones: [zone] });
  if (m) {
    check('有被禁地块', m.stats().blocked > 0, `${m.stats().blocked}`);
    // 建筑本体不应侵入禁建区（用面积比检查，比"中心点"可靠）
    const zp = zoneToPolygon(zone);
    let violationArea = 0;
    let totalArea = 0;
    for (const patch of m.patches)
      if (patch.ward)
        for (const g of patch.ward.geometry) {
          const a = area(Array.from(g));
          totalArea += a;
          violationArea += intersectArea(Array.from(g), zp);
        }
    const ratio = totalArea > 0 ? violationArea / totalArea : 0;
    check('建筑侵入禁建区面积 < 1%', ratio < 0.01, `${(ratio * 100).toFixed(2)}%`);
    console.log(`  建筑侵入禁建区 ${(ratio * 100).toFixed(2)}%`);
  }
}
{
  const zone = makeZone('z2', '圆形禁区', { kind: 'circle', c: new Pt(30, 30), r: 35 });
  run('禁建区圆形', { nPatches: 24, seed: 3, plaza: true, zones: [zone] });
}
{
  const poly = [
    new Pt(-60, -20),
    new Pt(-10, -50),
    new Pt(20, -10),
    new Pt(-20, 40),
  ];
  const zone = makeZone('z3', '自由多边形', { kind: 'poly', pts: poly });
  run('禁建区多边形', { nPatches: 15, seed: 5, plaza: true, zones: [zone] });
}

console.log('\n=== 路宽可编辑 ===');
{
  // 现代城市的建筑是整块楼栋，加宽道路通常不会让楼"消失"，而是让楼变小。
  // 所以判据用可建面积，而不是栋数。
  // 只统计城内：城外地块的边用的是巷道宽度，本来就不受主干道宽度影响，
  // 混在一起会把城内 1/15 的变化稀释成看不见的 1.7%。
  const blockArea = (m: Model) => {
    let s = 0;
    for (const [patch, w] of m.lots) {
      if (!patch.withinCity) continue;
      if (w.lot?.block) s += Math.abs(w.lot.block.square);
    }
    return s;
  };

  const m = new Model({ nPatches: 15, seed: 11, plaza: true, style: { mainStreetWidth: 2, regularStreetWidth: 1, alleyWidth: 0.6 } });
  m.generate();
  const wideArea = blockArea(m);
  const wide = m.stats().buildings;
  m.style = { ...m.style, mainStreetWidth: 6 };
  m.rebuild();
  const after = m.stats().buildings;
  const narrowArea = blockArea(m);
  check('加宽道路后可建面积减少', narrowArea < wideArea * 0.97, `${wideArea.toFixed(0)} -> ${narrowArea.toFixed(0)}`);
  check('加宽道路后仍有建筑', after > 0, `${after}`);
  console.log(`  道路 2→6 宽：可建面积 ${wideArea.toFixed(0)} -> ${narrowArea.toFixed(0)}，建筑 ${wide} -> ${after}`);
}

console.log('\n=== 拖动拓扑点 ===');
{
  const m = new Model({ nPatches: 15, seed: 21, plaza: true });
  m.generate();
  const v = m.vertices[10];
  const before = { x: v.x, y: v.y };
  const b0 = m.stats().buildings;
  m.moveVertex(v, before.x * 1.08, before.y * 1.08);
  let ok = true;
  try {
    m.rebuild();
  } catch (e) {
    ok = false;
    console.log(`  拖点重建失败: ${(e as Error).message}`);
  }
  check('拖点后重建成功', ok);
  if (ok) {
    check('拖点后仍有建筑', m.stats().buildings > 0, `${m.stats().buildings} (原 ${b0})`);
    console.log(`  顶点 (${before.x.toFixed(1)},${before.y.toFixed(1)}) → 建筑 ${b0} -> ${m.stats().buildings}`);
  }
}

console.log('\n=== 现代城市：土地用途 / 路网 / 场景要素 ===');
{
  const m = new Model({ nPatches: 24, seed: 33, plaza: true });
  m.generate();

  // 1) 用途覆盖
  const uses = new Map<string, number>();
  for (const [, w] of m.lots) uses.set(w.use, (uses.get(w.use) ?? 0) + 1);
  const kinds = [...uses.keys()];
  check('用途种类 ≥ 4', kinds.length >= 4, kinds.join(','));
  for (const want of ['residential', 'park', 'parking', 'cbd']) {
    check(`有 ${want} 地块`, uses.has(want), kinds.join(','));
  }
  console.log(`  用途：${[...uses.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}`);

  // 2) 路网连通：城内任意两条路都能互达
  //    城郊最外一圈会有几个孤立路口（没有内侧邻居、外侧又没地块），
  //    这里只要求"城内（≤0.9R）没有孤立节点"。
  const net = buildRoadNet(m);
  check('有路面', net.edges.length > 0, `${net.edges.length} 条`);
  check('有路口', net.junctions.length > 0, `${net.junctions.length} 个`);
  const adj = new Map<string, Set<string>>();
  const key = (p: Pt) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const posOf = new Map<string, Pt>();
  for (const e of net.edges) {
    for (const p of [e.a, e.b]) {
      const k = key(p);
      if (!adj.has(k)) {
        adj.set(k, new Set());
        posOf.set(k, p);
      }
    }
    adj.get(key(e.a))!.add(key(e.b));
    adj.get(key(e.b))!.add(key(e.a));
  }
  const nodes = [...adj.keys()];
  // 从**连通块最大**的那个点起走，而不是 nodes[0] —— 顶点插入顺序决定了 nodes[0]
  // 可能刚好是城外某个只有一条边的孤立路口，那样这条断言会莫名全红。
  const degSorted = nodes.slice().sort((a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0));
  const seen = new Set<string>();
  const stack = [degSorted[0]];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const nb of adj.get(n) ?? []) if (!seen.has(nb)) stack.push(nb);
  }
  const iso = nodes.filter((k) => !seen.has(k));
  const innerIso = iso.filter((k) => {
    const p = posOf.get(k)!;
    return Math.hypot(p.x, p.y) <= m.cityRadius * 0.9;
  });
  check(
    '城内路网连通',
    innerIso.length === 0,
    `${seen.size}/${nodes.length}，孤立 ${iso.length} 个（城内 ${innerIso.length}）`
  );

  // 3) 建筑不压车行道：建筑角点到最近道路中线的距离应大于半个车行道
  let intrude = 0;
  let minD = Infinity;
  for (const ward of m.lots.values()) {
    const lot = ward.lot;
    if (!lot) continue;
    for (const s of lot.solids) {
      for (const p of s.ring) {
        const d = nearestRoad(net, p);
        if (d < minD) minD = d;
        if (d < 0.12) intrude++;
      }
    }
  }
  check('建筑不压路中线', intrude === 0, `${intrude} 处，最近 ${minD.toFixed(3)}`);
  console.log(`  建筑角点距路中线最近 ${minD.toFixed(2)}`);

  // 4) 场景要素齐全
  const scene = buildScene(m, {});
  const groups = new Set(scene.surfaces.map((s) => s.group));
  check('有路面图层', [...groups].some((g) => g.startsWith('road/surface')));
  check('有人行道图层', [...groups].some((g) => g.startsWith('road/sidewalk')));
  check('有标线图层', [...groups].some((g) => g.startsWith('road/marking')));
  check('有建筑', scene.solids.length > 20, `${scene.solids.length}`);
  check('有树木', scene.props.filter((p) => p.kind.startsWith('tree') || p.kind === 'conifer').length > 20);
  check('有路灯', scene.props.filter((p) => p.kind.startsWith('lamp')).length > 10);
  check('铺装不自交', scene.surfaces.every((s) => isSimpleRing(s.ring)));
  check('建筑不自交', scene.solids.every((s) => isSimpleRing(s.ring)));
  console.log(
    `  场景：铺装 ${scene.surfaces.length} / 体块 ${scene.solids.length} / 道具 ${scene.props.length} / 路径 ${scene.paths.length}`
  );
}

console.log('\n=== 三种街网形态（场线 / 放射环 / 张量场）===');
for (const layout of ['field', 'radial', 'tensor'] as const) {
  for (const nPatches of [10, 24]) {
    const m = new Model({ nPatches, seed: 8, plaza: true, layout });
    try {
      m.generate();
    } catch (e) {
      check(`${layout}-${nPatches} 生成成功`, false, (e as Error).message);
      continue;
    }
    check(`${layout}-${nPatches} 生成成功`, true);
    check(`${layout}-${nPatches} 街区 ≥ 20`, m.patches.length >= 20, `${m.patches.length} 块`);
    check(`${layout}-${nPatches} 城内街区 ≥ 12`, m.inner.length >= 12, `${m.inner.length} 块`);

    // 路网连通：场线切块靠共享顶点保证两侧配对，任何城内断头都会在这里暴露
    const net = buildRoadNet(m);
    const adj = new Map<string, Set<string>>();
    const key = (p: Pt) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    const posOf = new Map<string, Pt>();
    for (const e of net.edges) {
      for (const p of [e.a, e.b]) {
        const k = key(p);
        if (!adj.has(k)) {
          adj.set(k, new Set());
          posOf.set(k, p);
        }
      }
      adj.get(key(e.a))!.add(key(e.b));
      adj.get(key(e.b))!.add(key(e.a));
    }
    const nodes = [...adj.keys()];
    const seen = new Set<string>();
    const stack = [nodes[0]];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) stack.push(nb);
    }
    const innerIso = nodes
      .filter((k) => !seen.has(k))
      .filter((k) => {
        const p = posOf.get(k)!;
        return Math.hypot(p.x, p.y) <= m.cityRadius * 0.9;
      });
    check(
      `${layout}-${nPatches} 城内路网连通`,
      innerIso.length === 0,
      `${seen.size}/${nodes.length}，城内孤立 ${innerIso.length}`
    );

    // 建筑不压车行道
    let intrude = 0;
    for (const ward of m.lots.values()) {
      for (const s of ward.lot?.solids ?? []) {
        for (const p of s.ring) if (nearestRoad(net, p) < 0.1) intrude++;
      }
    }
    check(`${layout}-${nPatches} 建筑不压路中线`, intrude === 0, `${intrude} 处`);

    const uses = new Set([...m.lots.values()].map((w) => w.use));
    check(`${layout}-${nPatches} 用途 ≥ 3 种`, uses.size >= 3, [...uses].join(','));
    console.log(
      `  ${layout}-${nPatches}: ${m.patches.length} 街区 / ${net.edges.length} 路边 / ${m.stats().buildings} 建筑 / 用途 ${uses.size} 种`
    );
  }
}

console.log('\n=== 方向控制线 ===');
{
  // 沿折线带内统计"路网走向 vs 折线方向"的夹角（度）。
  // 关键：张量场本来就产出两族互相正交的街道，垂直那族不是错位，
  // 所以夹角要按 90° 折回，否则一半的边会被当成 90° 偏差，均值永远在 45° 附近。
  const alignOf = (m: Model, guide: FieldGuide) => {
    const net = buildRoadNet(m);
    const band = m.cityRadius * 0.26;
    let sum = 0;
    let w = 0;
    let n = 0;
    for (const e of net.edges) {
      const mid = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
      let best = Infinity;
      let segAng = 0;
      for (let i = 0; i + 1 < guide.pts.length; i++) {
        const a = guide.pts[i];
        const b = guide.pts[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy;
        if (L2 < 1e-9) continue;
        let t = ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(mid.x - (a.x + dx * t), mid.y - (a.y + dy * t));
        if (d < best) {
          best = d;
          segAng = Math.atan2(dy, dx);
        }
      }
      if (best > band) continue;
      const ea = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
      let diff = Math.abs(ea - segAng) % (Math.PI / 2);
      if (diff > Math.PI / 4) diff = Math.PI / 2 - diff;
      const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
      sum += diff * len;
      w += len;
      n++;
    }
    return { deg: w > 0 ? (sum / w) * (180 / Math.PI) : 999, n };
  };

  // 两条线都放在城内：线本身跑到轮廓外会把一圈环路边算进带内，把统计搅浑
  const g1 = makeGuide('t1', '斜线', [new Pt(-55, -30), new Pt(-25, 0), new Pt(0, 28)], 0.8);
  const g2 = makeGuide('t2', '横线', [new Pt(28, 38), new Pt(58, 34)], 0.8);

  const base = run('方向线基线（无向导）', { nPatches: 15, seed: 31, plaza: true, layout: 'tensor' });
  const withG = run('方向线 2 条', {
    nPatches: 15,
    seed: 31,
    plaza: true,
    layout: 'tensor',
    guides: [g1, g2],
  });

  if (base && withG) {
    const b1 = alignOf(base, g1);
    const b2 = alignOf(base, g2);
    const a1 = alignOf(withG, g1);
    const a2 = alignOf(withG, g2);
    console.log(
      `  斜线：无向导 ${b1.deg.toFixed(1)}° (${b1.n} 边) → 有向导 ${a1.deg.toFixed(1)}° (${a1.n} 边)`
    );
    console.log(
      `  横线：无向导 ${b2.deg.toFixed(1)}° (${b2.n} 边) → 有向导 ${a2.deg.toFixed(1)}° (${a2.n} 边)`
    );
    check('斜线带内有足够路边', a1.n > 15, `${a1.n}`);
    check('街道顺着斜线', a1.deg < 10, `${a1.deg.toFixed(1)}°`);
    check('街道顺着横线', a2.deg < 16, `${a2.deg.toFixed(1)}°`);
    check('斜线确实改变了走向', a1.deg < b1.deg - 4, `无 ${b1.deg.toFixed(1)}° 有 ${a1.deg.toFixed(1)}°`);
    check('带向导仍能切出街区', withG.patches.length >= 20, `${withG.patches.length}`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${total} 次生成，${failures} 项断言失败`);
process.exit(failures === 0 ? 0 : 1);
