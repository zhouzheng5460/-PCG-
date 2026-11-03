// Archetype · Multi-Family / Principal-Axis Court（TECH-04 fallback）
//
// ## 这个候选解决什么
//
// 常规围合方案（`courtyard.ts`）的语法是"**沿临街方向**排 bar、围着院子转"。
// 它隐含一个前提：地块的展开方向和临街方向大体一致。
//
// 城市里有一类地块专门打破这个前提 —— **临街面极短的大地块**：
// 街区 90~150 m 见方，但临街只占 18~27 m，剩下的边界全部贴着别的地块。
// 实测（seed 682063530，15 patch 城）里这类地块占 MF 的 6/26：
//
//   | parcel     | 临街 | 地块展向 | 常规方案覆盖 | 结果                |
//   |------------|------|----------|--------------|---------------------|
//   | -312:429   | 18 m | 131 m    | 12%          | 断头纸片 + 空院子    |
//   | 544:-100   | 23 m | 121 m    | 16%          | 同上                |
//   | 206:451    | 27 m | 126 m    | 16%          | 同上                |
//   | 573:3      | 27 m | 147 m    | 19%          | 同上                |
//   | -255:-434  | 27 m | 127 m    | 17%          | 同上                |
//   | -14:-496   | 20 m |  97 m    | 45%          | 反向过密            |
//
// ## 关键语义：Massing orientation ≠ Arrival orientation
//
// 本方案把**围合框架**转到地块主轴（OBB 长轴），但**到达序列不动**：
// 行人开口仍然开在 primary frontage 上，仍然从街 → 前场 → 院子。
// 建筑朝哪边围，和人从哪儿进来，是两件事。
//
// ## 触发条件（保守）
//
// 只在"临街面短到撑不起一个院子"时才加这个候选：
//   · frontageRatio = 临街长度 / 地块主轴展向 < 0.22
//   · 且临街长度本身 < 30 m
//
// 正常地块（比例 ≥ 0.23）**完全不受影响**：候选列表不变、winner 不变。
//
// ## 边界
//
// 只吃 SiteContext、只吐 SitePlanCandidate，不碰 Scene / three。
// 走和常规候选同一套 mfDiagnostics + evaluateLayout —— 不给 fallback 开小灶。

import { Pt } from '../../../../core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceSubtract, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type {
  PlannedAccess,
  PlannedBuilding,
  PlannedRegion,
  ParkingRequest,
  SitePlanCandidate,
} from '../../core/candidate';
import { principalAxisOf, angleBetween } from './principal-axis';

const U = (m: number) => m / 7;
/** 板楼进深（米）—— 和常规方案一致 */
const BAR_DEPTH_M = 14;
/** 院子最小净尺寸（米） */
const COURT_MIN_M = 16;

/**
 * 触发判据（保守版）。
 *
 * 数据说明（seed 682063530，26 块有候选的 MF 地）：
 *   · 失败地块的 frontageRatio 是 14%~21%；正常地块 ≥ 23%
 *   · 但 ratio < 0.22 会同时命中一块"正常"地块（126:-424，覆盖 25%），
 *     所以**再加一条"临街长度 < 30 m"**做二次确认。
 *
 * 最终命中 7 块（6 块失败地块 + 126:-424），
 * 其中 126:-424 只是**多一个候选**，它的 winner 靠同一套评分自己决定。
 */
export const PRINCIPAL_TRIGGER = {
  frontageRatio: 0.22,
  frontageLengthM: 30,
};

export interface PrincipalTrigger {
  fired: boolean;
  frontageRatio: number;
  frontageLengthM: number;
  reason: string;
}

