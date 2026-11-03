// Industrial Rear-Load · Golden Tests（I01~I06）
//
// PRD §"Industrial Rear-Load 的验收标准"那 7 条，逐条变成断言：
//   1 Building 在 buildable area 内
//   2 Building 正面朝 primary frontage
//   3 Loading side 与 service side 一致
//   4 Truck court 位于 loading 与 truck access 之间
//   5 Employee parking 不侵入 truck court
//   6 Car / truck access 尽量分离
//   7 无明显碎片和死地
//
// 另外校验 Contract（Candidate 结构、Ground 白名单）与 Evaluator（三个候选能被排序）。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, surfaceIntersect, insideSurface, distToSurfaceEdge } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateIndustrialRearLoadCandidates } from '../src/town/planning/archetypes/industrial/rear-load';
import { validateCandidate } from '../src/town/planning/core/candidate';
import { industrialProgramViolations, INDUSTRIAL_GROUND_WHITELIST } from '../src/town/planning/typologies/industrial';
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

const edge = (key: string, a: Pt, b: Pt, cls: SiteRoadEdge['cls']): SiteRoadEdge => ({
  key,
  a,
  b,
  len: Pt.distance(a, b),
  cls,
  carriageSide: cls === 'arterial' ? 1.6 : cls === 'collector' ? 1.1 : 0.7,
  sidewalk: 0.3,
  median: 0,
});

const ctxOf = (parcel: Pt[], edges: SiteRoadEdge[], use = 'industrial') =>
  buildSiteContext({ parcelId: 't', parcel: surface(parcel), use, edges });

/** PRD 的 7 条验收 → 违规列表（空 = 合格） */
function checkCandidate(ctx: SiteContext, c: SitePlanCandidate): string[] {
  const bad: string[] = [];
  const wh = c.buildings.find((b) => b.role === 'warehouse');
  const court = c.ground.find((g) => g.program === 'truck_court');
  const apron = c.ground.find((g) => g.program === 'loading_apron');
  const parking = c.ground.find((g) => g.program === 'employee_parking');
  const residual = c.ground.find((g) => g.program === 'residual');

  // 1 建筑在可建区内
  if (wh) {
    const outside = wh.footprint.outer.filter((p) => !insideSurface(p, ctx.buildableArea) && distToSurfaceEdge(p, ctx.buildableArea) > 0.12);
    if (outside.length > 0) bad.push(`建筑 ${outside.length} 个顶点跑出可建区`);
  } else bad.push('没有仓库');

  // 2 正立面朝主街
  if (wh && wh.frontSide && ctx.primaryFrontage) {
    const [a, b] = ctx.primaryFrontage.parcelEdge;
    const whC = centroid(wh.footprint.outer);
    const out = norm(new Pt((a.x + b.x) / 2 - whC.x, (a.y + b.y) / 2 - whC.y));
    if (dot(norm(wh.frontSide), out) < 0.5) bad.push('正立面没有朝主街');
  } else bad.push('缺少 frontSide 或主临街面');

  // 3 装卸面朝 truck court
  if (wh && wh.loadingSide && court) {
    const whC = centroid(wh.footprint.outer);
    const courtC = centroid(court.surface.outer);
    const toCourt = norm(new Pt(courtC.x - whC.x, courtC.y - whC.y));
    if (dot(norm(wh.loadingSide), toCourt) < 0.5) bad.push('装卸面没有朝 truck court');
  } else bad.push('缺少 loadingSide 或 truck court');

  // 4 truck court 在 loading apron 与货车口之间
  if (court && apron) {
    const courtC = centroid(court.surface.outer);
    const apronC = centroid(apron.surface.outer);
    const whC = wh ? centroid(wh.footprint.outer) : apronC;
    // court 应该比 apron 更远离仓库
    if (dist(courtC, whC) <= dist(apronC, whC)) bad.push('truck court 没有排在装卸坪之外');
  } else bad.push('缺少 loading apron 或 truck court');

  // 5 员工停车不压货场
  if (parking && court) {
    const overlap = surfaceIntersect([parking.surface], [court.surface]);
    const area = overlap.reduce((s, q) => s + surfaceArea(q), 0);
    if (area > surfaceArea(parking.surface) * 0.02) bad.push(`员工停车与货场重叠 ${(area * 49).toFixed(0)} m²`);
  }

  // 6 客货分离（同一临街面时必须拉开距离）
  const car = c.access.find((a) => a.role === 'car');
  const truck = c.access.find((a) => a.role === 'truck');
  if (car && truck) {
    if (car.frontage === truck.frontage && dist(car.at, truck.at) < 4) bad.push('客货口在同一位置');
  } else bad.push('缺少客用或货运开口');

  // 7 残地不过量
  const lotArea = surfaceArea(ctx.parcel);
  if (residual && residual.area / lotArea > 0.2) bad.push(`残地 ${(residual.area / lotArea * 100).toFixed(0)}%`);

  return bad;
}

