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
import { claimResidual } from '../shared/claim';
import { chooseParkingMode } from '../shared/parking-mode';

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

  // ---- 多组团：地块够大时排 N×M 个围合院 ----
  //
  // 一个围合组团需要院子（≥18×16 m）+ 四边 bar（各深 14~18 m），
  // 合计至少 58~70 m 见方。街区放大到 122 m（退线后约 92 m）之后，
  // 正好能排 1~2 个 —— 原来只排中间一个，四周全是空地，
  // 这就是"覆盖率 P50 只有 18~21%、大片绿地"的直接原因。
  //
  // 排多个组团时，组团之间留 7 m（内部人行道 + 绿化），不共用 bar。
  const GROUP_MIN = U(58);
  const GROUP_GAP = U(7);
  const nx = Math.max(1, Math.floor((W + GROUP_GAP) / (GROUP_MIN + GROUP_GAP)));
  const ny = Math.max(1, Math.floor((D + GROUP_GAP) / (GROUP_MIN + GROUP_GAP)));

  const out: SitePlanCandidate[] = [];
  const genNotes: string[] = [];
  for (const v of VARIANTS) {
    const c =
      nx * ny > 1
        ? buildMultiGroup(ctx, { at, u0, v0, W, D, nx, ny, variant: v })
        : buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
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

/**
 * 多组团：把地块按 N×M 切成若干围合组团，各自跑一遍 `buildVariant`，再合并。
 *
 * **不改 buildVariant 一行**：每个组团都是一个完整的、有自己院子和四边 bar 的
 * 小街区，校验（围合不足 / 纸片楼 / 院子太小）也各自跑。
 *
 * 合并后：
 *   · buildings / ground / parkingRequests 累加；
 *   · **入口只取第一组**（主临街那一组）—— 其余组团从内部通道进，
 *     不能每个院子都开一个临街车行口；
 *   · 诊断与评分由外层统一重算（合并后院子变成多个，围合度要按新的算）。
 */
function buildMultiGroup(
  ctx: SiteContext,
  f: { at: (lu: number, lv: number) => Pt; u0: number; v0: number; W: number; D: number; nx: number; ny: number; variant: MfVariant }
): SitePlanCandidate | null {
  const { at, u0, v0, W, D, nx, ny, variant } = f;
  const GROUP_GAP = U(7);
  const cw = (W - (nx - 1) * GROUP_GAP) / nx;
  const cd = (D - (ny - 1) * GROUP_GAP) / ny;
  if (cw < U(50) || cd < U(50)) return null;

  const pieces: SitePlanCandidate[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const su0 = u0 + i * (cw + GROUP_GAP);
      const sv0 = v0 + j * (cd + GROUP_GAP);
      const c = buildVariant(ctx, {
        at,
        u0: su0,
        u1: su0 + cw,
        v0: sv0,
        v1: sv0 + cd,
        W: cw,
        D: cd,
        variant,
      });
      if (c) pieces.push(c);
    }
  }
  // 只成立一组就退回单组团（别给一个院子的方案套上 "2×2" 的名字）
  if (pieces.length < 2) return pieces[0] ?? null;

  const first = pieces[0];
  return {
    ...first,
    id: `${first.id}-${nx}x${ny}`,
    notes: [`${nx}×${ny} 组团（${pieces.length}/${nx * ny} 组成立）`, ...first.notes],
    buildings: pieces.flatMap((p) => p.buildings),
    ground: pieces.flatMap((p) => p.ground),
    parkingRequests: pieces.flatMap((p) => p.parkingRequests),
    // 入口只保留第一组（主临街），其余从内部通道进
    access: first.access,
    circulation: pieces.flatMap((p) => p.circulation),
  };
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
  // 矩形度门槛 0.70 → 0.55。
  //
  // 街区放大到 122 m 之后，很多地块是可建区矩形度只有 37~58% 的斜长条
  //（外接 134×109 m 但可建只有 5456 m²）。原来 0.70 的门槛把这些地块
  // 全部判死 —— 实测 10 块住宅地只生成 3 块。
  // 0.55 能放过斜四边形院子（真实的围合院本来就不方正），
  // 仍然拦得住 L 形 / 被切碎的院子。
  const courtRect = rectnessOf(court.outer);
  if (courtRect < 0.55) {
    notes.push(`院子被切碎（矩形度 ${courtRect.toFixed(2)}），该形态不成立`);
    return null;
  }

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  // 院子的 add 推迟到 ⑤：室外的步行骨架要从它身上切出步道，
  // 先 add 会在 ground 里留下"整块草坪 + 压在上面的步道"两套互相重叠的面。
  const entryU = cu0 + courtW * 0.5;

  // ---- ③ 建筑围着院子长（四条 bar，各自独立，不做带洞多边形）
  const buildings: PlannedBuilding[] = [];
  // 6 层 × 3 m = 18 m。
  // 这里原本写的是 `U(6.5) // 6 层左右` —— 单位搞错了：U() 是"米 → 世界单位"，
  // 6.5 变成 6.5 米（≈2 层），整片 MF 在 3D 里是两层高的棚子。
  // Shadow 的体量代理暴露了它：基地面积 2.68× legacy，体积却只有 0.74×。
  // ---- 高度分层：临街 7 层 / 侧边 6 层 / 后侧 5 层 ----
  //
  // 原来四条 bar 全是 6 层，围合式住宅在 3D 里就是**一圈等高的墙**，
  // 沿街天际线完全平的。真实的围合住宅是从街到院内逐级退台：
  // 临街最高（对外立面、采光好），后侧最矮（内部安静、退让邻居）。
  //
  // 只动高度、不动 footprint：覆盖率（强度带判据）不受影响，
  // 变的只是 Shadow 的体量代理 —— 那本来就是用来比较"盖了多少体积"的。
  const hFront = U(21); // 7 层
  const hSide = U(18); // 6 层
  const hRear = U(15); // 5 层
  const barHeight = hSide;
  const pushBar = (s: PlanSurface | null, note: string, h: number = hSide) => {
    if (!s) return;
    // 纸片楼过滤：短边 < 7 m 的 bar 在 3D 里是一张纸，而且会被"碎片"度量算成切碎。
    // 宁可这块地少一条 bar，也不要留一条纸片 —— 用户早就说过"尽量不要纸片楼"。
    if (shortestSideM(s) < 7) {
      notes.push(`${note}：短边 ${shortestSideM(s).toFixed(0)} m 太薄，丢弃（避免纸片楼）`);
      return;
    }
    // 矩形分解统一在 `generators.ts` 的生成器出口做（对所有 typology 生效），
    // 这里只管把 bar 交出来。放在出口的好处：footprint 变了之后能立刻用
    // 同一个诊断函数重算分，不会出现"几何改了、评分还是旧的"。
    buildings.push({ role: 'house', footprint: s, height: h, notes: [note] });
  };

  // 入口门洞是否开（面宽够才开；不够就整条 bar 保留，主步道只能从院子起）
  let gateOpen = false;
  if (variant.front) {
    // 临街 bar 中间必须**开一个门洞**，否则院子根本进不去：
    // bar 占满整个面宽，院子被它和街道完全隔开，人在平面上无路可走。
    // 门洞宽 5 m，两侧各留一段 bar（每段都得过纸片楼检查）。
    const bar = cut(u0, u1, v0, v0 + frontD);
    const gate = W * 7 >= 24 ? cut(entryU - U(2.5), entryU + U(2.5), v0 - U(1), v0 + frontD + U(1)) : null;
    const parts = bar && gate ? surfaceSubtract([bar], [gate]) : bar ? [bar] : [];
    for (const part of parts) pushBar(part, gate ? '临街 bar（中留 5 m 入口门洞）' : '临街 bar（主街界面）', hFront);
    gateOpen = !!gate;
  }
  // 后侧 bar **不占满面宽**：留出一段给停车。早先 rear bar 占满，停车只能往院子边上挤，
  // 结果"停车压院子"在 M01/M02/M07 全线报错 —— 住宅的停车必须退到侧后方，
  // 而后侧 bar 本身就是"后侧"，所以从它身上让一段最合理。
  const rearParkW = variant.rear ? W * 0.3 : 0;
  if (variant.rear) pushBar(cut(u0, u1 - rearParkW - W * 0.02, v1 - rearD, v1), '后侧 bar（让出一段给停车）', hRear);
  if (westD > 0) {
    // asymmetric：西侧只占院子的一段时间（形成 L 形），另一端让出来做通道。
    // 但缩短后的段如果不足 12 m 就成了纸片楼 —— 那种情况下宁可做满。
    let seg = variant.west < 0.8 ? 0.62 : 1;
    if (courtD * seg < U(12)) seg = 1;
    pushBar(cut(u0, u0 + westD, cv0, cv0 + courtD * seg), `西侧 bar（占 ${(seg * 100).toFixed(0)}%）`, hSide);
  }
  if (eastD > 0) pushBar(cut(u1 - eastD, u1, cv0, cv1), '东侧 bar', hSide);

  if (buildings.length < 3) {
    notes.push(`围合不足（${buildings.length} 条 bar），该形态不成立`);
    return null;
  }

  // ---- ④ 前场：入口广场（只算面，不 add —— 它要么落在门洞里、要么落在院子里，
  //      两种情况都必须从院子/草坪里挖出去，不能叠着放）
  const foreDepth = Math.max(U(6), bd * 0.55);
  const foreS = variant.front
    ? // 有临街 bar：前广场就是**门洞那一格**，深到 bar 背面（cv0 = v0 + frontD）。
      // 早先只做 0.6×frontD，门洞里剩下一段没 program 的空地；
      // 而且中心用的是地块中心 u0+0.5W，和门洞用的院子中心 entryU 不是一条线。
      (() => {
        const foreHalf = Math.min(W * 0.16, W * 0.5 - (entryU - u0));
        return cut(entryU - foreHalf, entryU + foreHalf, v0, cv0);
      })()
    : // 朝街打开：入口广场就是院子朝街的那一段（下面会和院子做差）
      cut(cu0 + courtW * 0.25, cu1 - courtW * 0.25, v0, v0 + Math.min(foreDepth, courtD * 0.4));

  // ---- ⑤ 院子内部：步行骨架
  //
  // 围合式住宅的院子**不是一块草坪** —— 人得能从街走到每栋楼门口。
  // 之前院子是一整块 courtyard（占 MF 地块 67%），只在前朝街的变体里有一条
  // 半截入口轴，2D 上读起来就是"一块绿毯 + 几棵树"，这是它显空的直接原因。
  //
  // 这里补最小可读结构：
  //   · 主入口轴：从临街（或门洞）贯穿院子到后侧 bar，宽 5 m；
  //   · 横向支路：院子够大时加，串起东西两翼，宽 4 m。
  // 十字步道把院子切成四块绿地，这才是"围合的院子"。
  // 步道宽度都 >= 4 m，不会被"碎片"度量算成窄缝（阈值 3 m）。
  const WALK_MAIN_HALF = U(2.5);
  const walks: PlanSurface[] = [];
  // 主步道从**院子边**（cv0）起，一直贯通到后侧 bar。
  // 不穿门洞：门洞里那一格是前场（entrance_forecourt），两段铺装首尾相接，
  // 视觉上是一条路；但**数据上不能重叠** —— 早先让步道从 v0 起，
  // 它和前场重合了 6.5% 的地面，G-R02（地面独占）直接红。
  void gateOpen;
  const walkMain = cut(entryU - WALK_MAIN_HALF, entryU + WALK_MAIN_HALF, cv0, cv1);
  if (walkMain) walks.push(walkMain);

  // 横向支路只在院子净宽 >= 26 m 且进深 >= 22 m 时加：
  // 更小的院子横切之后，四块草坪里最窄的会掉到 3~4 m，既不像绿地也不像场地。
  const crossOk = courtWM >= 26 && courtDM >= 22;
  if (crossOk) {
    const cvMid = cv0 + courtD * 0.5;
    const cross = cut(cu0, cu1, cvMid - U(2), cvMid + U(2));
    if (cross) {
      // 十字交叉点必然重叠 —— 横路要**减掉主步道**，变成左右两段。
      // 两块面占同一片地会在 G-R02（地面独占）里直接算成重叠。
      const halves = walkMain ? surfaceSubtract([cross], [walkMain]) : [cross];
      for (const h of halves) if (shortestSideM(h) >= 3) walks.push(h);
    }
  }

  // ---- ⑤b 配套：院子**东北象限**，让开十字步道
  //
  //   横向支路在 cv0 + courtD*0.5 上，宽 4 m（±2 m）。原来 amenity 的 v 范围是
  //   0.10~0.45 —— 在 22 m 进深的院子里，上沿 9.9 m、支路下沿 9 m，
  //   两者压在一起 0.9 m。现在整体移到支路以北（0.56~0.90），仍在东北角。
  const amenityS = cut(
    cu1 - courtW * 0.32,
    cu1 - courtW * 0.04,
    cv0 + courtD * 0.56,
    cv0 + courtD * 0.9
  );

  // 前场减掉步道：front-open 时前场落在院子朝街那一段，主步道正从中间穿过 ——
  // 不切的话两片铺装叠在一起（实测 1207 m² / 30 处）。切开后前场变成左右两翼，
  // 中间是步道，这才是"广场 + 中轴"的真实布局。
  const foreParts =
    foreS && walks.length > 0 ? surfaceSubtract([foreS], walks) : foreS ? [foreS] : [];

  // 草坪 = 院子 − 步道 − 场地 − 前场。**它们都要从草坪里挖出去**：
  // 叠着放的话 ground 里有多块面占同一片地，PlanSurface 的"地表独占"约定就破了。
  const carve = [...walks, ...[amenityS, ...foreParts].filter((x): x is PlanSurface => !!x)];
  const courtParts = carve.length > 0 ? surfaceSubtract([court], carve) : [court];
  for (const part of courtParts) add('courtyard', part, '围合院子');
  for (const w of walks) add('pedestrian', w, walks.length > 1 ? '院内步道（主 + 横）' : '院内主步道');
  add('amenity', amenityS, '会客/活动场地');
  for (const p of foreParts) {
    if (surfaceArea(p) < U(1) * U(1)) continue;
    add('entrance_forecourt', p, variant.front ? '入口广场（门洞内）' : '入口广场（院子朝街一段）');
  }
  notes.push(
    `院内步道 ${walks.length} 条（主 5 m${crossOk ? ' + 横 4 m' : ''}），草坪 ${courtParts.length} 块`
  );
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
  // **停车方式**：住宅区建得满就走地库，地面让给绿地和院子。
  //
  // 原来每个地块都铺一块地面停车，整座城看过去到处是停车场。
  // 真实的多层住宅区：房子盖到 30% 以上时，地面已经没有完整车场的尺寸，
  // 停车进地下，地面全是院子和绿化。
  const parkMode = chooseParkingMode({
    lotM2: surfaceArea(ctx.parcel) * 49,
    bldM2: buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0) * 49,
    typology: 'multi_family',
  });
  if (parkMode === 'surface') {
    add('parking', park, variant.rear ? '后侧停车（rear bar 让位）' : '侧向停车（后侧无 bar）');
  } else if (park) {
    // 地库 / 路侧：地面这块让给绿地
    add('landscape', park, parkMode === 'underground' ? '地下车库（地面为绿地）' : '路侧停车（地块内不设车场）');
    notes.push(parkMode === 'underground' ? 'PARKING_UNDERGROUND：地面不设停车场' : 'PARKING_STREET：停车在路侧');
  }

  // ---- ⑦ 服务：后侧一条窄带，避开停车
  add('service', cut(u0 + W * 0.66, u1 - W * 0.04, v1 - Math.min(U(6), rearD * 0.5), v1), '垃圾/后勤');

  // ---- ⑧ 残地：全部认领
  claimResidual(ctx, 'multi_family', [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)], add);

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
  if (park && parkMode === 'surface') {
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
