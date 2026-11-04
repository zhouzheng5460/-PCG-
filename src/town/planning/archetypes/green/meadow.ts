// Archetype · Green（城市绿地）
//
// ## 它和 Park 不是一回事
//
// Green 是**低开发强度的连续绿地**：路边的带状绿地、街区之间保留的绿地、
// 居住区里的集中绿地。它的价值在于"整片、连片、安静"，不在于"好玩"。
//
// 所以这一版只做三件事，多一件都不做：
//   ① **一片连续的绿**，不切块、不做等距网格（切碎的草坪是噪点，不是设计）；
//   ② 只在**必要处**开一个步行接入口（绿地不能是走不进去的孤岛）；
//   ③ 按临街关系分层次：临街一侧是草坪（可进入），深处是种植区（不可进入）。
//
// 明确不做：建筑、车行路、广场、游乐设施、停车。这些出现就说明选错了 typology
// —— 用地本身是 Park 或 Civic，应该走那两套语法。
//
// ## 三个变体（对应三种真实形态）
//
//   green-meadow   整片草坪 + 一条接入口        —— 街区里的小绿地、街角绿地
//   green-grove    外圈种植 + 内圈草坪 + 接入口  —— 有厚度的防护绿带 / 社区公园
//   green-reserve  整片种植，不开口              —— 保留地 / 林地 / 生态缓冲
//
// 面积小的地块自动只出 meadow（几十平米的绿地谈"层次"是假的）。

