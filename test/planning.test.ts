// Site Planning Core · P1 Golden Tests（G01~G05）
//
// 这些用例固定的是**几何事实**，不是函数内部实现：
//   G01 矩形单面临街 → 主临街面就是那条，朝向 ≈ 路走向
//   G02 转角地块     → primary + secondary，且与顶点顺序无关
//   G03 L 形地块      → 可建区不越界、面积变小、不自交
//   G04 带洞地块      → 可建区保留洞（中庭 / 保留建筑）
//   G05 工业双临街    → primary = 干路，service 落在次临街面
// 另加 P1.6 评分契约与 P1.7 Archetype 筛选的基本断言。

import { Pt } from '../src/core/geom';
import { surface, surfaceArea, insideSurface, type PlanSurface } from '../src/town/planning/core/surface';
import {
  buildSiteContext,
  resolveFrontages,
  resolveAccess,
  resolveBuildable,
  queryNeighbors,
  eligibleArchetypes,
  summarizeSite,
  type SiteContextInput,
} from '../src/town/planning/core/context';
import { evaluateLayout, weightsFor, DEFAULT_WEIGHTS } from '../src/town/planning/core/evaluator';
import type { SiteRoadEdge } from '../src/town/planning/core/types';

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

function edge(
  key: string,
  a: Pt,
  b: Pt,
  cls: SiteRoadEdge['cls'],
  opts: Partial<SiteRoadEdge> = {}
): SiteRoadEdge {
  return {
    key,
    a,
    b,
    len: Pt.distance(a, b),
    cls,
    carriageSide: cls === 'arterial' ? 1.6 : cls === 'collector' ? 1.1 : 0.7,
    sidewalk: 0.3,
    median: 0,
    ...opts,
  };
}

const ctxOf = (input: SiteContextInput) => buildSiteContext(input);

// ---------------------------------------------------------------- G01
{
  const parcel = surface(rect(0, 0, 20, 20));
  const ctx = ctxOf({
    parcelId: 'g01',
    parcel,
    use: 'industrial',
    edges: [edge('road-s', new Pt(0, 0), new Pt(20, 0), 'arterial')],
  });
  ok('G01 有主临街面', !!ctx.primaryFrontage);
  ok('G01 主临街面是干路', ctx.primaryFrontage?.edge.cls === 'arterial');
  // 边沿 +x 方向 → 角度 0
  ok('G01 朝向 ≈ 0', Math.abs(ctx.orientation) < 1e-6, `${ctx.orientation.toFixed(3)}`);
  ok('G01 没有次临街面', !ctx.secondaryFrontage);
  ok('G01 可建区小于地块', surfaceArea(ctx.buildableArea) < surfaceArea(parcel));
  ok('G01 车行开口候选存在', ctx.vehicleAccessCandidates.length >= 1);
  ok('G01 typology 由用途推出', ctx.typology === 'industrial');
  // SiteContext 必须是纯数据：能被 JSON 序列化（Phase 2 要存 Candidate / 传给 UI）
  let serial = '';
  try {
    serial = JSON.stringify(ctx);
  } catch {
    serial = '';
  }
  ok('G01 SiteContext 可 JSON 序列化', serial.length > 100, `${serial.length}`);
  console.log(
    `  G01 主街 ${ctx.primaryFrontage?.edge.cls} 评分 ${ctx.primaryFrontage?.score.toFixed(2)} / 可建区 ${(surfaceArea(ctx.buildableArea) / surfaceArea(parcel) * 100).toFixed(0)}%`
  );
}

// ---------------------------------------------------------------- G02
{
  const parcel = surface(rect(0, 0, 20, 20));
  const edges = [
    edge('road-s', new Pt(0, 0), new Pt(20, 0), 'arterial'),
    edge('road-w', new Pt(0, 0), new Pt(0, 20), 'local'),
  ];
  const ctx = ctxOf({ parcelId: 'g02', parcel, use: 'commercial', edges });
  ok('G02 主街是干路', ctx.primaryFrontage?.edge.cls === 'arterial');
  ok('G02 有次临街面', !!ctx.secondaryFrontage);
  ok('G02 次临街面是支路', ctx.secondaryFrontage?.edge.cls === 'local');
  ok('G02 服务面可用', !!ctx.serviceFrontage);

  // 顶点顺序翻转（顺时针）不应改变判定
  const rev = surface(rect(0, 0, 20, 20).slice().reverse());
  const ctx2 = ctxOf({ parcelId: 'g02r', parcel: rev, use: 'commercial', edges });
  ok('G02 与顶点顺序无关（primary）', ctx2.primaryFrontage?.edge.key === ctx.primaryFrontage?.edge.key);
  ok('G02 与顶点顺序无关（secondary）', ctx2.secondaryFrontage?.edge.key === ctx.secondaryFrontage?.edge.key);
  console.log(
    `  G02 primary=${ctx.primaryFrontage?.edge.key} secondary=${ctx.secondaryFrontage?.edge.key} service=${ctx.serviceFrontage?.edge.key}`
  );
}

