// Retail Strip · Golden Tests（R01~R05）
//
// 零售验证的是第三套关系：**建筑 frontage + 前方/侧后大停车 + 顾客动线 + 后侧服务**。
// 断言集中在"顾客与货车不打架、店铺真的临街、停车够大但不吃店铺"。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, insideSurface } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateRetailStripCandidates } from '../src/town/planning/archetypes/retail/strip';
import { validateCandidate } from '../src/town/planning/core/candidate';
import { retailProgramViolations, parkingOverlapsShop, retailCoverageFit, retailParkingFit, RETAIL_INTENSITY } from '../src/town/planning/typologies/retail';
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
  buildSiteContext({ parcelId: 'r', parcel: surface(parcel, holes), use: 'commercial', edges });

/** 零售的质量闸 */
function checkRetail(ctx: SiteContext, c: SitePlanCandidate): string[] {
  const bad: string[] = [];
  const shop = c.buildings[0];
  const parking = c.ground.find((g) => g.program === 'parking');
  const car = c.access.find((a) => a.role === 'car');
  const svc = c.access.find((a) => a.role === 'service');

  const noParking = c.notes.some((t) => t.includes('NO_PARKING'));
  if (!shop) bad.push('没有店铺');
  if (!parking && !noParking) bad.push('没有顾客停车');
  if (!c.access.some((a) => a.role === 'pedestrian')) bad.push('没有顾客入口');
  if (parkingOverlapsShop(c) > (parking?.area ?? 1) * 0.05) bad.push('停车压店铺');
  if (!noParking && (!parking || parking.area / Math.max(1e-6, surfaceArea(ctx.parcel)) < 0.12)) bad.push('停车区过小');

  // 顾客口与服务口不能在同一条边（卸货穿过顾客区）
  if (car && svc && car.frontage === svc.frontage) {
    const shared = c.notes.some((t) => t.includes('SHARED_FRONTAGE_SERVICE'));
    if (!shared) bad.push('顾客口与卸货口共用一条边');
  }
  return bad;
}

// ---------------------------------------------------------------- R01 标准双临街
{
  const ctx = ctxOf(rect(0, 0, 16, 12), [
    edge('s', new Pt(0, 0), new Pt(16, 0), 'arterial'),
    edge('e', new Pt(16, 0), new Pt(16, 12), 'local'),
  ]);
  const cands = generateRetailStripCandidates(ctx);
  ok('R01 生成 3 个候选', cands.length === 3, `${cands.length}`);
  for (const c of cands) {
    ok(`R01 ${c.id} 结构合法`, validateCandidate(c).length === 0, validateCandidate(c).join('；'));
    ok(`R01 ${c.id} 只用白名单地面`, retailProgramViolations(c).length === 0, retailProgramViolations(c).join(','));
    const bad = checkRetail(ctx, c);
    ok(`R01 ${c.id} 通过质量闸`, bad.length === 0, bad.join('；'));
  }
  ok('R01 按分降序', cands.every((c, i) => i === 0 || (cands[i - 1].score ?? 0) >= (c.score ?? 0)));
  console.log(`  R01 候选 ${cands.map((c) => `${c.id.replace('ret-strip-', '')}:${c.score?.toFixed(2)}`).join(' ')}`);
}

// ---------------------------------------------------------------- R02 停车比例
{
  const ctx = ctxOf(rect(0, 0, 16, 12), [
    edge('s', new Pt(0, 0), new Pt(16, 0), 'arterial'),
    edge('e', new Pt(16, 0), new Pt(16, 12), 'local'),
  ]);
  const cands = generateRetailStripCandidates(ctx);
  for (const c of cands) {
    const p = c.ground.find((g) => g.program === 'parking');
    const ratio = p ? p.area / surfaceArea(ctx.parcel) : 0;
    // 零售停车通常占 20%~50%；低于 12% 在 checkRetail 里已判不合格
    ok(`R02 ${c.id} 停车比例合理`, ratio >= 0.12 && ratio <= 0.62, `${(ratio * 100).toFixed(0)}%`);
  }
}