import { Pt } from '../../../../core/geom';
import { surfaceArea, surfaceInset, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { siteFrame, ribbon, clipTo, minusAll, type SiteFrame } from '../shared/frame';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { greenDiagnostics } from '../../typologies/green';

const U = (m: number) => m / 7;

type Variant = 'green-meadow' | 'green-grove' | 'green-reserve';

interface Spec {
  id: Variant;
  /** 外圈种植带宽度（m）；0 = 整片草坪 */
  bandM: number;
  /** 是否开步行接入口 */
  entry: boolean;
}

const MEADOW: Spec = { id: 'green-meadow', bandM: 0, entry: true };
const GROVE: Spec = { id: 'green-grove', bandM: 12, entry: true };
const RESERVE: Spec = { id: 'green-reserve', bandM: 999, entry: false };

/** 低于这个面积（m²）只出最简单的「整片草坪」 */
const SIMPLE_ONLY_M2 = 3500;

export function generateGreenCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const f = siteFrame(ctx);
  if (!f) return [];
  const lotM2 = surfaceArea(ctx.parcel) * 49;
  if (lotM2 < 250) return [];

  // 变体不是「三选一让评分器挑」：
  //   · 没有临街面 → 只有 reserve（走不进去的地，谈草坪是假的）；
  //   · 临主干路 → 加 grove（主干路侧的防护绿带是规范要求，不是可选项）；
  //   · 其余 → 只有 meadow。
  // 让评分器在几乎同分的三个方案里挑，挑出来的是噪声，不是设计。
  //
  // 判据是**尺度**，不是"哪个分高"：
  //   · 没有临街面 → reserve（走不进去的地，做成草坪是假的）；
  //   · 4 公顷以上 → grove：这么大一片纯草坪没有边界，从街上读过去是"空地"，
  //     真实的大绿地一定有周边种植带把空间收住；
  //   · 其余 → meadow：社区小绿地就是一片草坪，加一圈树带反而是假的。
  const hasPrim = !!ctx.primaryFrontage;
  const specs: Spec[] = [];
  if (!hasPrim) specs.push(RESERVE);
  else if (lotM2 >= 12000) specs.push(GROVE);
  else specs.push(MEADOW);
  const out: SitePlanCandidate[] = [];
  for (const spec of specs) {
    const c = build(ctx, f, spec);
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = greenDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('green') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

function build(ctx: SiteContext, f: SiteFrame, spec: Spec): SitePlanCandidate | null {
  const buildable = ctx.buildableArea;
  const areaAll = surfaceArea(buildable);
  if (areaAll < U(8) * U(8)) return null;

  const ground: PlannedRegion[] = [];
  const access: PlannedAccess[] = [];
  const notes: string[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };

  // ---- 绿：整片，不切块
  const band = U(spec.bandM);
  let lawn: PlanSurface | null = null;
  let planting: PlanSurface | null = null;
  if (spec.bandM <= 0) {
    lawn = buildable;
    notes.push('整片草坪（不做内部分割）');
  } else if (band >= Math.sqrt(areaAll)) {
    planting = buildable;
    notes.push('整片种植区（保留地 / 林地）');
  } else {
    const inset = surfaceInset(buildable, band).filter((p) => surfaceArea(p) > U(4) * U(4));
    if (inset.length > 0) {
      lawn = inset.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
      // 外圈 = 原地块 − 内圈（用两块拼起来，不做布尔 —— 保证"并集 = 原面"）
      planting = buildable;
      notes.push(`外圈 ${spec.bandM} m 种植带 + 内圈草坪`);
    } else {
      lawn = buildable;
      notes.push('地块太窄，放不下种植带 —— 退回整片草坪');
    }
  }

  if (lawn && planting) {
    // 两层绿**互不重叠**：种植带 = 可建区 − 草坪（减法算出来）。
    //
    // 不能靠 ownership 事后切：诊断分是在 Candidate 上算的，那时 ownership
    // 还没跑。两层都铺整块会让诊断读到"绿地 158%"，区间被打爆，分数直接归零 ——
    // 那不是方案差，是口径错。
    add('lawn', lawn, '内圈草坪');
    for (const ring of minusAll(buildable, [lawn])) add('planting', ring, '外圈种植带（不可进入）');
  } else if (lawn) {
    add('lawn', lawn, '连续草坪');
  } else if (planting) {
    add('planting', planting, '保留地 / 林地');
  }
  if (ground.length === 0) return null;

  // ---- 步行接入口：只有需要的时候才开
  //
  // "必要"的判据是**有临街面**：没有临街面的绿地本来就进不去，硬开一条
  // 从别的地块穿过去的路是错的。开了之后从临街边往里伸 14 m 就够了 ——
  // 绿地不是公园，不需要一条贯穿全场的路。
  if (spec.entry && ctx.primaryFrontage) {
    // 入口开在临街面上，从退线内侧往里伸 14 m。绿地不是公园 —— 进得去就行。
    //
    // 用**世界坐标沿真实临街边**取点，再往里拉一条带子，而不是在局部坐标里
    // 取一个固定 v：主临街面未必是地块的 v0 那条边（斜边上完全可能 v0 < 0），
    // 固定 v 切出来的入口经常整块落在可建区外面，于是"绿地没有入口"。
    const [ea, eb] = ctx.primaryFrontage.parcelEdge;
    const len = Math.min(U(14), Math.max(U(6), f.D * 0.45));
    const width = U(4.4);
    let placed = false;
    for (const t of [0.5, 0.36, 0.64, 0.22, 0.78, 0.12, 0.88]) {
      const p0 = new Pt(ea.x + (eb.x - ea.x) * t, ea.y + (eb.y - ea.y) * t);
      const s0 = new Pt(p0.x + f.vDir.x * U(2), p0.y + f.vDir.y * U(2));
      const s1 = new Pt(s0.x + f.vDir.x * len, s0.y + f.vDir.y * len);
      const r = ribbon(s0, s1, width);
      const clipped = r ? clipTo(r, [buildable]) : null;
      if (!clipped || surfaceArea(clipped) < U(2) * U(6)) continue;
      add('pedestrian', clipped, '绿地步行接入口');
      access.push({
        kind: 'pedestrian',
        at: p0,
        normal: f.vDir,
        role: 'pedestrian',
        frontage: 'primary',
        notes: ['绿地接入口'],
      });
      placed = true;
      break;
    }
    if (!placed) notes.push('临街面上找不到能开的口（地块过窄或被凹角切断）');
  }

  return {
    id: spec.id,
    typology: 'green',
    archetype: spec.id,
    buildings: [],
    ground,
    access,
    parkingRequests: [],
    circulation: [],
    notes,
  };
}