/** 判断是否需要追加 principal-axis 候选 */
export function shouldUsePrincipalAxis(ctx: SiteContext): PrincipalTrigger {
  const prim = ctx.primaryFrontage;
  if (!prim) return { fired: false, frontageRatio: 0, frontageLengthM: 0, reason: '无临街面' };
  const pa = principalAxisOf(ctx.buildableArea);
  if (!pa) return { fired: false, frontageRatio: 0, frontageLengthM: 0, reason: '算不出主轴' };
  const [ea, eb] = prim.parcelEdge;
  const frontageLengthM = Math.hypot(eb.x - ea.x, eb.y - ea.y) * 7;
  const ratio = frontageLengthM / Math.max(1e-6, pa.majorExtent * 7);
  const fired = ratio < PRINCIPAL_TRIGGER.frontageRatio && frontageLengthM < PRINCIPAL_TRIGGER.frontageLengthM;
  return {
    fired,
    frontageRatio: ratio,
    frontageLengthM,
    reason: fired
      ? `临街 ${frontageLengthM.toFixed(0)} m 只有地块展向 ${(pa.majorExtent * 7).toFixed(0)} m 的 ${(ratio * 100).toFixed(0)}%，撑不起常规围合`
      : `临街 ${frontageLengthM.toFixed(0)} m / 展向 ${(pa.majorExtent * 7).toFixed(0)} m = ${(ratio * 100).toFixed(0)}%，常规围合成立`,
  };
}

/**
 * 生成"主轴围合"候选。
 *
 * 步骤：
 *   ① OBB（长轴坐标系）→ 局部矩形 u∈[0,Lu]、v∈[0,Lv]
 *   ② 判断临街在 OBB 的哪一侧（长边还是短边）
 *   ③ 把"临街那一侧"转到局部坐标的 v = 0（这样院子的开口方向天然朝着街）
 *   ④ 院子 = OBB 内缩 barDepth；三条 bar 围合；临街侧的 bar 只做临街面那一段
 *   ⑤ 入口仍然开在 primary frontage 上
 */