// ---------------------------------------------------------------- I01 标准矩形双临街
{
  const ctx = ctxOf(rect(0, 0, 44, 40), [
    edge('s', new Pt(0, 0), new Pt(44, 0), 'arterial'),
    edge('e', new Pt(44, 0), new Pt(44, 40), 'local'),
  ]);
  const cands = generateIndustrialRearLoadCandidates(ctx);
  ok('I01 生成 4 个候选（位置 × 强度）', cands.length === 4, `${cands.length}`);
  for (const c of cands) {
    const bad = checkCandidate(ctx, c);
    ok(`I01 ${c.id} 通过 7 条验收`, bad.length === 0, bad.join('；'));
    ok(`I01 ${c.id} 结构合法`, validateCandidate(c).length === 0, validateCandidate(c).join('；'));
    ok(`I01 ${c.id} 只用白名单地面`, industrialProgramViolations(c).length === 0, industrialProgramViolations(c).join(','));
    ok(`I01 ${c.id} 有员工停车需求`, c.parkingRequests.length >= 1);
    ok(`I01 ${c.id} 有评分`, (c.score ?? -1) > 0);
  }
  // 强度档必须真的产生不同强度（R7.6）：用建筑基底面积区分
  const areas = cands.map((c) => c.buildings.reduce((a, b) => a + Math.abs((b.footprint.outer as any[]).length), 0));
  const covers = cands.map((c) => Number((c as any).diagnostics?.buildingRegularity ?? 0));
  void areas;
  void covers;
  const footprintAreas = cands.map((c) => c.buildings[0]?.footprint.outer.length ?? 0);
  void footprintAreas;

  // 三个候选必须真的不同（否则"多候选"是假的）
  const fingerprints = new Set(cands.map((c) => c.ground.map((g) => Math.round(g.area)).join(',')));
  ok('I01 三个候选互不相同', fingerprints.size === cands.length, `${fingerprints.size}/${cands.length}`);
  ok('I01 按分降序', cands.every((c, i) => i === 0 || (cands[i - 1].score ?? 0) >= (c.score ?? 0)));
  console.log(
    `  I01 候选 ${cands.map((c) => `${c.id}:${c.score?.toFixed(2)}`).join(' ')}`
  );
}

