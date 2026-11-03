// Single-Family Detached Grid · Golden Tests（S01~S06）
//
// 这一层验证的是**层级**：一个地块 → 内部路 → 多个宅地 → 多栋住宅。
// 断言的重点不是"多少栋"，而是：每块宅地都有临街、每栋房都有车道、没有无主宅地。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, insideSurface, pointInRing, distToSurfaceEdge } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateSingleFamilyGridCandidates } from '../src/town/planning/archetypes/singlefamily/grid';
import { validateCandidate } from '../src/town/planning/core/candidate';
import { sfProgramViolations, housesWithDriveway } from '../src/town/planning/typologies/singlefamily';
import type { SiteContext, SiteRoadEdge } from '../src/town/planning/core/types';
import type { SitePlanCandidate } from '../src/town/planning/core/candidate';

let fail = 0;
let n = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  n++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  new Pt(x0, y0),
  new Pt(x1, y0),
  new Pt(x1, y1),
  new Pt(x0, y1),
];

const edge = (k: string, a: Pt, b: Pt, c: SiteRoadEdge['cls']): SiteRoadEdge => ({
  key: k,
  a,
  b,
  len: Pt.distance(a, b),
  cls: c,
  carriageSide: c === 'arterial' ? 1.6 : 1.0,
  sidewalk: 0.3,
  median: 0,
});

const ctxOf = (parcel: Pt[], edges: SiteRoadEdge[], holes: Pt[][] = []) =>
  buildSiteContext({ parcelId: 's', parcel: surface(parcel, holes), use: 'residential', edges });

/** SF 质量闸：每栋房有车道、宅地不压房、内部路存在 */
function checkSF(ctx: SiteContext, c: SitePlanCandidate): string[] {
  const bad: string[] = [];
  const houses = c.buildings.filter((b) => b.role === 'house');
  if (houses.length === 0) bad.push('没有住宅');
  if (c.circulation.filter((p) => p.role === 'vehicle').length === 0) bad.push('没有内部路');

  const dw = c.ground.filter((g) => g.program === 'driveway').length;
  if (housesWithDriveway(c) < houses.length) bad.push(`${houses.length - dw} 栋没有车道`);
  if (!c.ground.some((g) => g.program === 'front_yard')) bad.push('没有前院');

  // 宅地（前院）不能被房子压住
  const fy = c.ground.filter((g) => g.program === 'front_yard');
  for (const y of fy) {
    for (const h of houses) {
      if (pointInRing(new Pt(centroid(y.surface.outer).x, centroid(y.surface.outer).y), h.footprint.outer)) {
        bad.push('房子压在前院上');
        break;
      }
    }
  }

  // 房子必须在可建区内
  for (const h of houses) {
    // 落在可建区**边界上**的顶点不算跑出（ray casting 对边界点不稳定）
    const out = h.footprint.outer.filter(
      (p) => !insideSurface(p, ctx.buildableArea) && distToSurfaceEdge(p, ctx.buildableArea) > 0.15
    );
    if (out.length > 0) {
      bad.push(`${out.length} 个房屋顶点跑出可建区`);
      break;
    }
  }
  return bad;
}

const centroid = (r: Pt[]) => ({
  x: r.reduce((a, p) => a + p.x, 0) / Math.max(1, r.length),
  y: r.reduce((a, p) => a + p.y, 0) / Math.max(1, r.length),
});

// ---------------------------------------------------------------- S01 标准地块
{
  const ctx = ctxOf(rect(0, 0, 46, 40), [edge('s', new Pt(0, 0), new Pt(46, 0), 'collector')]);
  const cands = generateSingleFamilyGridCandidates(ctx);
  ok('S01 生成多个候选', cands.length >= 2, `${cands.length}`);
  for (const c of cands) {
    ok(`S01 ${c.id} 结构合法`, validateCandidate(c).length === 0, validateCandidate(c).join('；'));
    ok(`S01 ${c.id} 只用白名单地面`, sfProgramViolations(c).length === 0, sfProgramViolations(c).join(','));
    const bad = checkSF(ctx, c);
    ok(`S01 ${c.id} 通过质量闸`, bad.length === 0, bad.join('；'));
  }
  ok('S01 按分降序', cands.every((c, i) => i === 0 || (cands[i - 1].score ?? 0) >= (c.score ?? 0)));
  console.log(`  S01 候选 ${cands.map((c) => `${c.id.replace('sf-grid-', '')}:${c.score?.toFixed(2)}(${c.buildings.length}栋)`).join(' ')}`);
}