// ---------------------------------------------------------------- G03
{
  // L 形：20×20 去掉右上 8×8
  const L = surface([
    new Pt(0, 0),
    new Pt(12, 0),
    new Pt(12, 12),
    new Pt(20, 12),
    new Pt(20, 20),
    new Pt(0, 20),
  ]);
  const ctx = ctxOf({
    parcelId: 'g03',
    parcel: L,
    use: 'residential',
    edges: [edge('road-s', new Pt(-2, 0), new Pt(22, 0), 'collector')],
  });
  const b = ctx.buildableArea;
  ok('G03 可建区有效', b.outer.length >= 3);
  ok('G03 面积变小', surfaceArea(b) < surfaceArea(L), `${surfaceArea(b).toFixed(1)} < ${surfaceArea(L).toFixed(1)}`);
  ok('G03 面积没有塌掉', surfaceArea(b) > surfaceArea(L) * 0.3);
  // 不自交：用鞋带公式比较绝对面积与"外包围盒"的关系只能粗略判断，
  // 这里改用逐点判定：可建区所有顶点必须落在地块内
  const allInside = b.outer.every((p) => insideSurface(p, L) || distToRing(p, L.outer) < 0.05);
  ok('G03 可建区不越界', allInside);
  console.log(`  G03 L 形：可建区 ${(surfaceArea(b) / surfaceArea(L) * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------- G04
{
  // 地块中间有一栋保留建筑：可建区要把这块当洞
  const outer = rect(0, 0, 24, 24);
  const keep = rect(9, 9, 15, 15);
  const parcel = surface(outer, [keep]);
  const ctx = ctxOf({
    parcelId: 'g04',
    parcel,
    use: 'commercial',
    edges: [edge('road-s', new Pt(0, 0), new Pt(24, 0), 'arterial')],
  });
  ok('G04 地块本身带洞', ctx.parcel.holes.length === 1);
  ok('G04 可建区保留洞', ctx.buildableArea.holes.length >= 1, `${ctx.buildableArea.holes.length}`);
  ok('G04 洞心不在可建区', !insideSurface(new Pt(12, 12), ctx.buildableArea));
  console.log(`  G04 可建区洞数 ${ctx.buildableArea.holes.length}`);
}

// ---------------------------------------------------------------- G05
{
  // 工业地块：南侧干路（主街）+ 东侧支路（后勤）
  const parcel = surface(rect(0, 0, 30, 24));
  const edges = [
    edge('road-s', new Pt(0, 0), new Pt(30, 0), 'arterial'),
    edge('road-e', new Pt(30, 0), new Pt(30, 24), 'local'),
  ];
  const ctx = ctxOf({ parcelId: 'g05', parcel, use: 'industrial', edges });
  ok('G05 主街是干路', ctx.primaryFrontage?.edge.cls === 'arterial');
  ok('G05 服务面落在次临街面', ctx.serviceFrontage?.edge.key === 'road-e', `${ctx.serviceFrontage?.edge.key}`);
  ok('G05 有货运开口候选', ctx.truckAccessCandidates.length >= 1);
  ok('G05 服务开口在支路', ctx.serviceAccessCandidates.every((a) => a.kind === 'service'));
  const arch = eligibleArchetypes(ctx.typology, summarizeSite(ctx));
  ok('G05 命中工业 archetype', arch.length > 0);
  ok('G05 有 REAR_LOAD 或 SIDE_LOAD', arch.some((a) => a.archetype === 'IND_REAR_LOAD' || a.archetype === 'IND_SIDE_LOAD'));
  console.log(`  G05 service=${ctx.serviceFrontage?.edge.key} archetypes=${arch.map((a) => a.archetype).join(',')}`);
}

// ---------------------------------------------------------------- 邻接
{
  const a = surface(rect(0, 0, 10, 10));
  const b = surface(rect(10, 0, 20, 10));
  const far = surface(rect(40, 40, 50, 50));
  const list = [
    { parcelId: 'b', use: 'industrial', parcel: b },
    { parcelId: 'far', use: 'industrial', parcel: far },
  ];
  const nb = queryNeighbors({ parcelId: 'a', use: 'industrial', parcel: a }, list, 1.2);
  ok('邻接：只返回贴着的', nb.length === 1, `${nb.length}`);
  ok('邻接：关系是 adjacent', nb[0]?.relation === 'adjacent');
  ok('邻接：共享边 ≈ 10', Math.abs((nb[0]?.sharedBoundaryLength ?? 0) - 10) < 0.2, `${nb[0]?.sharedBoundaryLength}`);
  ok('邻接：距离为 0', (nb[0]?.distance ?? -1) === 0);
}

// ---------------------------------------------------------------- P1.6 评分契约
{
  const good = evaluateLayout(
    {
      accessClarity: 0.9,
      frontageQuality: 0.8,
      buildingRegularity: 0.85,
      groundUsability: 0.8,
      circulationQuality: 0.75,
      deadSpacePenalty: 0.05,
      fragmentationPenalty: 0.05,
      accessConflictPenalty: 0.05,
      typologyFit: 0.8,
      parkingQuality: 0.7,
      openSpaceQuality: 0.7,
    },
    { typology: 'industrial' }
  );
  const bad = evaluateLayout(
    {
      accessClarity: 0.2,
      frontageQuality: 0.2,
      buildingRegularity: 0.3,
      groundUsability: 0.2,
      circulationQuality: 0.1,
      deadSpacePenalty: 0.8,
      fragmentationPenalty: 0.7,
      accessConflictPenalty: 0.6,
    },
    { typology: 'industrial' }
  );
  ok('评分：好方案 > 差方案', good.score > bad.score, `${good.score.toFixed(2)} vs ${bad.score.toFixed(2)}`);
  ok('评分：好方案在 0~10', good.score > 5 && good.score <= 10, `${good.score.toFixed(2)}`);
  ok('评分：差方案 < 3', bad.score < 3, `${bad.score.toFixed(2)}`);
  ok('评分：差方案给出理由', bad.reasons.length >= 2, `${bad.reasons.length}`);
  ok('工业权重：物流 > 沿街', weightsFor('industrial').circulationQuality > weightsFor('industrial').frontageQuality);
  ok('默认权重：入口清晰最重', DEFAULT_WEIGHTS.accessClarity === 2.5);
  console.log(`  评分：好 ${good.score.toFixed(2)} / 差 ${bad.score.toFixed(2)}；理由 ${bad.reasons.join('；')}`);
}

// ---------------------------------------------------------------- P1.7 Archetype 筛选
{
  const small = eligibleArchetypes('multi_family', {
    area: 8,
    aspect: 1.2,
    frontageCount: 1,
    buildableRatio: 0.6,
    sameUseNeighbors: 2,
  });
  const long = eligibleArchetypes('multi_family', {
    area: 26,
    aspect: 2.4,
    frontageCount: 1,
    buildableRatio: 0.6,
    sameUseNeighbors: 0,
  });
  const square = eligibleArchetypes('multi_family', {
    area: 30,
    aspect: 1.1,
    frontageCount: 2,
    buildableRatio: 0.6,
    sameUseNeighbors: 0,
  });
  ok('小地块给 TOWNHOME', small.some((a) => a.archetype === 'MF_TOWNHOME'));
  ok('狭长地块给 GURBAN', long.some((a) => a.archetype === 'MF_GURBAN'));
  ok('方形大地块给 COURTYARD', square.some((a) => a.archetype === 'MF_COURTYARD'));
  ok('候选按 fit 降序', square.every((a, i) => i === 0 || square[i - 1].fit >= a.fit));
  console.log(`  archetype：小=${small.map((a) => a.archetype).join(',')} 长=${long.map((a) => a.archetype).join(',')}`);
}

// ---------------------------------------------------------------- 真实城市集成
// P1 的最终验收：给任意一个 Parcel，都要能稳定回答"哪边主街 / 哪里可建 / 从哪进"。
// 这里用一座小城真跑一遍（含真实路网与中心线距离），确保不是只对构造数据成立。
{
  const t0 = Date.now();
  const { Model } = await import('../src/town/model');
  const { buildRoadNet } = await import('../src/road/system');
  const { siteContextsForModel } = await import('../src/town/planning/adapters/model');
  const m = new Model({ nPatches: 6, seed: 8, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  const ctxs = siteContextsForModel(m, { net });
  const total = ctxs.length;
  const noPrimary = ctxs.filter((c) => !c.primaryFrontage).length;
  const noAccess = ctxs.filter((c) => c.vehicleAccessCandidates.length === 0).length;
  const noBuildable = ctxs.filter((c) => surfaceArea(c.buildableArea) <= 0).length;
  ok('集成：读到地块', total > 0, `${total}`);
  // 允许极少数**被完全包围的内部地块**（中心广场 / 保留地）没有临街面 ——
  // 这是真实的城市情况，不是算法失败；要求它们都留下 notes 解释。
  const noPrimaryCtx = ctxs.filter((c) => !c.primaryFrontage);
  ok('集成：绝大多数有主临街面', noPrimary / total <= 0.03, `${noPrimary}/${total} 缺失`);
  ok('集成：无临街面的地块都有说明', noPrimaryCtx.every((c) => c.notes.some((s) => s.includes('内部地块'))));
  ok('集成：有临街面的地块都有车行开口', ctxs.filter((c) => c.primaryFrontage).every((c) => c.vehicleAccessCandidates.length > 0));
  ok('集成：每块都有可建区', noBuildable === 0, `${noBuildable}/${total} 缺失`);
  console.log(`  集成：${total} 块地 / ${Date.now() - t0}ms`);
}

function distToRing(p: Pt, ring: Pt[]): number {
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
