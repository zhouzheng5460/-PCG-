// Data Center Single Hall · Golden Tests（D01~D06）
//
// 验证的是第五套语法：**设施邻接 + 后勤可达 + 安防纵深**。
// 共同断言：mechanical / electrical 必须贴着 data hall，不能被停车或景观隔开。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, insideSurface } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateDataCenterSingleHallCandidates } from '../src/town/planning/archetypes/datacenter/single-hall';
import { validateCandidate } from '../src/town/planning/core/candidate';
import { dcProgramViolations, yardSeparatedFromHall, adjacencyScore } from '../src/town/planning/typologies/datacenter';
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
  buildSiteContext({ parcelId: 'd', parcel: surface(parcel, holes), use: 'industrial', edges });

/** DC 质量闸 */
function checkDC(ctx: SiteContext, c: SitePlanCandidate): string[] {
  const bad: string[] = [];
  const hall = c.buildings[0];
  if (!hall) bad.push('没有 data hall');
  if (hall && hall.role !== 'hall') bad.push(`主体角色应为 hall（当前 ${hall.role}）`);

  // 共同断言：设备场必须贴着 hall
  bad.push(...yardSeparatedFromHall(c));

  // 安防缓冲：hall 不能贴地块红线
  if (hall) {
    let minD = Infinity;
    for (const p of hall.footprint.outer) {
      for (let i = 0; i < ctx.parcel.outer.length; i++) {
        const a = ctx.parcel.outer[i];
        const b = ctx.parcel.outer[(i + 1) % ctx.parcel.outer.length];
        minD = Math.min(minD, distToSeg(p, a, b));
      }
    }
    if (minD * 7 < 4) bad.push(`hall 离红线只有 ${(minD * 7).toFixed(1)} m`);
  }

  // 员工门 / 后勤门不能挤在一起（共享 frontage 时要有标注）
  const staff = c.access.find((a) => a.role === 'car');
  const svc = c.access.find((a) => a.role === 'service');
  if (staff && svc) {
    if (staff.frontage === svc.frontage) {
      const shared = c.notes.some((t) => t.includes('SHARED_DC_SERVICE_FRONTAGE'));
      const d = Math.hypot(staff.at.x - svc.at.x, staff.at.y - svc.at.y);
      if (!shared && d < 6) bad.push('员工门与后勤门过近且未标注');
    }
  }

  // 停车不能吃掉设备场（面积上限）
  const park = c.ground.find((g) => g.program === 'parking');
  if (park && park.area / Math.max(1e-6, surfaceArea(ctx.parcel)) > 0.2) bad.push('停车占比过大');
  return bad;
}

// ---------------------------------------------------------------- D01 标准双临街
{
  const ctx = ctxOf(rect(0, 0, 20, 18), [
    edge('s', new Pt(0, 0), new Pt(20, 0), 'arterial'),
    edge('e', new Pt(20, 0), new Pt(20, 18), 'local'),
  ]);
  const cands = generateDataCenterSingleHallCandidates(ctx);
  ok('D01 生成 4 个候选', cands.length === 4, `${cands.length}`);
  for (const c of cands) {
    ok(`D01 ${c.id} 结构合法`, validateCandidate(c).length === 0, validateCandidate(c).join('；'));
    ok(`D01 ${c.id} 只用白名单地面`, dcProgramViolations(c).length === 0, dcProgramViolations(c).join(','));
    const bad = checkDC(ctx, c);
    ok(`D01 ${c.id} 通过质量闸`, bad.length === 0, bad.join('；'));
    ok(`D01 ${c.id} 员工走主街`, c.access.some((a) => a.role === 'car' && a.frontage === 'primary'));
    ok(`D01 ${c.id} 后勤走次街`, c.access.some((a) => a.role === 'service' && a.frontage === 'service'));
  }
  ok('D01 按分降序', cands.every((c, i) => i === 0 || (cands[i - 1].score ?? 0) >= (c.score ?? 0)));
  console.log(`  D01 候选 ${cands.map((c) => `${c.id.replace('dc-single-', '')}:${c.score?.toFixed(2)}`).join(' ')}`);
}