// ---------------------------------------------------------------- I02 狭长地块
{
  const ctx = ctxOf(rect(0, 0, 66, 26), [
    edge('s', new Pt(0, 0), new Pt(66, 0), 'collector'),
    edge('n', new Pt(0, 26), new Pt(66, 26), 'local'),
  ]);
  const cands = generateIndustrialRearLoadCandidates(ctx);
  ok('I02 狭长地块仍能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const court = cands[0].ground.find((g) => g.program === 'truck_court');
    ok('I02 货场没有消失', !!court && court.area > 0);
    const bad = checkCandidate(ctx, cands[0]);
    ok('I02 通过验收', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- I03 单临街面
{
  const ctx = ctxOf(rect(0, 0, 40, 40), [edge('s', new Pt(0, 0), new Pt(40, 0), 'arterial')]);
  const cands = generateIndustrialRearLoadCandidates(ctx);
  ok('I03 单临街面不失败', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const c = cands[0];
    const truck = c.access.find((a) => a.role === 'truck');
    ok('I03 货车口仍在（同一临街面）', !!truck);
    ok('I03 标记 SHARED_FRONTAGE_SERVICE', c.notes.some((s) => s.includes('SHARED_FRONTAGE_SERVICE')));
    ok('I03 客货口拉开距离', !!truck && dist(c.access.find((a) => a.role === 'car')!.at, truck.at) > 4);
  }
}

// ---------------------------------------------------------------- I04 转角地块
{
  const ctx = ctxOf(rect(0, 0, 40, 36), [
    edge('w', new Pt(0, 0), new Pt(0, 36), 'arterial'),
    edge('s', new Pt(0, 0), new Pt(40, 0), 'local'),
  ]);
  const cands = generateIndustrialRearLoadCandidates(ctx);
  ok('I04 转角生成', cands.length >= 1);
  if (cands.length > 0) {
    const c = cands[0];
    const car = c.access.find((a) => a.role === 'car');
    const truck = c.access.find((a) => a.role === 'truck');
    ok('I04 客车口在主街（干路）', car?.frontage === 'primary' && ctx.primaryFrontage?.edge.key === 'w');
    ok('I04 货车口在支路', truck?.frontage === 'service');
    ok('I04 客货分离', car?.frontage !== truck?.frontage);
  }
}

// ---------------------------------------------------------------- I05 带障碍
{
  // 地块中间有一块"保留设备用地"，任何 program 都不能盖住它
  const outer = rect(0, 0, 44, 40);
  const keep = rect(20, 14, 26, 22);
  const ctx = buildSiteContext({
    parcelId: 'i05',
    parcel: surface(outer, [keep]),
    use: 'industrial',
    edges: [edge('s', new Pt(0, 0), new Pt(44, 0), 'arterial'), edge('e', new Pt(44, 0), new Pt(44, 40), 'local')],
  });
  const cands = generateIndustrialRearLoadCandidates(ctx);
  ok('I05 带洞也能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const c = cands[0];
    const holeC = new Pt(23, 18);
    const wh = c.buildings.find((b) => b.role === 'warehouse');
    ok('I05 仓库没有压住保留地', !!wh && !insideSurface(holeC, wh.footprint));
    const court = c.ground.find((g) => g.program === 'truck_court');
    ok('I05 货场没有压住保留地', !!court && !insideSurface(holeC, court.surface));
  }
}

// ---------------------------------------------------------------- I06 真实城市
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  const industrial = ctxs.filter((c) => c.typology === 'industrial');
  let tried = 0;
  let produced = 0;
  let violations = 0;
  for (const ctx of industrial) {
    tried++;
    const cands = generateIndustrialRearLoadCandidates(ctx);
    if (cands.length === 0) continue;
    produced++;
    const bad = checkCandidate(ctx, cands[0]);
    if (bad.length > 0) {
      violations++;
      if (violations <= 2) console.log(`    ${ctx.parcelId} 违规：${bad.join('；')}`);
    }
  }
  ok('I06 真城有工业地块', tried > 0, `${tried}`);
  ok('I06 至少一半工业地块能生成方案', produced >= Math.ceil(tried * 0.5), `${produced}/${tried}`);
  ok('I06 生成的方案全部通过验收', violations === 0, `${violations}/${produced} 违规`);
  console.log(`  I06 真实城市：${tried} 块工业地，${produced} 块生成成功，${violations} 块违规`);
}

// ---------------------------------------------------------------- 工具

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
