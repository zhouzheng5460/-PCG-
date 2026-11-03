// Archetype · Multi-Family / Courtyard（PRD §P2-MF.2 ~ §P2-MF.8）
//
// **顺序是这个文件最重要的设计**：先定院子，再围建筑。
//
//   BuildableArea
//        ↓
//   deriveCourtyard（按前/后/侧 bar 的进深反推院子净尺寸）
//        ↓
//   wrapBuildingsAround（四条 bar 围着院子长）
//
// 和工业正好相反。工业是"先定生产建筑，再从建筑往外长地面"；
// 住宅是"先定核心空间，再让建筑形成空间"。这就是 typology grammar 的差别。
//
// 四个候选（PRD §P2-MF.3）：
//   mf-court-balanced     四边围合
//   mf-court-front-open   朝主街打开（入口广场）
//   mf-court-rear-open    后侧打开（主街界面更连续）
//   mf-court-asymmetric   一侧缩短（L / U 形）
//
// 边界同工业：只吃 SiteContext、只吐 SitePlanCandidate，不碰 Scene / three。

import { Pt } from '../../../../core/geom';
import {
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  insideSurface,
  type PlanSurface,
} from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type {
  PlannedAccess,
  PlannedBuilding,
  PlannedRegion,
  ParkingRequest,
  SitePlanCandidate,
} from '../../core/candidate';
import {
  mfDiagnostics,
  COURT_MIN_W_M,
  COURT_MIN_D_M,
  COURT_MAX_ASPECT,
} from '../../typologies/multifamily';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { buildPrincipalCourtCandidate, shouldUsePrincipalAxis } from './principal-court';

const U = (m: number) => m / 7;

/** 板楼进深（米）：住宅质量的关键参数，不允许"填满剩余空间" */
const BAR_DEPTH_M = { shallow: 11, normal: 14, deep: 17 } as const;

interface MfVariant {
  id: string;
  /** 临街侧 bar 是否存在 */
  front: boolean;
  /** 后侧 bar 是否存在 */
  rear: boolean;
  /** 西侧 bar 的进深（0 = 没有） */
  west: number;
  east: number;
  barDepth: keyof typeof BAR_DEPTH_M;
  /** 围合度目标（Evaluator 用它判"围合得刚好"） */
  targetEnclosure: number;
}

const VARIANTS: MfVariant[] = [
  { id: 'mf-court-balanced', front: true, rear: true, west: 1, east: 1, barDepth: 'normal', targetEnclosure: 0.95 },
  { id: 'mf-court-front-open', front: false, rear: true, west: 1, east: 1, barDepth: 'normal', targetEnclosure: 0.72 },
  { id: 'mf-court-rear-open', front: true, rear: false, west: 1, east: 1, barDepth: 'normal', targetEnclosure: 0.75 },
  { id: 'mf-court-asymmetric', front: true, rear: true, west: 0.6, east: 1, barDepth: 'shallow', targetEnclosure: 0.85 },
  // 降级形态：三边围合（U 形），浅进深。狭长地块放不下四边院子时靠它兜住，
  // 而不是让整块地一个候选都没有（PRD §P2-MF.5 / M02）。
  { id: 'mf-court-u', front: true, rear: true, west: 0, east: 1, barDepth: 'shallow', targetEnclosure: 0.7 },
];

export function generateMultiFamilyCourtyardCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const prim = ctx.primaryFrontage;
  if (!prim) return [];
  const buildable = ctx.buildableArea;
  if (buildable.outer.length < 3) return [];

  // ---- 局部坐标系（o = 临街边中点，u 沿街，v 向地块内部）
  const [ea, eb] = prim.parcelEdge;
  const o = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const uDir = norm(new Pt(eb.x - ea.x, eb.y - ea.y));
  let vDir = new Pt(-uDir.y, uDir.x);
  if (!insideSurface(new Pt(o.x + vDir.x * 1.5, o.y + vDir.y * 1.5), buildable)) vDir = new Pt(-vDir.x, -vDir.y);
  const at = (lu: number, lv: number) => new Pt(o.x + uDir.x * lu + vDir.x * lv, o.y + uDir.y * lu + vDir.y * lv);

  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of buildable.outer) {
    const du = (p.x - o.x) * uDir.x + (p.y - o.y) * uDir.y;
    const dv = (p.x - o.x) * vDir.x + (p.y - o.y) * vDir.y;
    if (du < u0) u0 = du;
    if (du > u1) u1 = du;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  const W = u1 - u0;
  const D = v1 - v0;
  if (W < U(COURT_MIN_W_M) || D < U(COURT_MIN_D_M)) return [];

  const out: SitePlanCandidate[] = [];
  const genNotes: string[] = [];
  for (const v of VARIANTS) {
    const c = buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
    if (c) out.push(c);
  }

  // ---- TECH-04 fallback：临街面撑不起常规围合时，追加一个**主轴围合**候选
  //
  // 触发条件保守（见 principal-court.ts）：只有"临街面 < 30 m 且不到地块展向的 22%"
  // 才触发。正常地块的候选列表**完全不变**，winner 也不变。
  // 追加进来的候选和常规候选走同一套 mfDiagnostics + evaluateLayout —— 不开小灶。
  const trig = shouldUsePrincipalAxis(ctx);
  if (trig.fired) {
    const pc = buildPrincipalCourtCandidate(ctx);
    if (pc) {
      pc.notes.unshift(`AXIS_MISMATCH：${trig.reason}`);
      out.push(pc);
    } else {
      genNotes.push(`AXIS_MISMATCH：${trig.reason}；主轴方案不成立`);
    }
  }

  for (const c of out) {
    // principal 变体是"三面围合"（街那一侧故意打开），围合目标给 0.75
    const target = c.id === 'mf-court-principal' ? 0.75 : VARIANTS.find((v) => v.id === c.id)?.targetEnclosure;
    c.diagnostics = mfDiagnostics(ctx, c, { targetEnclosure: target });
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('multi_family') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

interface Frame {
  at: (lu: number, lv: number) => Pt;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  W: number;
  D: number;
  variant: MfVariant;
}

function buildVariant(ctx: SiteContext, f: Frame): SitePlanCandidate | null {
  const { at, u0, u1, v0, v1, W, D, variant } = f;
  const notes: string[] = [];
  const bd = U(BAR_DEPTH_M[variant.barDepth]);

  // ---- ① 先定院子：净尺寸 = 地块 − 前/后/侧 bar 进深
  const frontD = variant.front ? bd : 0;
  const rearD = variant.rear ? bd : 0;
  const westD = variant.west > 0 ? bd * variant.west : 0;
  const eastD = variant.east > 0 ? bd * variant.east : 0;
  let courtW = W - westD - eastD;
  const courtD = D - frontD - rearD;

  let courtWM = courtW * 7;
  const courtDM = courtD * 7;
  if (courtW < U(COURT_MIN_W_M) * 0.7 || courtD < U(COURT_MIN_D_M) * 0.7) {
    notes.push(`院子净尺寸不足（${courtWM.toFixed(0)}×${courtDM.toFixed(0)} m），该形态不成立`);
    return null;
  }

  // 长宽比过大时**居中缩窄院子**，而不是判死 —— 狭长地块本来就是带状绿地，
  // 硬撑成一条 5:1 的院子既不像院子，也会把两侧建筑拉成纸片。
  let sideSlack = 0;
  const aspect = Math.max(courtWM, courtDM) / Math.max(1, Math.min(courtWM, courtDM));
  // 只有"收窄后能留下 >= 4 m 的整条绿地"才收窄院子。
  // 早先不管收窄多少都收，结果在窄地块上留下 1~2 m 的绿缝 ——
  // 视觉上是残地，度量上又被判成"碎片"，两头挨罚。
  const slackMinM = 4;
  if (aspect > COURT_MAX_ASPECT && courtWM > courtDM) {
    const targetW = Math.min(courtW, U(courtDM * COURT_MAX_ASPECT));
    const slackEach = (courtW - targetW) / 2;
    if (slackEach * 7 >= slackMinM) {
      sideSlack = slackEach;
      courtW = targetW;
      courtWM = courtW * 7;
      notes.push(`院子按 ${COURT_MAX_ASPECT}:1 收窄（两侧留 ${(sideSlack * 7).toFixed(0)} m 绿化）`);
    } else {
      notes.push(`院子长宽比 ${aspect.toFixed(1)}:1 偏大，但收窄只能留出 ${(slackEach * 7).toFixed(1)} m 绿缝，不收窄`);
    }
  }
  if (courtWM < COURT_MIN_W_M || courtDM < COURT_MIN_D_M) notes.push(`院子偏小（${courtWM.toFixed(0)}×${courtDM.toFixed(0)} m）`);

  const cu0 = u0 + westD + sideSlack;
  const cu1 = u1 - eastD - sideSlack;
  const cv0 = v0 + frontD;
  const cv1 = v1 - rearD;

  // ---- 裁切工具：局部矩形 → 世界 → 裁到可建区
  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return null;
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    const parts = surfaceIntersect([rect], [ctx.buildableArea]);
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };

  // ---- ② 院子先出生
  const court = cut(cu0, cu1, cv0, cv1);
  if (!court) return null;
  // 院子必须是"方正的一块"：被 L 形缺口 / 斜边切碎的多边形不算院子
  //（否则 L 形地块上四个形态全都能"成立"，候选系统就失去筛选意义了）
  const courtRect = rectnessOf(court.outer);
  if (courtRect < 0.7) {
    notes.push(`院子被切碎（矩形度 ${courtRect.toFixed(2)}），该形态不成立`);
    return null;
  }

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  add('courtyard', court);

  // ---- ③ 建筑围着院子长（四条 bar，各自独立，不做带洞多边形）
  const buildings: PlannedBuilding[] = [];
  // 6 层 × 3 m = 18 m。
  // 这里原本写的是 `U(6.5) // 6 层左右` —— 单位搞错了：U() 是"米 → 世界单位"，
  // 6.5 变成 6.5 米（≈2 层），整片 MF 在 3D 里是两层高的棚子。
  // Shadow 的体量代理暴露了它：基地面积 2.68× legacy，体积却只有 0.74×。
  const barHeight = U(18);
  const pushBar = (s: PlanSurface | null, note: string) => {
    if (!s) return;
    // 纸片楼过滤：短边 < 7 m 的 bar 在 3D 里是一张纸，而且会被"碎片"度量算成切碎。
    // 宁可这块地少一条 bar，也不要留一条纸片 —— 用户早就说过"尽量不要纸片楼"。
    if (shortestSideM(s) < 7) {
      notes.push(`${note}：短边 ${shortestSideM(s).toFixed(0)} m 太薄，丢弃（避免纸片楼）`);
      return;
    }
    buildings.push({ role: 'house', footprint: s, height: barHeight, notes: [note] });
  };

  if (variant.front) pushBar(cut(u0, u1, v0, v0 + frontD), '临街 bar（主街界面）');
  // 后侧 bar **不占满面宽**：留出一段给停车。早先 rear bar 占满，停车只能往院子边上挤，
  // 结果"停车压院子"在 M01/M02/M07 全线报错 —— 住宅的停车必须退到侧后方，
  // 而后侧 bar 本身就是"后侧"，所以从它身上让一段最合理。
  const rearParkW = variant.rear ? W * 0.3 : 0;
  if (variant.rear) pushBar(cut(u0, u1 - rearParkW - W * 0.02, v1 - rearD, v1), '后侧 bar（让出一段给停车）');
  if (westD > 0) {
    // asymmetric：西侧只占院子的一段时间（形成 L 形），另一端让出来做通道。
    // 但缩短后的段如果不足 12 m 就成了纸片楼 —— 那种情况下宁可做满。
    let seg = variant.west < 0.8 ? 0.62 : 1;
    if (courtD * seg < U(12)) seg = 1;
    pushBar(cut(u0, u0 + westD, cv0, cv0 + courtD * seg), `西侧 bar（占 ${(seg * 100).toFixed(0)}%）`);
  }
  if (eastD > 0) pushBar(cut(u1 - eastD, u1, cv0, cv1), '东侧 bar');

  if (buildings.length < 3) {
    notes.push(`围合不足（${buildings.length} 条 bar），该形态不成立`);
    return null;
  }

  // ---- ④ 前场：入口广场（front-open 时它和院子连成一片）
  const foreDepth = Math.max(U(6), bd * 0.55);
  if (variant.front) {
    // 有临街 bar：前广场压在 bar 前面，居中留出主入口
    add('entrance_forecourt', cut(u0 + W * 0.34, u0 + W * 0.66, v0 - 0, v0 + Math.min(foreDepth, frontD * 0.6)));
  } else {
    // 朝街打开：入口广场就是院子朝街的那一段
    add('entrance_forecourt', cut(cu0 + courtW * 0.25, cu1 - courtW * 0.25, v0, v0 + Math.min(foreDepth, courtD * 0.4)));
    // 人行轴：从街直接穿到院子
    add('pedestrian', cut(u0 + W * 0.46, u0 + W * 0.54, v0, cv0 + courtD * 0.5), '入口轴（街 → 院子）');
  }

  // ---- ⑤ 配套（院子一角）与绿化（沿街两侧）
  add('amenity', cut(cu1 - courtW * 0.32, cu1 - courtW * 0.04, cv0 + courtD * 0.1, cv0 + courtD * 0.45), '会客/活动场地');
  // 沿街两端的绿化带：宽度给下限 4 m、上限 22% 面宽。
  // 早先固定 14% 面宽，在 20 m 宽的地块上就是 2.8 m 的细缝 —— 既难看，
  // 又会被"碎片"惩罚算成切碎，直接把 balanced 形态顶下去。
  const endGreenW = Math.min(Math.max(U(4), W * 0.14), W * 0.22);
  add('landscape', cut(u0, u0 + endGreenW, v0, v0 + Math.min(foreDepth, D * 0.25)));
  add('landscape', cut(u1 - endGreenW, u1, v0, v0 + Math.min(foreDepth, D * 0.25)));
  // 院子收窄后在两侧留下的条带：给绿化，别让它变成残地
  if (sideSlack > U(2)) {
    add('landscape', cut(u1 - eastD - sideSlack, u1 - eastD, v0 + frontD, v1 - rearD), '院子收窄后的东侧绿地');
    if (westD > 0) add('landscape', cut(u0 + westD, u0 + westD + sideSlack, v0 + frontD, v1 - rearD), '西侧绿地');
  }

  // ---- ⑥ 停车：只允许后侧 / 侧向，**不占主街正面、不压院子**
  const parkRaw = variant.rear
    ? cut(u1 - rearParkW, u1, v1 - rearD, v1) // 后侧 bar 让出的那一段
    : cut(u1 - W * 0.3, u1, v0 + frontD, v1 - Math.min(U(4), bd * 0.3)); // 无后 bar：东侧一条
  // 斜边 / L 形地块上停车区可能与院子咬合 —— 再减一次院子，取剩下的最大块
  const park = parkRaw
    ? (() => {
        const rest = surfaceSubtract([parkRaw], [court]);
        if (rest.length === 0) return null;
        const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
        return surfaceArea(big) > surfaceArea(parkRaw) * 0.25 ? big : null;
      })()
    : null;
  add('parking', park, variant.rear ? '后侧停车（rear bar 让位）' : '侧向停车（后侧无 bar）');

  // ---- ⑦ 服务：后侧一条窄带，避开停车
  add('service', cut(u0 + W * 0.66, u1 - W * 0.04, v1 - Math.min(U(6), rearD * 0.5), v1), '垃圾/后勤');

  // ---- ⑧ 残地
  const used: PlanSurface[] = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const rest = surfaceSubtract([ctx.buildableArea], used);
  if (rest.length > 0) {
    const biggest = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    if (surfaceArea(biggest) > surfaceArea(ctx.buildableArea) * 0.01) add('residual', biggest);
  }

  // ---- ⑨ 出入口：人行先于车行（street → entrance → courtyard）
  const edgePoint = (t: number): Pt => {
    const [a, b] = ctx.primaryFrontage!.parcelEdge;
    return new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  };
  const outward = norm(new Pt(o0(f).x - centroidOf(ctx.parcel.outer).x, o0(f).y - centroidOf(ctx.parcel.outer).y));
  // 人行口与车行口的最小间距：4 单位（≈28 m）。按临街边长度换算成 t 的差，
  // 窄边（< 28 m）上硬用固定 0.55 / 0.1 会挤在一起。
  const edgeLen = Pt.distance(ctx.primaryFrontage!.parcelEdge[0], ctx.primaryFrontage!.parcelEdge[1]);
  const gapT = Math.min(0.94, 4.6 / Math.max(0.5, edgeLen));
  const tPed = Math.min(0.94, 0.5 + gapT / 2);
  const tCar = Math.max(0.06, 0.5 - gapT / 2);
  const access: PlannedAccess[] = [
    { kind: 'pedestrian', at: edgePoint(tPed), normal: outward, role: 'pedestrian', frontage: 'primary' },
    { kind: 'vehicle', at: edgePoint(tCar), normal: outward, role: 'car', frontage: 'primary' },
  ];
  const svc = ctx.serviceFrontage;

  // 主街太短（< 4.6 单位 ≈ 32 m）时，人行与车行挤在同一条短边上分不开：
  //   · 有次临街面 → 车行口挪过去（住宅本来就该"人行朝主街、车行走侧街"）；
  //   · 没有 → 只能共享，留痕 SHARED_DRIVE，不做无意义的假装分离。
  if (edgeLen < 4.6) {
    if (svc && svc !== ctx.primaryFrontage) {
      // 放在次临街面的**远端**（t=0.8），尽量远离主街的人行口
      const [sa0, sb0] = svc.parcelEdge;
      const carAt = new Pt(sa0.x + (sb0.x - sa0.x) * 0.8, sa0.y + (sb0.y - sa0.y) * 0.8);
      access[1] = {
        kind: 'vehicle',
        at: carAt,
        normal: norm(new Pt(carAt.x - centroidOf(ctx.parcel.outer).x, carAt.y - centroidOf(ctx.parcel.outer).y)),
        role: 'car',
        frontage: 'service',
      };
      // 20 m 见方的小地块上，两条边在转角相接，两个口再远也就十来米 ——
      // 这时如实标 SHARED_DRIVE，而不是假装它们分开了
      if (Math.hypot(carAt.x - access[0].at.x, carAt.y - access[0].at.y) < 4) {
        notes.push('SHARED_DRIVE：地块过小，人行与车行开口被迫相邻');
      } else {
        notes.push('主街过短：车行口移到次临街面');
      }
    } else {
      notes.push('SHARED_DRIVE：单面短边，人行与车行共用主街开口');
    }
  }

  if (svc && svc !== ctx.primaryFrontage) {
    const [sa, sb] = svc.parcelEdge;
    access.push({
      kind: 'service',
      at: new Pt((sa.x + sb.x) / 2, (sa.y + sb.y) / 2),
      normal: norm(new Pt((sa.x + sb.x) / 2 - centroidOf(ctx.parcel.outer).x, (sa.y + sb.y) / 2 - centroidOf(ctx.parcel.outer).y)),
      role: 'service',
      frontage: 'service',
    });
  }

  // ---- ⑩ 停车需求（只给区域）
  const parkingRequests: ParkingRequest[] = [];
  if (park) {
    parkingRequests.push({
      role: 'resident',
      region: park,
      preferredEntry: edgePoint(tCar),
      targetDensity: 'medium',
      notes: ['Phase 2 只给区域，车位由 parking.ts 消费'],
    });
  }

  return {
    id: `mf-court-${variant.id.replace('mf-court-', '')}`,
    typology: 'multi_family',
    archetype: 'MF_COURTYARD',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 工具

function o0(f: Frame): Pt {
  return f.at(0, 0);
}

/** 面域的最短边（米）——用来判断"这是一条 bar"还是"这是一张纸" */
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

/** 轮廓的矩形度（面积 / 外接矩形面积） */
function rectnessOf(ring: Pt[]): number {  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    a2 += p.x * q.y - q.x * p.y;
  }
  const box = (maxX - minX) * (maxY - minY);
  return box > 1e-9 ? Math.min(1, Math.abs(a2 / 2) / box) : 0;
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