// ---------------------------------------------------------------- D02 单临街
{
  const ctx = ctxOf(rect(0, 0, 21, 17), [edge('s', new Pt(0, 0), new Pt(21, 0), 'collector')]);
  const cands = generateDataCenterSingleHallCandidates(ctx);
  ok('D02 单临街不失败', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    ok('D02 标注共享后勤 frontage', cands[0].notes.some((t) => t.includes('SHARED_DC_SERVICE_FRONTAGE')));
    const bad = checkDC(ctx, cands[0]);
    ok('D02 通过质量闸', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- D03 带洞
{
  const ctx = ctxOf(
    rect(0, 0, 22, 20),
    [edge('s', new Pt(0, 0), new Pt(22, 0), 'arterial'), edge('e', new Pt(22, 0), new Pt(22, 20), 'local')],
    [rect(9, 9, 12, 12)]
  );
  const cands = generateDataCenterSingleHallCandidates(ctx);
  ok('D03 带洞也能生成', cands.length >= 1, `${cands.length}`);
  if (cands.length > 0) {
    const hole = new Pt(10.5, 10.5);
    const c = cands[0];
    ok('D03 hall 不压保留地', !c.buildings.some((b) => insideSurface(hole, b.footprint)));
    for (const g of c.ground) {
      if (['mechanical_yard', 'electrical_yard', 'service'].includes(g.program)) {
        ok(`D03 ${g.program} 不压保留地`, !insideSurface(hole, g.surface), g.program);
      }
    }
  }
}

// ---------------------------------------------------------------- D04 狭长地块
{
  const ctx = ctxOf(rect(0, 0, 13, 26), [edge('s', new Pt(0, 0), new Pt(13, 0), 'collector')]);
  const cands = generateDataCenterSingleHallCandidates(ctx);
  ok('D04 狭长地块仍能生成', cands.length >= 1, `${cands.length}`);
  ok('D04 有侧向设备形态', cands.some((c) => c.id.includes('utility-side') || c.id.includes('split')));
  if (cands.length > 0) {
    const bad = checkDC(ctx, cands[0]);
    ok('D04 最优候选通过质量闸', bad.length === 0, bad.join('；'));
  }
}

// ---------------------------------------------------------------- D05 小地块
{
  // 8×9 单位 ≈ 56×63 m：缓冲 6 + 员工 16 + hall 28 + 服务 8 = 58 m 已超，必须明确拒收
  const ctx = ctxOf(rect(0, 0, 8, 9), [edge('s', new Pt(0, 0), new Pt(8, 0), 'collector')]);
  const cands = generateDataCenterSingleHallCandidates(ctx);
  ok('D05 小地块明确拒收', cands.length === 0, `${cands.length}`);
}

// ---------------------------------------------------------------- D06 真城
{
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');

  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  const pool = ctxs.filter((c) => c.use === 'industrial' && surfaceArea(c.parcel) > 18);
  let tried = 0;
  let produced = 0;
  let bad = 0;
  const winners: string[] = [];
  for (const ctx of pool) {
    tried++;
    const cands = generateDataCenterSingleHallCandidates(ctx);
    if (cands.length === 0) continue;
    produced++;
    winners.push(cands[0].id.replace('dc-single-', ''));
    const issues = checkDC(ctx, cands[0]);
    if (issues.length > 0) {
      bad++;
      if (bad <= 2) console.log(`    ${ctx.parcelId} 不合格：${issues.join('；')}`);
    }
  }
  ok('D06 真城有候选地块', tried > 0, `${tried}`);
  ok('D06 至少一半能生成', produced >= Math.ceil(tried * 0.5), `${produced}/${tried}`);
  ok('D06 生成的方案全部合格', bad === 0, `${bad}/${produced}`);
  console.log(`  D06 真实城市：${tried} 块候选地，${produced} 块成功，${bad} 块不合格，winner=${[...new Set(winners)].join('/')}`);
}

// ---------------------------------------------------------------- 防退化：DC ≠ 工业
{
  // DC 的设备场必须贴 hall，而工业的 truck court 贴着装卸面但**不贴建筑侧边** —
  // 这条断言就是防止 DC 变成"换个名字的仓库"
  const ctx = ctxOf(rect(0, 0, 20, 18), [
    edge('s', new Pt(0, 0), new Pt(20, 0), 'arterial'),
    edge('e', new Pt(20, 0), new Pt(20, 18), 'local'),
  ]);
  const dc = generateDataCenterSingleHallCandidates(ctx)[0];
  const hall = dc.buildings[0];
  const mech = dc.ground.find((g) => g.program === 'mechanical_yard')!;
  const adj = adjacencyScore(hall.footprint.outer, mech.surface.outer);
  ok('DC 设备场与 hall 的邻接度 > 0.25（不是隔着空地）', adj > 0.25, `${adj.toFixed(2)}`);

  const hasBuffer = dc.ground.some((g) => g.program === 'security_buffer');
  ok('DC 有 security_buffer（工业没有）', hasBuffer);
  const hasTruckCourt = dc.ground.some((g) => g.program === 'truck_court');
  ok('DC 没有 truck court（否则就是仓库）', !hasTruckCourt);
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
