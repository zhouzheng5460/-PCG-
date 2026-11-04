// Planning Realization · R6 Parity Gate（三个 Golden Scene）
//
// 这是从"规划 Demo"进入"真实生产链"的关键测试。它不问"有没有造出对象"，
// 而是问：**Planner 说在哪，Scene 里就必须在哪。**
//
// 三个 Golden Scene（用户指定）：
//   G-R01 Industrial Rear-Load   —— 1 栋仓库 + 条带地面 + 停车 + 装卸
//   G-R02 MF Courtyard           —— 多条 bar + 院子 + 洞（ground holes）
//   G-R03 SF Single-Spine        —— 多栋房 + 内部路 + 车道 + 前后院
//
// 判据：Building footprint IoU > 0.98、地面 1:1 覆盖、开口端点零漂移、停车不越界。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceUnion, ringArea, pointInRing } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateIndustrialRearLoadCandidates } from '../src/town/planning/archetypes/industrial/rear-load';
import { generateMultiFamilyCourtyardCandidates } from '../src/town/planning/archetypes/multifamily/courtyard';
import { generateSingleFamilyGridCandidates } from '../src/town/planning/archetypes/singlefamily/grid';
import { realizeSitePlan } from '../src/town/realize';
import { exclusiveOverlapRatio } from '../src/town/realize/ground-ownership';
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

/** 面与面的 IoU（交 / 并） */
function iou(a: Pt[], b: Pt[]): number {
  const inter = surfaceIntersect([surface(a)], [surface(b)]).reduce((s, q) => s + surfaceArea(q), 0);
  const uni = surfaceUnion([surface(a), surface(b)]).reduce((s, q) => s + surfaceArea(q), 0);
  return uni > 1e-9 ? inter / uni : 1;
}