// ---------------------------------------------------------------- S02 狭长地块
{
  // 面宽 34 单位（238 m）、进深 56 单位：环路应被拒，单脊成立
  const ctx = ctxOf(rect(0, 0, 34, 56), [edge('s', new Pt(0, 0), new Pt(34, 0), 'collector')]);
  const cands = generateSingleFamilyGridCandidates(ctx);
  ok('S02 狭长地块有候选', cands.length >= 1, `${cands.length}`);
  ok('S02 单脊成立', cands.some((c) => c.id === 'sf-grid-single-spine'));
  const loop = cands.find((c) => c.id === 'sf-grid-loop');
  ok('S02 环路被拒或分数更低', !loop || loop.score! < cands[0].score!, `${loop?.score}`);
  console.log(`  S02 候选 ${cands.map((c) => c.id.replace('sf-grid-', '')).join(' ')}`);
}

// ---------------------------------------------------------------- S03 宽地块
{
  const ctx = ctxOf(rect(0, 0, 74, 42), [edge('s', new Pt(0, 0), new Pt(74, 0), 'collector')]);
  const cands = generateSingleFamilyGridCandidates(ctx);
  ok('S03 宽地块有候选', cands.length >= 2, `${cands.length}`);
  ok('S03 双脊成立', cands.some((c) => c.id === 'sf-grid-double-spine'));
  ok('S03 双脊有两条内部路', (cands.find((c) => c.id === 'sf-grid-double-spine')?.circulation.length ?? 0) >= 2);
}

// ---------------------------------------------------------------- S04 带洞
{
  const ctx = ctxOf(
    rect(0, 0, 42, 38),
    [edge('s', new Pt(0, 0), new Pt(42, 0), 'collector')],
    [rect(18, 16, 22, 20)]
  );
  const cands = generateSingleFamilyGridCandidates(ctx);
  ok('S04 带洞也能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const hole = new Pt(20, 18);
    const c = cands[0];
    ok('S04 房子不压保留地', !c.buildings.some((b) => insideSurface(hole, b.footprint)));
    const bad = checkSF(ctx, c);
    ok('S04 通过质量闸', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- S05 小地块
{
  // 5×5 单位 ≈ 35×35 m：进深连"前退线 + 房子 + 后院"都放不下，必须明确拒收
  const ctx = ctxOf(rect(0, 0, 5, 5), [edge('s', new Pt(0, 0), new Pt(5, 0), 'collector')]);
  const cands = generateSingleFamilyGridCandidates(ctx);
  ok('S05 小地块明确拒收（NOT_SF_DETACHED_GRID）', cands.length === 0, `${cands.length}`);
}

// ---------------------------------------------------------------- S06 真城
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  const pool = ctxs.filter((c) => c.typology === 'multi_family');
  let tried = 0;
  let produced = 0;
  let bad = 0;
  let lots = 0;
  const winners: string[] = [];
  for (const ctx of pool) {
    tried++;
    const cands = generateSingleFamilyGridCandidates(ctx);
    if (cands.length === 0) continue;
    produced++;
    lots += cands[0].buildings.length;
    winners.push(cands[0].id.replace('sf-grid-', ''));
    const issues = checkSF(ctx, cands[0]);
    if (issues.length > 0) {
      bad++;
      if (bad <= 2) console.log(`    ${ctx.parcelId} 不合格：${issues.join('；')}`);
    }
  }
  ok('S06 真城有住宅地块', tried > 0, `${tried}`);
  ok('S06 有地块能细分', produced > 0, `${produced}/${tried}`);
  ok('S06 生成的方案全部合格', bad === 0, `${bad}/${produced}`);
  console.log(`  S06 真实城市：${tried} 块住宅地，${produced} 块细分成功，共 ${lots} 栋，winner=${[...new Set(winners)].join('/')}`);
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