// ---------------------------------------------------------------- R03 单面临街
{
  const ctx = ctxOf(rect(0, 0, 18, 13), [edge('s', new Pt(0, 0), new Pt(18, 0), 'collector')]);
  const cands = generateRetailStripCandidates(ctx);
  ok('R03 单面临街不失败', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    ok('R03 标记共享服务口', cands[0].notes.some((t) => t.includes('SHARED_FRONTAGE_SERVICE')));
    const bad = checkRetail(ctx, cands[0]);
    ok('R03 通过质量闸', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- R04 带洞（保留现状）
{
  const ctx = ctxOf(
    rect(0, 0, 16, 13),
    [edge('s', new Pt(0, 0), new Pt(16, 0), 'arterial'), edge('e', new Pt(16, 0), new Pt(16, 13), 'local')],
    [rect(6, 5, 9, 8)]
  );
  const cands = generateRetailStripCandidates(ctx);
  ok('R04 带洞也能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const hole = new Pt(7.5, 6.5);
    const c = cands[0];
    ok('R04 店铺不压保留地', !c.buildings.some((b) => insideSurface(hole, b.footprint)));
    const p = c.ground.find((g) => g.program === 'parking');
    ok('R04 停车不压保留地', !p || !insideSurface(hole, p.surface));
  }
}

// ---------------------------------------------------------------- R05 真城商业地块
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  const retail = ctxs.filter((c) => c.typology === 'retail');
  let tried = 0;
  let produced = 0;
  let bad = 0;
  for (const ctx of retail) {
    tried++;
    const cands = generateRetailStripCandidates(ctx);
    if (cands.length === 0) continue;
    produced++;
    const issues = checkRetail(ctx, cands[0]);
    if (issues.length > 0) {
      bad++;
      if (bad <= 2) console.log(`    ${ctx.parcelId} 不合格：${issues.join('；')}`);
    }
  }
  ok('R05 真城有商业地块', tried > 0, `${tried}`);
  ok('R05 相当比例能生成', produced >= Math.ceil(tried * 0.3), `${produced}/${tried}`);
  ok('R05 生成的方案全部合格', bad === 0, `${bad}/${produced}`);
  console.log(`  R05 真实城市：${tried} 块商业地，${produced} 块生成成功，${bad} 块不合格`);
}

// ---------------------------------------------------------------- R06 强度带（R7.7 校准）
{
  const fitAt = (v: number) => RETAIL_INTENSITY && retailCoverageFit(v);
  ok('R06 带内满分', fitAt(0.21) > 0.98, `${fitAt(0.21).toFixed(3)}`);
  ok('R06 过密扣分', fitAt(0.33) < 0.3, `${fitAt(0.33).toFixed(3)}`);
  ok('R06 过稀扣分', fitAt(0.13) < 0.8, `${fitAt(0.13).toFixed(3)}`);
  ok('R06 单调：带内 > 过密', fitAt(0.21) > fitAt(0.32), `${fitAt(0.21).toFixed(2)} vs ${fitAt(0.32).toFixed(2)}`);
  ok('R06 单调：带内 > 过稀', fitAt(0.21) > fitAt(0.12), `${fitAt(0.21).toFixed(2)} vs ${fitAt(0.12).toFixed(2)}`);
}

// ---------------------------------------------------------------- R07 停车不再"越多越好"
{
  // 旧口径 parkRatio / 0.32 封顶：35% 和 61% 都是满分，等于把"停车场配一间店"判成最优
  ok('R07 30%±4 仍是高分', retailParkingFit(0.34) > 0.9, `${retailParkingFit(0.34).toFixed(3)}`);
  ok('R07 60% 反而不如 34%', retailParkingFit(0.6) < retailParkingFit(0.34) - 0.2,
    `${retailParkingFit(0.6).toFixed(3)} vs ${retailParkingFit(0.34).toFixed(3)}`);
  ok('R07 10% 明显不足', retailParkingFit(0.1) < 0.4, `${retailParkingFit(0.1).toFixed(3)}`);
}

// ---------------------------------------------------------------- R08 真城 winner 全部落在强度带内
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 15, seed: 682063530, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net }).filter((c) => c.typology === 'retail');
  const covs: number[] = [];
  for (const ctx of ctxs) {
    const cands = generateRetailStripCandidates(ctx);
    if (cands.length === 0) continue;
    const lot = surfaceArea(ctx.parcel);
    covs.push(cands[0].buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0) / lot);
  }
  covs.sort((a, b) => a - b);
  const out = covs.filter((v) => v < RETAIL_INTENSITY.min || v > RETAIL_INTENSITY.max);
  ok('R08 有足够样本', covs.length >= 10, `${covs.length}`);
  ok('R08 winner 全部落在强度带内', out.length === 0, `${out.map((v) => (v * 100).toFixed(0) + '%').join(',')}`);
  console.log(
    `  R08 真实城市 ${covs.length} 块 winner 覆盖度：P10 ${(covs[Math.floor(covs.length * 0.1)] * 100).toFixed(0)}% ` +
      `P50 ${(covs[Math.floor(covs.length * 0.5)] * 100).toFixed(0)}% max ${(covs[covs.length - 1] * 100).toFixed(0)}% ` +
      `（目标带 ${(RETAIL_INTENSITY.preferredMin * 100).toFixed(0)}~${(RETAIL_INTENSITY.preferredMax * 100).toFixed(0)}%，硬上限 ${(RETAIL_INTENSITY.max * 100).toFixed(0)}%）`
  );
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
