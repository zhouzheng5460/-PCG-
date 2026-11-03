// Hotel Gurban · Golden Tests（H01~H07）
//
// 酒店验证的是"到达序列"：Road → Guest Vehicle → Drop-off → Lobby → Hotel，
// 以及与之并行、**不能相交**的后勤线。断言全部围绕这两串。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, insideSurface, pointInRing } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateHotelGurbanCandidates } from '../src/town/planning/archetypes/hotel/gurban';
import { validateCandidate } from '../src/town/planning/core/candidate';
import { hotelProgramViolations } from '../src/town/planning/typologies/hotel';
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
  buildSiteContext({ parcelId: 'h', parcel: surface(parcel, holes), use: 'commercial', edges });

/** 酒店质量闸：到达序列 + 客货分离 + 停车不占主街 */
function checkHotel(ctx: SiteContext, c: SitePlanCandidate): string[] {
  const bad: string[] = [];
  const arrival = c.ground.find((g) => g.program === 'arrival_court');
  const drop = c.ground.find((g) => g.program === 'dropoff');
  const park = c.ground.find((g) => g.program === 'parking');
  const car = c.access.find((a) => a.role === 'car');
  const lobby = c.access.find((a) => a.role === 'main_lobby');
  const svc = c.access.find((a) => a.role === 'service');

  if (c.buildings.length === 0) bad.push('没有酒店主体');
  if (!arrival) bad.push('没有到达院');
  if (!drop) bad.push('没有落客带');
  if (!car) bad.push('没有车行入口');
  if (!lobby) bad.push('没有大堂锚点');
  if (drop && lobby && !pointInRing(lobby.at, drop.surface.outer)) {
    // 大堂锚点应在到达院里（与落客带同一片空间）
    if (!arrival || !pointInRing(lobby.at, arrival.surface.outer)) bad.push('大堂锚点不在到达院内');
  }

  // 落客带够深（不能压缩成 1~2 m 假装成立）
  if (drop) {
    const b = bboxOf(drop.surface.outer);
    const dM = Math.min((b.maxX - b.minX), (b.maxY - b.minY)) * 7;
    if (dM < 10) bad.push(`落客带过浅（${dM.toFixed(0)} m）`);
  }

  // 停车不占主街正面（否则就成了 Retail Strip）
  if (park && ctx.primaryFrontage) {
    const [a, b] = ctx.primaryFrontage.parcelEdge;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (pointInRing(mid, park.surface.outer)) bad.push('停车占了主街正面');
  }

  // 客人 / 后勤不能共用一个口（共享 frontage 时必须有标注）
  if (car && svc && car.frontage === svc.frontage) {
    const shared = c.notes.some((t) => t.includes('SHARED_HOTEL_SERVICE_FRONTAGE'));
    if (!shared) bad.push('客人入口与后勤入口同一条边且未标注');
  }
  return bad;
}

// ---------------------------------------------------------------- H01 标准双临街
{
  const ctx = ctxOf(rect(0, 0, 18, 16), [
    edge('s', new Pt(0, 0), new Pt(18, 0), 'arterial'),
    edge('e', new Pt(18, 0), new Pt(18, 16), 'local'),
  ]);
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H01 生成 4 个候选', cands.length === 4, `${cands.length}`);
  for (const c of cands) {
    ok(`H01 ${c.id} 结构合法`, validateCandidate(c).length === 0, validateCandidate(c).join('；'));
    ok(`H01 ${c.id} 只用白名单地面`, hotelProgramViolations(c).length === 0, hotelProgramViolations(c).join(','));
    const bad = checkHotel(ctx, c);
    ok(`H01 ${c.id} 通过质量闸`, bad.length === 0, bad.join('；'));
    ok(`H01 ${c.id} 客人走主街`, c.access.some((a) => a.role === 'car' && a.frontage === 'primary'));
    ok(`H01 ${c.id} 后勤走次街`, c.access.some((a) => a.role === 'service' && a.frontage === 'service'));
  }
  ok('H01 按分降序', cands.every((c, i) => i === 0 || (cands[i - 1].score ?? 0) >= (c.score ?? 0)));
  console.log(`  H01 候选 ${cands.map((c) => `${c.id.replace('hotel-gurban-', '')}:${c.score?.toFixed(2)}`).join(' ')}`);
}

