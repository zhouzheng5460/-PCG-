// Archetype · Park（城市公园）
//
// ## 语法：从入口长出骨架，剩下的才是绿地
//
// 和 Green 相反，Park 的空间是**被路径组织出来的**：
//
//   临街面 → 入口 → 主步道 → 中心节点 → 次步道 → 活动场地
//                                    ↘ 草坪 / 种植区
//
// 所以这一版的顺序是固定的（顺序错了就退化成"一块绿地上撒几条路"）：
//   ① 定入口（临街面上，按临街等级挑）；
//   ② 定中心节点（可建区重心）；
//   ③ 主步道：入口 → 中心（每条入口一条，共享同一段就自然重合）；
//   ④ 次步道：中心 → 两侧的次节点（和主步道**正交**，形成十字骨架）；
//   ⑤ 活动场地：中心小广场 + 次节点小场地；
//   ⑥ 绿地：整块草坪打底，外圈种植带靠 ownership 优先级切出来；
//   ⑦ 残地：交给 generateCandidates 的 claimResidual。
//
// 路径是**直的**：斜路是因为入口和中心不共线，不是因为"想要曲线"。
// 用户明确要求过"不能为了制造曲线而随机绕行"。
//
// ## 三个变体
//
//   park-cross   十字骨架（主步道 + 正交次步道）+ 中心广场   —— 主城区公园
//   park-loop    两个临街入口贯穿 + 两侧次节点               —— 有两条街夹着的公园
//   park-pocket  小公园：一个入口 + 一块小场地               —— < 4000 m²