export function buildPrincipalCourtCandidate(ctx: SiteContext): SitePlanCandidate | null {
  const prim = ctx.primaryFrontage;
  if (!prim) return null;
  const pa = principalAxisOf(ctx.buildableArea);
  if (!pa) return null;

  const notes: string[] = [];

  // ---- ① 临街在 OBB 的哪一侧？
  const [ea, eb] = prim.parcelEdge;
  const frontDir = new Pt(eb.x - ea.x, eb.y - ea.y);
  const flen = Math.hypot(frontDir.x, frontDir.y);
  if (flen < 1e-6) return null;
  const frontUnit = new Pt(frontDir.x / flen, frontDir.y / flen);

  // 临街边方向平行于长轴 → 街在 OBB 的"长边"上（v = ±1）；平行于短轴 → 街在短边上（u = ±1）
  const parallelMajor = angleBetween(frontUnit, pa.major) < angleBetween(frontUnit, pa.minor);

  // 临街中点在 OBB 长轴坐标系里的位置 → 决定是 +1 还是 -1
  const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const em = extentOfRing(ctx.buildableArea.outer, pa.major);
  const en = extentOfRing(ctx.buildableArea.outer, pa.minor);
  const uMid = project(mid, pa.major, em.center);
  const vMid = project(mid, pa.minor, en.center);

  // ---- ② 局部坐标系：v = 0 永远是临街那一侧
  //   街在长边 → u' = 长轴，v' = 短轴（必要时翻转 v'）
  //   街在短边 → u' = 短轴，v' = 长轴（必要时翻转 v'）
  //
  //   注意：轴向来自 OBB，但**范围取可建区自己的投影**，不用 OBB 的。
  //   OBB 会比可建区大（斜边 / 三角地），早先直接用 OBB 范围，
  //   结果"临街带"整条落在可建区之外 —— 入口前场和停车全丢，方案直接废掉。
  const streetOnLongSide = parallelMajor;
  const uAxis = streetOnLongSide ? pa.major : pa.minor;
  const vAxisRaw = streetOnLongSide ? pa.minor : pa.major;
  const flipV = streetOnLongSide ? vMid > 0 : uMid > 0;
  const vAxis = flipV ? new Pt(-vAxisRaw.x, -vAxisRaw.y) : vAxisRaw;

  const eu = extentOfRing(ctx.buildableArea.outer, uAxis);
  const evRaw = extentOfRing(ctx.buildableArea.outer, vAxisRaw);
  // 翻转后 v 的投影范围也要跟着翻（lo/hi 互换，取负）
  const ev = flipV
    ? { lo: -evRaw.hi, hi: -evRaw.lo, len: evRaw.len, center: -evRaw.center }
    : evRaw;
  const Lu = eu.len;
  const Lv = ev.len;

  // 局部坐标 → 世界。uAxis / vAxis 是单位正交向量，
  // 所以"投影坐标为 (eu.lo, ev.lo) 的那个世界点"就是 uAxis*eu.lo + vAxis*ev.lo。
  const origin = new Pt(uAxis.x * eu.lo + vAxis.x * ev.lo, uAxis.y * eu.lo + vAxis.y * ev.lo);
  const at = (lu: number, lv: number) =>
    new Pt(origin.x + uAxis.x * lu + vAxis.x * lv, origin.y + uAxis.y * lu + vAxis.y * lv);

  const bd = U(BAR_DEPTH_M);
  // 院子净尺寸
  const courtU = Lu - 2 * bd;
  const courtV = Lv - 2 * bd;
  if (courtU < U(COURT_MIN_M) || courtV < U(COURT_MIN_M)) {
    notes.push(`主轴内缩后院子只有 ${(courtU * 7).toFixed(0)}×${(courtV * 7).toFixed(0)} m，撑不起院子`);
    return null;
  }

  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    const parts = cutAll(lu0, lu1, lv0, lv1);
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };
  /** 与可建区求交后**全部**碎块（挖洞用） */
  const cutAll = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface[] => {
    if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return [];
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    return surfaceIntersect([rect], [ctx.buildableArea]).filter((p) => surfaceArea(p) > U(1) * U(1));
  };

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  const buildings: PlannedBuilding[] = [];
  // 同 courtyard：临街（主轴方案的临街侧是敞开的，所以没有临街 bar）
  // 侧边 6 层、远端 5 层，形成从外到内的退台
  const hSide = U(18);
  const hRear = U(15);
  const barHeight = hSide;

  // ---- ③ 配套 / 后勤先算，院子再把它们挖掉
  //
  // 为什么顺序反过来：配套（amenity）和后勤带（service）都落在院子范围内。
  // 早先让它们直接压在院子上面，语义上没问题（Realizer 会按优先级切割），
  // 但**几何上两条边界相切**，polygon-clipping 直接抛 "not a valid Polygon"，
  // 于是 surfaceUnion 走兜底分支把重叠面积算两遍，Fidelity Gate 的
  // groundCoverage 从 1.00 掉到 0.95 —— 看起来像 Realizer 漏做 5% 地面。
  // 现在院子主动让出这两块，边界不相切。
  // 关键：**内缩 1.5 m**，让配套 / 后勤带和院子边界**不相切**。
  // 相切（边界完全重合）在 polygon-clipping 里等于非法多边形，
  // 并集直接抛错 → Fidelity Gate 的 groundCoverage 被算成 0.95。
  const gap = U(1.5);
  const amenityS = cut(
    Lu - bd - (Lu - 2 * bd) * 0.3,
    Lu - bd - gap,
    bd + (Lv - 2 * bd) * 0.1,
    bd + (Lv - 2 * bd) * 0.45
  );
  const serviceS = cut(
    Lu - bd - (Lu - 2 * bd) * 0.45,
    Lu - bd - gap,
    Lv - bd - U(6.5),
    Lv - bd - gap
  );

  // ---- ④ 院子：先算不 add —— 院内步道要从它身上切出去（⑤ 末尾统一 add）
  const courtRaw = cutAll(bd, Lu - bd, bd, Lv - bd);
  if (courtRaw.length === 0) return null;
  const courtParts = courtRaw;
  if (courtParts.every((p) => surfaceArea(p) < U(1) * U(1))) return null;

  // ---- ⑤ 三条 bar：两条侧边 + 一条远端。
  //      临街那一侧**不设 bar** —— 街只有 18~27 m，把整条边盖满等于给
  //      一条没有街的边造一栋 130 m 长的楼。街道那侧交给前场 + 停车。
  const pushBar = (s: PlanSurface | null, note: string, h: number = hSide) => {
    if (!s) return;
    if (shortestSideM(s) < 7) {
      notes.push(`${note}：短边 ${shortestSideM(s).toFixed(0)} m 太薄，丢弃（避免纸片楼）`);
      return;
    }
    buildings.push({ role: 'house', footprint: s, height: h, notes: [note] });
  };
  pushBar(cut(0, bd, bd, Lv - bd), '侧边 bar（左）', hSide);
  pushBar(cut(Lu - bd, Lu, bd, Lv - bd), '侧边 bar（右）', hSide);
  pushBar(cut(bd, Lu - bd, Lv - bd, Lv), '远端 bar', hRear);

  if (buildings.length < 2) {
    notes.push(`主轴方案只立起 ${buildings.length} 条 bar，形态不成立`);
    return null;
  }

  // ---- ⑤ 临街侧：前场 + 入口轴 + 两侧绿化/停车
  //    临街边在局部 u 坐标里的跨度（投影用绝对值再减去原点）
  const eaU = ea.x * uAxis.x + ea.y * uAxis.y;
  const ebU = eb.x * uAxis.x + eb.y * uAxis.y;
  const sFrontLo = Math.min(eaU, ebU) - eu.lo;
  const sFrontHi = Math.max(eaU, ebU) - eu.lo;

  // 人行 / 车行开口的间距：和常规方案同一套口径（4 单位 ≈ 28 m）。
  // 短边放不下就如实标 SHARED_DRIVE，不做"假装分开"。
  const edgeLen = Math.hypot(eb.x - ea.x, eb.y - ea.y);
  const gapT = Math.min(0.94, 4.6 / Math.max(0.5, edgeLen));
  const tPed = Math.min(0.94, 0.5 + gapT / 2);
  const tCar = Math.max(0.06, 0.5 - gapT / 2);
  const atFront = (t: number) => new Pt(ea.x + (eb.x - ea.x) * t, ea.y + (eb.y - ea.y) * t);
  const pedAt = atFront(tPed);
  const carAt = atFront(tCar);
  // 入口在局部 u 坐标里的位置（t → u' 的线性映射）
  const uOf = (t: number) => (eaU - eu.lo) * (1 - t) + (ebU - eu.lo) * t;
  const midU = uOf(tPed);

  // 前场 / 入口轴：只认"不是碎缝"的。斜边地上这块可能只有几平米 ——
  // 硬塞进地面表会被"碎片"惩罚算成切碎（544:-100 就是这么输掉 0.6 分的）。
  // 沿街绿化带：最外面 3 m 归绿化，前场与停车都退到它后面。
  //
  // 这条带子是**街道界面**：早先临街带是"前场 + 地面停车"，停车直接对街，
  // 街道两侧一半是车屁股（实测 principal 形态的街墙率 41%、
  // 临街采样点里 46% 前面完全没有建筑）。3 m 的绿篱带既是最小可行的界面，
  // 也不吃掉停车（只在进深上让 3 m）。
  const vergeD = U(3);
  const vergeS = cut(0, Lu, 0, vergeD);
  add('landscape', vergeS, '沿街绿化带');

  const foreS = cut(sFrontLo, sFrontHi, vergeD, bd);
  add('entrance_forecourt', foreS && shortestSideM(foreS) >= 3 ? foreS : null, '入口前场（临街）');
  // ---- 院内步行骨架（R8）
  //
  // 原来只有一条 14 m 的"入口轴"就停在院子中间，院子本身是整块草坪 ——
  // 2D 上读起来是"一块绿毯"，人走到一半就没路了。
  // 现在主步道一直贯穿到远端 bar，院子够大时再加一条横向支路串两侧 bar，
  // 草坪被切成 2~4 块，这才是围合院的样子。
  const walks: PlanSurface[] = [];
  // 主步道从**院子边**（bd）起，不要从 0 起 —— 临街带里有前场和地面停车，
  // 从 0 起会直接压在停车上（实测 parking×pedestrian 6581 m² / 27 处，
  // 大部分来自这一条）。
  const walkMain = cut(midU - U(2.5), midU + U(2.5), bd, Lv - bd);
  if (walkMain && shortestSideM(walkMain) >= 3) walks.push(walkMain);

  const inW = (Lu - 2 * bd) * 7;
  const inD = (Lv - 2 * bd) * 7;
  if (inW >= 26 && inD >= 22) {
    const cvMid = bd + (Lv - 2 * bd) * 0.5;
    // 横路只能在**院子范围内**（bd..Lu-bd），早先写成 0..Lu 会压到左右两条 bar
    const cross = cut(bd, Lu - bd, cvMid - U(2), cvMid + U(2));
    if (cross) {
      // 十字交叉点减去主步道，避免两块面叠在一起
      const halves = walkMain ? surfaceSubtract([cross], [walkMain]) : [cross];
      for (const h of halves) if (shortestSideM(h) >= 3) walks.push(h);
    }
  }

  // 草坪 = 院子 − 步道 − 配套 − 后勤。
  // 配套/后勤本来就落在院子矩形里，早先只写了注释"挖掉"却真的没挖，
  // courtyard × amenity 因此重叠了 3772 m² / 9 处。
  const carveOut = [amenityS, serviceS, ...walks].filter((x): x is PlanSurface => !!x);
  const lawn = carveOut.length > 0 ? surfaceSubtract(courtRaw, carveOut) : courtRaw;
  let courtAdded = false;
  for (const piece of lawn) {
    if (surfaceArea(piece) < U(1) * U(1)) continue;
    add('courtyard', piece, '主轴围合院子');
    courtAdded = true;
  }
  for (const w of walks) add('pedestrian', w, '院内步道（街 → 各栋）');
  if (!courtAdded) return null;
  notes.push(`院内步道 ${walks.length} 条，草坪 ${lawn.length} 块`);

  // 临街带里前场之外的部分：靠入口一侧做地面停车，另一侧做绿化
  const parkSide = cut(sFrontHi, Lu, vergeD, bd);
  let park = parkSide
    ? (() => {
        const rest = surfaceSubtract([parkSide], courtParts);
        if (rest.length === 0) return null;
        const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
        return surfaceArea(big) > surfaceArea(parkSide) * 0.2 ? big : null;
      })()
    : null;

  // ---- ⑥ 配套 / 后勤（院子已经为它们让出位置）
  add('amenity', amenityS, '会客/活动场地');
  add('service', serviceS, '垃圾/后勤');

  // ---- ⑧ 剩下的地：能用的算绿地（围合式住宅外围本来就是绿地），太碎的才算残地
  const lotArea = surfaceArea(ctx.buildableArea);
  const used: PlanSurface[] = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const restAll = surfaceSubtract([ctx.buildableArea], used);

  // 临街带不在可建区里（斜边 / 三角地）时，停车改从**入口旁最大那块空地**里取。
  // 不这么做，这类地块的方案会因为"没有停车"而在 groundUsability / parkingQuality
  // 上白丢 1.0 分左右，直接输给稀疏但程序齐全的常规方案。
  if (!park) {
    const usable = restAll.filter((r) => surfaceArea(r) > lotArea * 0.02 && shortestSideM(r) >= 4);
    if (usable.length > 0) {
      const big = usable.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
      park = big;
    }
  }
  add('parking', park, parkSide ? '临街地面停车（不压院子）' : '入口旁地面停车（临街带不可用）');

  const used2: PlanSurface[] = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const restFinal = surfaceSubtract([ctx.buildableArea], used2);
  for (const piece of restFinal) {
    const a = surfaceArea(piece);
    // 短边 < 3 m 的是**碎缝**，既不算绿地也不算残地 —— 直接不认领，
    // 让地面归属阶段把它归给相邻区域。硬塞进地面表反而会被"碎片"惩罚算成切碎。
    if (shortestSideM(piece) < 3) continue;
    if (a > lotArea * 0.015) add('landscape', piece, '围合外围绿地');
    else if (a > lotArea * 0.01) add('residual', piece);
  }

  // ---- ⑩ 出入口：**人行仍然开在 primary frontage 上**（围合转向了，到达没转）
  const outward = norm(new Pt(mid.x - centroidOf(ctx.parcel.outer).x, mid.y - centroidOf(ctx.parcel.outer).y));
  const access: PlannedAccess[] = [
    { kind: 'pedestrian', at: pedAt, normal: outward, role: 'pedestrian', frontage: 'primary' },
    { kind: 'vehicle', at: carAt, normal: outward, role: 'car', frontage: 'primary' },
  ];
  const svc = ctx.serviceFrontage;
  if (svc && svc !== ctx.primaryFrontage) {
    const [sa, sb] = svc.parcelEdge;
    const p = new Pt((sa.x + sb.x) / 2, (sa.y + sb.y) / 2);
    access.push({
      kind: 'service',
      at: p,
      normal: norm(new Pt(p.x - centroidOf(ctx.parcel.outer).x, p.y - centroidOf(ctx.parcel.outer).y)),
      role: 'service',
      frontage: 'service',
    });
  } else {
    notes.push('SHARED_FRONTAGE_SERVICE：没有独立服务临街面');
  }

  // 主街太短（< 4.6 单位 ≈ 32 m）时，人行与车行分不开：
  // 有次临街面就把车行挪过去，否则如实标 SHARED_DRIVE。
  if (edgeLen < 4.6) {
    const svcFace = ctx.serviceFrontage;
    if (svcFace && svcFace !== ctx.primaryFrontage) {
      const [sa0, sb0] = svcFace.parcelEdge;
      const c2 = new Pt(sa0.x + (sb0.x - sa0.x) * 0.8, sa0.y + (sb0.y - sa0.y) * 0.8);
      access[1] = {
        kind: 'vehicle',
        at: c2,
        normal: norm(new Pt(c2.x - centroidOf(ctx.parcel.outer).x, c2.y - centroidOf(ctx.parcel.outer).y)),
        role: 'car',
        frontage: 'service',
      };
      if (Math.hypot(c2.x - pedAt.x, c2.y - pedAt.y) < 4) {
        notes.push('SHARED_DRIVE：地块过短，人行与车行开口被迫相邻');
      } else {
        notes.push('主街过短：车行口移到次临街面');
      }
    } else {
      notes.push('SHARED_DRIVE：单面短边，人行与车行共用主街开口');
    }
  }

  const parkingRequests: ParkingRequest[] = [];
  if (park) {
    parkingRequests.push({
      role: 'visitor',
      region: park,
      preferredEntry: access[1].at,
      targetDensity: 'medium',
      notes: ['住户停车：Phase 2 只给区域'],
    });
  }

  notes.push(
    `主轴围合：展向 ${(Lu * 7).toFixed(0)} m × 短向 ${(Lv * 7).toFixed(0)} m，` +
      `临街在${streetOnLongSide ? '长边' : '短边'}，院子 ${(courtU * 7).toFixed(0)}×${(courtV * 7).toFixed(0)} m`
  );

  return {
    id: 'mf-court-principal',
    typology: 'multi_family',
    archetype: 'MF_COURT',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 工具

function project(p: Pt, axis: Pt, center: number): number {
  return (p.x * axis.x + p.y * axis.y) - center;
}

/** 一组点在某条轴上的投影范围 */
function extentOfRing(ring: Pt[], axis: Pt): { lo: number; hi: number; len: number; center: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { lo, hi, len: hi - lo, center: (lo + hi) / 2 };
}

function shortestSideM(s: PlanSurface): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of s.outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(maxX - minX, maxY - minY) * 7;
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}