/** 通用 parity 检查 */
function checkParity(label: string, c: SitePlanCandidate): void {
  const r = realizeSitePlan(c, { group: `lot/${c.typology}`, solveParking: true });

  ok(`${label} 建筑数量一致`, r.solids.length === c.buildings.length, `${r.solids.length} vs ${c.buildings.length}`);

  // ① Building footprint IoU > 0.98（原样转译必须 = 1）
  let worstIou = 1;
  for (let i = 0; i < Math.min(r.solids.length, c.buildings.length); i++) {
    const v = iou(r.solids[i].ring, c.buildings[i].footprint.outer);
    if (v < worstIou) worstIou = v;
  }
  ok(`${label} 建筑 footprint IoU > 0.98`, worstIou > 0.98, `${worstIou.toFixed(4)}`);

  // ② 地面：从"面积之和接近"升级成"**并集守恒 + 独占性**"
  //    面积之和会被重叠区域重复计数（SF 曾经因此出现 1.08），并集才是真实占用。
  const plannedUnion = surfaceUnion(c.ground.map((g) => g.surface))
    .reduce((s, q) => s + surfaceArea(q), 0);
  // 道路面之间（段矩形 + 转角方垫）本来就重叠，那是设计使然，不计入"地面独占性"
  // 细节层不参与独占性统计：
  //   `_road_`     路段矩形 + 转角方垫本来就互相重叠（设计使然）
  //   `_parkreq_`  停车请求面（规划层，不是实现面）
  //   `_pk_`       停车场的通道面 / 树岛面 —— 它们**刻意**铺在车位底面之上
  //                （专业总图的三层材质），不是"两个功能面互相压"
  const realizedSurfaces = r.surfaces.filter(
    (s) => !s.name.includes('_parkreq_') && !s.name.includes('_road_') && !s.name.includes('_pk_')
  );
  // 覆盖口径要算上道路：路是从 ground 里切出来的，切走的那块仍然"被铺了"（铺成路面）
  const realizedUnion = surfaceUnion(
    r.surfaces
      .filter((f) => !f.name.includes('_parkreq_'))
      .map((f) => surface(f.ring, f.holes ?? []))
  ).reduce((s, q) => s + surfaceArea(q), 0);
  const cov = plannedUnion > 1e-9 ? realizedUnion / plannedUnion : 1;
  ok(`${label} 地面并集覆盖 ≥ 0.98`, cov >= 0.98, `${cov.toFixed(3)}`);

  // 独占性：切割后任意两块不应再有可观重叠
  const overlap = exclusiveOverlapRatio(
    realizedSurfaces.map((f) => ({
      program: 'residual' as const,
      surface: surface(f.ring, f.holes ?? []),
      area: Math.abs(ringArea(f.ring)),
    }))
  );
  ok(`${label} 地面重叠率 < 0.01（独占）`, overlap < 0.01, `${(overlap * 100).toFixed(2)}%`);

  // 洞必须原样传下去（MF 的 courtyard / DC 的 buffer 都可能有）
  const withHoles = c.ground.filter((g) => g.surface.holes.length > 0);
  if (withHoles.length > 0) {
    const surfaced = r.surfaces.filter((f) => (f.holes?.length ?? 0) > 0);
    // 洞被道路切开时允许退化，但必须留痕（polish 阶段再修 topology）
    const explained = r.warnings.some((w) => w.code === 'GROUND_HOLE_LOST');
    ok(
      `${label} 地面洞被保留（或被道路切开的要有告警）`,
      surfaced.length >= withHoles.length || explained,
      `${surfaced.length}/${withHoles.length}`
    );
  }

  // ③ 开口**只保留数据、不产出几何**
  //
  // 这条断言原来写的是"每个开口都必须落地成一条 Path"。阶段 D 把它反过来了：
  // 开口是语义（这里可以进出），不是几何 —— 落地之后就是一颗米色的胶囊
  // 压在车行道上（用户明确否掉了）。真正该画的是 `driveway`，那由道路侧表达。
  // 所以现在断言 **0 条**，而且开口数据必须还在（不能顺手把语义也删了）。
  const accPaths = r.paths.filter((p) => p.name.includes('_access_'));
  ok(`${label} 开口不落地成几何`, accPaths.length === 0, `${accPaths.length} 条`);
  ok(`${label} 开口数据保留`, c.access.length > 0, `${c.access.length} 个`);

  // ④ 停车区域必须原样（面积一致，且不被扩大）
  const parkSurf = r.surfaces.filter((s) => s.name.includes('_parkreq_'));
  ok(`${label} 停车区域数量一致`, parkSurf.length === c.parkingRequests.length, `${parkSurf.length}/${c.parkingRequests.length}`);
  for (let i = 0; i < Math.min(parkSurf.length, c.parkingRequests.length); i++) {
    const a = Math.abs(ringArea(parkSurf[i].ring));
    const b = surfaceArea(c.parkingRequests[i].region);
    ok(`${label} 停车区域面积一致`, Math.abs(a - b) < 1e-6, `${a.toFixed(3)} vs ${b.toFixed(3)}`);
  }

  // ④b R4：真排出来的车位必须在 request.region 里（Solver 无权扩边界）
  const stallPaths = r.paths.filter((p) => p.name.includes('_stall_'));
  if (c.parkingRequests.length > 0) {
    let inside = 0;
    let outside = 0;
    for (const p of stallPaths) {
      const mid = new Pt((p.pts[0].x + p.pts[1].x) / 2, (p.pts[0].y + p.pts[1].y) / 2);
      const ok2 = c.parkingRequests.some((req) => pointInRing(mid, req.region.outer));
      if (ok2) inside++;
      else outside++;
    }
    ok(`${label} 车位全部落在停车区域内`, outside === 0, `${outside} 条越界 / 共 ${stallPaths.length}`);
    const st = r.parkingStats ?? [];
    // 排不出来不算失败：只要如实报警（PARKING_NOT_SOLVED / REGION_CONSUMED）即可 ——
    // 第一版不追求车位数，追求"不硬塞"
    const honest =
      st.length > 0 && st.every((x) => x.stalls > 0)
        ? true
        : r.warnings.some((w) => w.code === 'PARKING_NOT_SOLVED' || w.code === 'PARKING_REGION_CONSUMED');
    ok(
      `${label} 停车要么排出车位、要么如实告警`,
      c.parkingRequests.length === 0 || honest,
      JSON.stringify(st.map((x) => `${x.role}:${x.stalls}位/${x.angleDeg}°`))
    );
    if (st.length > 0) {
      console.log(
        `    ${label} 车位 ${st.map((x) => `${x.role} ${x.stalls} 位 @${x.angleDeg}°`).join(' / ')}（${stallPaths.length} 条分隔线）`
      );
    }
  }

  // ④c R5：道路中心线零漂移 + 被路面完整覆盖
  const roads = r.roadStats ?? [];
  if (c.circulation.length > 0) {
    ok(`${label} 道路全部实现`, roads.length === c.circulation.length, `${roads.length}/${c.circulation.length}`);
    let drift = 0;
    for (let k = 0; k < Math.min(roads.length, c.circulation.length); k++) {
      const planned = c.circulation[k].pts;
      const consumed = roads[k].consumedCenterline;
      ok(`${label} 道路 ${k} 顶点数不变`, planned.length === consumed.length, `${planned.length}/${consumed.length}`);
      for (let j = 0; j < Math.min(planned.length, consumed.length); j++) {
        drift = Math.max(drift, Math.hypot(planned[j].x - consumed[j].x, planned[j].y - consumed[j].y));
      }
    }
    ok(`${label} 道路中心线零漂移`, drift < 1e-9, `${drift}`);

    // 走廊包含：Planner 的中心线必须落在已实现的路面里
    const roadSurf = r.surfaces.filter((f) => f.name.includes('_road_') && f.name.includes('_surf_'));
    let outside = 0;
    for (const path of c.circulation) {
      for (const p of path.pts) {
        const inside = roadSurf.some((f) => pointInRing(p, f.ring) || distToRing2(p, f.ring) < 0.05);
        if (!inside) outside++;
      }
    }
    ok(`${label} 道路中心线被路面覆盖`, outside === 0, `${outside} 个点不在路面上`);
  }

  // ⑤ Realizer 自检没有报警（几何被改动 / 丢对象）
  const bad = r.warnings.filter((w) => w.code === 'BUILDING_RING_CHANGED' || w.code === 'BUILDING_COUNT_MISMATCH');
  ok(`${label} 无几何漂移告警`, bad.length === 0, bad.map((w) => w.code).join(','));
}