// ---------------------------------------------------------------- H02 单临街面
{
  const ctx = ctxOf(rect(0, 0, 19, 15), [edge('s', new Pt(0, 0), new Pt(19, 0), 'collector')]);
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H02 单面临街不失败', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    ok('H02 标注共享后勤 frontage', cands[0].notes.some((t) => t.includes('SHARED_HOTEL_SERVICE_FRONTAGE')));
    const bad = checkHotel(ctx, cands[0]);
    ok('H02 通过质量闸', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- H03 转角地块
{
  const ctx = ctxOf(rect(0, 0, 17, 16), [
    edge('w', new Pt(0, 0), new Pt(0, 16), 'arterial'),
    edge('s', new Pt(0, 0), new Pt(17, 0), 'local'),
  ]);
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H03 转角生成', cands.length >= 1);
  if (cands.length > 0) {
    const c = cands[0];
    ok('H03 客人入口在主街（干路）', c.access.some((a) => a.role === 'car' && a.frontage === 'primary'));
    ok('H03 后勤在支路', c.access.some((a) => a.role === 'service' && a.frontage === 'service'));
  }
}

// ---------------------------------------------------------------- H04 狭长地块
{
  // 面宽窄、进深大：centered 会被判无效，side-dropoff / rear-parking 应成立
  const ctx = ctxOf(rect(0, 0, 9, 20), [edge('s', new Pt(0, 0), new Pt(9, 0), 'collector')]);
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H04 狭长地块仍能生成', cands.length >= 1, `${cands.length}`);
  ok('H04 有侧向落客或后侧停车形态', cands.some((c) => c.id === 'hotel-gurban-side-dropoff' || c.id === 'hotel-gurban-rear-parking'));
  if (cands.length > 0) {
    const bad = checkHotel(ctx, cands[0]);
    ok('H04 最优候选通过质量闸', bad.length === 0, bad.join('；'));
  }
  console.log(`  H04 候选 ${cands.map((c) => c.id.replace('hotel-gurban-', '')).join(' ')}`);
}

// ---------------------------------------------------------------- H05 带洞
{
  const ctx = ctxOf(
    rect(0, 0, 18, 17),
    [edge('s', new Pt(0, 0), new Pt(18, 0), 'arterial'), edge('e', new Pt(18, 0), new Pt(18, 17), 'local')],
    [rect(7, 8, 10, 11)]
  );
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H05 带洞也能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const hole = new Pt(8.5, 9.5);
    const c = cands[0];
    ok('H05 酒店不压保留地', !c.buildings.some((b) => insideSurface(hole, b.footprint)));
    for (const g of c.ground) {
      if (['arrival_court', 'dropoff', 'parking', 'amenity'].includes(g.program)) {
        ok(`H05 ${g.program} 不压保留地`, !insideSurface(hole, g.surface), g.program);
      }
    }
  }
}

// ---------------------------------------------------------------- H06 小地块
{
  // 6×6 单位 ≈ 42×42 m：落客 12 m + 到达院 6 m + 酒店 24 m + 服务 7 m = 49 m > 42 m，
  // 放不下就必须明确拒收，不能把落客带压成 1~2 m 假装成立
  const ctx = ctxOf(rect(0, 0, 6, 6), [edge('s', new Pt(0, 0), new Pt(6, 0), 'collector')]);
  const cands = generateHotelGurbanCandidates(ctx);
  ok('H06 小地块明确拒收（不假装成立）', cands.length === 0, `${cands.length}`);
}

// ---------------------------------------------------------------- H07 真城
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  // 酒店的候选池：商业 / 商务地块里面积够大的
  const pool = ctxs.filter((c) => (c.typology === 'retail' || c.use === 'cbd') && surfaceArea(c.parcel) > 20);
  let tried = 0;
  let produced = 0;
  let bad = 0;
  const winners: string[] = [];
  for (const ctx of pool) {
    tried++;
    const cands = generateHotelGurbanCandidates(ctx);
    if (cands.length === 0) continue;
    produced++;
    winners.push(cands[0].id.replace('hotel-gurban-', ''));
    const issues = checkHotel(ctx, cands[0]);
    if (issues.length > 0) {
      bad++;
      if (bad <= 2) console.log(`    ${ctx.parcelId} 不合格：${issues.join('；')}`);
    }
  }
  ok('H07 真城有候选地块', tried > 0, `${tried}`);
  ok('H07 至少一半能生成', produced >= Math.ceil(tried * 0.5), `${produced}/${tried}`);
  ok('H07 生成的方案全部合格', bad === 0, `${bad}/${produced}`);
  console.log(`  H07 真实城市：${tried} 块候选地，${produced} 块生成成功，${bad} 块不合格，winner=${[...new Set(winners)].join('/')}`);
}

// ---------------------------------------------------------------- 工具
function bboxOf(ring: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