import { Pt } from '../../../../core/geom';
import { surfaceArea, surfaceInset, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { siteFrame, ribbon, clipTo, minusAll, type SiteFrame } from '../shared/frame';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { parkDiagnostics } from '../../typologies/park';

const U = (m: number) => m / 7;

type Variant = 'park-cross' | 'park-loop' | 'park-pocket';

interface Spec {
  id: Variant;
  /** 主步道宽（m） */
  mainW: number;
  /** 次步道宽（m） */
  subW: number;
  /** 是否要两侧次节点 */
  cross: boolean;
  /** 是否从第二条临街面再开一个入口 */
  secondEntrance: boolean;
}

const VARIANTS: Spec[] = [
  { id: 'park-cross', mainW: 5, subW: 2.6, cross: true, secondEntrance: false },
  { id: 'park-loop', mainW: 4.5, subW: 2.6, cross: true, secondEntrance: true },
  { id: 'park-pocket', mainW: 3.5, subW: 0, cross: false, secondEntrance: false },
];

const POCKET_ONLY_M2 = 4000;

export function generateParkCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const f = siteFrame(ctx);
  if (!f) return [];
  const lotM2 = surfaceArea(ctx.parcel) * 49;
  if (lotM2 < 400) return [];

  const specs = lotM2 < POCKET_ONLY_M2 ? VARIANTS.slice(2) : VARIANTS;
  const out: SitePlanCandidate[] = [];
  for (const spec of specs) {
    const c = build(ctx, f, spec);
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = parkDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('park') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

function build(ctx: SiteContext, f: SiteFrame, spec: Spec): SitePlanCandidate | null {
  const buildable = ctx.buildableArea;
  const lotA = surfaceArea(buildable);
  if (lotA < U(10) * U(10)) return null;

  const ground: PlannedRegion[] = [];
  const access: PlannedAccess[] = [];
  const notes: string[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };

  // ---- ① 入口
  //
  // 主入口永远开在主临街面中点。第二条入口优先用次临街面（有的话），
  // 没有就在同一条街上再开一个 —— 一个只有单入口的公园，人流只有一个方向，
  // 内部骨架会长成"一条路走到黑"。
  const entries: { at: Pt; normal: Pt; frontage: 'primary' | 'secondary' }[] = [];
  const prim = ctx.primaryFrontage;
  if (prim) {
    const [ea, eb] = prim.parcelEdge;
    const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
    entries.push({ at: mid, normal: f.vDir, frontage: 'primary' });
  }
  if (spec.secondEntrance) {
    const sec = ctx.secondaryFrontage;
    if (sec) {
      const [ea, eb] = sec.parcelEdge;
      const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
      // 次入口的法线：指向可建区重心
      const c0 = centroid(buildable);
      const n = unit(new Pt(c0.x - mid.x, c0.y - mid.y));
      entries.push({ at: mid, normal: n, frontage: 'secondary' });
    }
  }
  if (entries.length === 0) {
    // 没有临街面（尽端绿地被围死）：不开口，只做绿地
    notes.push('没有临街面 —— 不开入口');
  }

  // ---- ② 中心节点
  const center = centroid(buildable);

  // ---- ③ 主步道：入口 → 中心
  const mainW = U(spec.mainW);
  for (const e of entries) {
    // 从入口往里退一点再起头，免得压在路边人行道上
    const start = new Pt(e.at.x + e.normal.x * U(1.2), e.at.y + e.normal.y * U(1.2));
    const r = ribbon(start, center, mainW);
    if (!r) continue;
    const clipped = clipTo(r, [buildable]);
    if (clipped) add('pedestrian', clipped, '主步道（入口 → 中心节点）');
  }

  // ---- ④ 次步道 + ⑤ 节点
  const halfU = f.W / 2;
  const halfV = f.D / 2;
  const crossOk = spec.cross && spec.subW > 0 && Math.min(f.W, f.D) > U(30);
  if (crossOk) {
    const subW = U(spec.subW);
    // 次节点放在中心两侧（沿面宽方向），不放四角 —— 四角是最容易被临街停车的
    const nA = new Pt(center.x + f.uDir.x * halfU * 0.62, center.y + f.uDir.y * halfU * 0.62);
    const nB = new Pt(center.x - f.uDir.x * halfU * 0.62, center.y - f.uDir.y * halfU * 0.62);
    for (const n of [nA, nB]) {
      const r = ribbon(center, n, subW);
      if (!r) continue;
      const clipped = clipTo(r, [buildable]);
      if (clipped) add('park_path', clipped, '次步道（中心 → 次节点）');
      // 次节点：一块 10 m 见方的活动场地
      const node = f.cut(
        project(f, n, 'u') - U(5),
        project(f, n, 'u') + U(5),
        project(f, n, 'v') - U(5),
        project(f, n, 'v') + U(5)
      );
      if (node) add('amenity', node, '活动场地');
    }
  }
  void halfV;

  // 中心广场：一块 14~20 m 见方的硬地，尺寸随场地缩放
  const plazaSide = Math.min(U(20), Math.max(U(10), Math.sqrt(lotA) * 0.22));
  const plaza = f.cut(
    project(f, center, 'u') - plazaSide / 2,
    project(f, center, 'u') + plazaSide / 2,
    project(f, center, 'v') - plazaSide / 2,
    project(f, center, 'v') + plazaSide / 2
  );
  if (plaza) add('entrance_forecourt', plaza, '中心广场');

  // ---- ⑥ 绿地：整块草坪打底，外圈种植带
  // 草坪打底，种植带只在**外圈**（用减法算出来，不靠 ownership 事后切）——
  // 诊断分是在 Candidate 上算的，绿地铺整块 + 种植再铺整块会读到 171% 的绿地率。
  const band = U(10);
  const inset = surfaceInset(buildable, band).filter((p) => surfaceArea(p) > U(6) * U(6));
  const big = surfaceArea(buildable) > U(40) * U(40);
  // 草坪基准面：有厚度的大场地取内圈，否则整块
  const lawnBase =
    inset.length > 0 && big ? inset.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b)) : buildable;
  // 草坪必须**减掉已经铺好的路和广场**：诊断读的是 Candidate 的 ground，
  // 草坪铺整块再让路叠上去，绿地率会读到 105%+，区间一爆分数就归零。
  const cutters = ground.map((g) => g.surface);
  const lawnPieces = minusAll(lawnBase, cutters);
  for (const lp of lawnPieces) add('lawn', lp, lawnBase === buildable ? '整片草坪' : '内圈草坪');
  if (lawnBase !== buildable) {
    for (const ring of minusAll(buildable, [lawnBase])) add('planting', ring, '外圈 10 m 种植带（不可进入）');
    notes.push('外圈 10 m 种植带 + 内圈草坪');
  }

  // ---- 出入口登记（Realizer 会在开口处铺一条 6 m 的步行带）
  for (const e of entries) {
    access.push({
      kind: 'pedestrian',
      at: e.at,
      normal: e.normal,
      role: 'pedestrian',
      frontage: e.frontage,
      notes: ['公园入口'],
    });
  }

  if (ground.length === 0) return null;

  return {
    id: spec.id,
    typology: 'park',
    archetype: spec.id,
    buildings: [],
    ground,
    access,
    parkingRequests: [],
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 局部工具

function centroid(s: PlanSurface): Pt {
  const r = s.outer;
  const x = r.reduce((a, p) => a + p.x, 0) / r.length;
  const y = r.reduce((a, p) => a + p.y, 0) / r.length;
  return new Pt(x, y);
}

function unit(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

/** 世界点 → 局部坐标的某一轴 */
function project(f: SiteFrame, p: Pt, axis: 'u' | 'v'): number {
  const d = new Pt(p.x - f.origin.x, p.y - f.origin.y);
  return axis === 'u' ? d.x * f.uDir.x + d.y * f.uDir.y : d.x * f.vDir.x + d.y * f.vDir.y;
}