// ---------------------------------------------------------------- G-R01 工业
{
  const ctx = buildSiteContext({
    parcelId: 'gr01',
    parcel: surface(rect(0, 0, 44, 40)),
    use: 'industrial',
    edges: [edge('s', new Pt(0, 0), new Pt(44, 0), 'arterial'), edge('e', new Pt(44, 0), new Pt(44, 40), 'local')],
  });
  const c = generateIndustrialRearLoadCandidates(ctx)[0];
  ok('G-R01 有候选', !!c);
  if (c) checkParity('G-R01', c);
  console.log(`  G-R01 ${c?.id} 建筑 ${c?.buildings.length} 地面 ${c?.ground.length} 停车 ${c?.parkingRequests.length}`);
}

// ---------------------------------------------------------------- G-R02 住宅
{
  const ctx = buildSiteContext({
    parcelId: 'gr02',
    parcel: surface(rect(0, 0, 12, 11)),
    use: 'residential',
    edges: [edge('s', new Pt(0, 0), new Pt(12, 0), 'collector'), edge('e', new Pt(12, 0), new Pt(12, 11), 'local')],
  });
  const c = generateMultiFamilyCourtyardCandidates(ctx)[0];
  ok('G-R02 有候选', !!c);
  if (c) checkParity('G-R02', c);
  console.log(`  G-R02 ${c?.id} 建筑 ${c?.buildings.length} 地面 ${c?.ground.length}`);
}

// ---------------------------------------------------------------- G-R03 独栋
{
  const ctx = buildSiteContext({
    parcelId: 'gr03',
    parcel: surface(rect(0, 0, 46, 40)),
    use: 'residential',
    edges: [edge('s', new Pt(0, 0), new Pt(46, 0), 'collector')],
  });
  const c = generateSingleFamilyGridCandidates(ctx).find((x) => x.id === 'sf-grid-single-spine');
  ok('G-R03 有单脊候选', !!c);
  if (c) {
    checkParity('G-R03', c);
    // 独栋特有的：每栋房都对一块车道，内部路也落地了
    const r = realizeSitePlan(c, { group: 'lot/residential' });
    const dw = r.surfaces.filter((s) => s.name.includes('driveway')).length;
    ok('G-R03 车道全部落地', dw >= c.buildings.length, `${dw}/${c.buildings.length}`);
    const roads = r.paths.filter((p) => p.name.includes('_circ_'));
    ok('G-R03 内部路落地', roads.length >= 1, `${roads.length}`);
  }
  console.log(`  G-R03 ${c?.id} 建筑 ${c?.buildings?.length} 地面 ${c?.ground?.length}`);
}

// ---------------------------------------------------------------- 批量：Scene 合并
{
  const ctx = buildSiteContext({
    parcelId: 'gr04',
    parcel: surface(rect(0, 0, 44, 40)),
    use: 'industrial',
    edges: [edge('s', new Pt(0, 0), new Pt(44, 0), 'arterial')],
  });
  const cands = generateIndustrialRearLoadCandidates(ctx);
  const { realizeSitePlans } = await import('../src/town/realize');
  const merged = realizeSitePlans(cands, { group: 'lot/industrial' });
  ok('批量 Realization 对象数累加正确', merged.solids.length === cands.reduce((s, c) => s + c.buildings.length, 0));
  ok('批量 Realization 面数累加正确', merged.surfaces.length > 0);
  console.log(`  批量：${cands.length} 个候选 → ${merged.solids.length} 体 / ${merged.surfaces.length} 面 / ${merged.paths.length} 线`);
}

function distToRing2(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
