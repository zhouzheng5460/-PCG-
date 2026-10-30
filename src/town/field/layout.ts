// 张量场切块：把"场 → 流线 → 平面图 → 面"这条链组装成下游认识的 Patch[]。
//
// 这一步替换掉"随机撒点 / 正交格网"，让街区形态由场的组合决定：
//   全局基准方向（grid）  —— 保证城市有一个主朝向
//   边界切向（boundary）  —— 靠近轮廓时街道顺着轮廓弯过去
//   中心旋涡 / 放射（vortex|radial） —— 中心区街道绕起来
//   用户禁建区轮廓（path）—— 界线附近的肌理"轻微"顺形，权重刻意压低（见下方注释）
//
// 场只决定"线怎么走"。线本身还要经过平面图求交、切面，才成为街区；
// 每条线按生成顺序领一个道路等级，于是主干道自然均匀分布，而不是随机撒。

import { Pt } from '../../core/geom';
import { Rng } from '../../core/rng';
import { Polygon } from '../../core/polygon';
import { type EdgeClass, lineClassOf } from '../edgeclass';
import { makeFootprint } from '../footprint';
import { Patch } from '../patch';
import { area, ccw, pointInPolygon, subtract } from '../zones';
import type { GridLayout } from '../grid';
import { buildArrangement } from './arrangement';
import { ZoneDeflector } from './deflect';
import { ZoneObstacles } from './obstacle';
import { type FieldLine, traceFamily } from './streamline';
import { type FieldSource, TensorField } from './tensor';

export interface TensorLayoutOptions {
  radius: number;
  /** 目标线距 ≈ 街区尺度 */
  spacing: number;
  /** 每隔几条主线出一条主干道 */
  arterialEvery?: number;
  /** 禁建区轮廓：作为 path 场源参与方向合成 */
  zones?: Pt[][];
  /**
   * 禁建区避障（默认开）。开 = 禁区只当**几何障碍**：街网不跟它对齐，
   * 只是从旁边绕过去，留一段让距；关 = 退回旧做法（把禁区边延长成方向源，
   * 街网被掰成与禁区平行、一路铺到禁区红线上）。
   */
  zoneAvoid?: boolean;
  /** 避障让距（世界单位）：路网到禁区轮廓的最小距离 */
  zoneAvoidPad?: number;
  /**
   * 禁区**弧线**绕障（实验，默认关）。
   *
   * 关（默认）：路到禁区跟前就直着让开（剪段 + 贴边点推到让距线上）。
   * 开：叠加"势流绕障"偏转，流线弯着绕过去。见 field/deflect.ts。
   */
  zoneAvoidBend?: boolean;
  /** 0~1：越大中心场源越强、街区越"绕" */
  warp?: number;
  /** 每族最多追多少条流线 */
  maxLines?: number;
  /** 外部追加的场源（用户画的"方向控制"线、主体建筑朝向等） */
  sources?: FieldSource[];
}

/**
 * 按"这是第几条街"给流线定级。
 *
 * order 是种子入队顺序（打乱过），拿它分级等于随机贴标签 —— 城市会变成
 * "宽路到处零散地出现"，而不是"每隔几个街区一条主干道"。
 *
 * 正确做法：族内的线本来就大致平行，把它们的形心投影到族法向上排序，
 * 排名就是"第几条街"。再按 lineClassOf 的取模规则分级，
 * 于是每个方向都会得到间距均匀的主干道 / 次干道 / 支路。
 */
function classifyFamily(lines: FieldLine[], kArt: number): void {
  if (lines.length === 0) return;

  // 族主方向：首尾方向按双角平均（θ 与 θ+π 等价）
  let sc = 0;
  let ss = 0;
  for (const l of lines) {
    const p = l.pts[0];
    const q = l.pts[l.pts.length - 1];
    const ang = Math.atan2(q.y - p.y, q.x - p.x);
    sc += Math.cos(2 * ang);
    ss += Math.sin(2 * ang);
  }
  if (Math.abs(sc) + Math.abs(ss) < 1e-9) return;
  const ang = 0.5 * Math.atan2(ss, sc);
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);

  const ranked = lines.map((l) => {
    let cx = 0;
    let cy = 0;
    for (const p of l.pts) {
      cx += p.x;
      cy += p.y;
    }
    return { l, k: (cx / l.pts.length) * nx + (cy / l.pts.length) * ny };
  });
  ranked.sort((a, b) => a.k - b.k);

  // 按**长度分位**切 6 : 3 : 1，而不是按条数取模。
  //
  // 取模的两个死结：
  //   ① 一条街的长度在城市里是"离中心多近"的代理，可它同时被边界裁短 ——
  //      rank 按位置排，主干格位会落到既短又靠边的线上，实测六车道只占 5~7%；
  //   ② 族内只有十几条线，一格 mod 10 就是 5~10 个百分点的颗粒度，
  //      换一颗种子比例就跳，压根稳不住。
  // 直接按长度累计切就精确了：最长的 10% 长度给六车道主干（自然落在穿中心的那几条），
  // 中间 70% 给四车道次干，最靠边、被裁得最短的 20% 给两车道支路。
  // 顺带得到一个真实的密度梯度：市中心宽、外围窄。
  const lenOf = (l: FieldLine) => {
    let acc = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) acc += Pt.distance(l.pts[i], l.pts[i + 1]);
    return acc;
  };
  const lens = ranked.map(({ l }) => lenOf(l));
  const total = lens.reduce((x, y) => x + y, 0);
  if (total < 1e-6) return;

  const byLen = ranked.map((_, i) => i).sort((i, j) => lens[j] - lens[i]);
  // kArt = 10 → 主干 9%、支路 21%（主干给 9 是因为 smoothRoadClass 的链投票会小幅上推，
  // 支路多给 1% 是因为 subdivideLargePatches 切的边全记支路、又贡献了约 10 个百分点）。
  // 实测落到 10% / 60% / 30%，正好是 6 : 3 : 1。
  const shareArt = 0.9 / Math.max(4, kArt);
  const shareLocal = 2.1 / Math.max(4, kArt);
  let acc = 0;
  for (const i of byLen) {
    const f = acc / total;
    ranked[i].l.cls = f < shareArt ? 'arterial' : f >= 1 - shareLocal ? 'local' : 'collector';
    acc += lens[i];
  }
}

/**
 * 两个方向之间的夹角，按**直线**折叠到 [0, π/2]。
 *
 * 街道方向是无向的：0° 和 180° 是同一条街，也就意味着"某条边与主轴平行"和
 * "与主轴的垂直方向平行"在本布局里是**等价**的 —— 张量场的次方向就是主轴 +90°，
 * 两个族都会出流线。所以这里折到 90°，而不是 180°。
 */
function angGap(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * 禁建区轮廓的主方向（0~π/2），没有主方向就返回 null。
 *
 * 用 4θ 折叠的圆平均：θ 与 θ+90° 在这里是同一个方向，所以一条矩形轮廓的四条边
 * 会全部叠到同一个角度上，而不是两两抵消。边长加权 —— 一条 40 m 的长边和一条
 * 3 m 的碎边对"这块地朝哪"的发言权不该一样。
 *
 * 返回值同时带一个集中度 k = |Σ| / ΣL ∈ [0,1]：
 * k 高 = 多边形（矩形 / L 形），有明确性格；k 低 = 圆、椭圆、随手画的团，
 * 压根没有"朝哪"这回事，硬给它指定一个主方向只会把街区切得更碎。
 */
function zoneAxisOf(zones: Pt[][]): number | null {
  let sc = 0;
  let ss = 0;
  let tw = 0;
  for (const ring of zones) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const t = Math.atan2(dy, dx) * 4;
      sc += Math.cos(t) * L;
      ss += Math.sin(t) * L;
      tw += L;
    }
  }
  if (tw < 1e-6) return null;
  if (Math.hypot(sc, ss) / tw < 0.3) return null;
  return 0.25 * Math.atan2(ss, sc);
}

/**
 * 禁建区的边 → **延长线**型方向场源。
 *
 * 这是把"禁区边"从障碍物变成网格线的关键一步。原来用的是闭合环的**切向**：
 * 街道贴着轮廓弯，拐角处切向急转，流线跟着急转 → 缺口两侧的街道端头横向错开，
 * 斜着扎进禁区，路口糊成一片。
 *
 * 改成"每条边延长成一条长直线"以后，禁区附近的方向场是**恒定**的（平行于那条
 * 边），街道笔直地铺过去，禁区边界只是这些平行线里的一条 —— 路口不再有斜交。
 *
 * 三条过滤，都是为了让场源数量和力气花在刀刃上：
 *   · 比主轴（或主轴 +90°）平行的边不单列 —— 全局 grid 已经把它们管住了，
 *     再挂一条同向的源只会让这一带的权重虚高、把中心场源压没；
 *   · 同方向的边只留最长的一条（矩形四条边只出两条）；
 *   · 短于 0.25 个等效半径的碎边不算方向（用户手绘轮廓常常带一堆碎点）。
 */
function zoneEdgeLines(ring: Pt[], zi: number, eq: number, axis: number): FieldSource[] {
  const segs: { a: Pt; b: Pt; len: number; ang: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Pt.distance(a, b);
    if (len < eq * 0.25) continue;
    segs.push({ a, b, len, ang: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  segs.sort((p, q) => q.len - p.len);
  const longest = segs[0]?.len ?? 1;

  const out: FieldSource[] = [];
  const kept: number[] = [];
  for (const s of segs) {
    // 这个方向已经有源了（差 < 12°），或者它就是主轴本身
    if (kept.some((k) => angGap(s.ang, k) < 0.21)) continue;
    kept.push(s.ang);
    if (angGap(s.ang, axis) < 0.21) continue;
    if (out.length >= 4) continue;

    const d = new Pt(Math.cos(s.ang), Math.sin(s.ang));
    // 延长到 2.6 个等效半径：够盖住"禁区周边一两圈街区"，又不会把半个城带歪
    const ext = eq * 2.6;
    // **长边权重 > 短边权重**，这一条不是调参，是张量场的代数要求：
    // 矩形的长边方向 A 和短边方向 B 相差 90°，投影到 2θ 空间里恰好**反向** ——
    // (2B = 2A + 180°)，cos2B = −cos2A。两者同权时它们不是叠加，是**互相抵消**，
    // 净方向只剩全局 grid 那一份 0.9，一致性掉到 0.3 以下：方向不可信 → 流线
    // 走到禁区边上开始乱拐，看起来就是"主路非要拐进去"。按边长给权重，
    // A 立刻拿回主导权（A:B ≈ 3:1），场在禁区边上重新变"硬"，街道笔直过去。
    const rel = s.len / longest;
    const strength = Math.max(0.4, 1.5 * Math.pow(rel, 1.6));
    out.push({
      id: `zone${zi}_edge${out.length}`,
      type: 'path',
      path: [new Pt(s.a.x - d.x * ext, s.a.y - d.y * ext), new Pt(s.b.x + d.x * ext, s.b.y + d.y * ext)],
      // 半径 0.9eq 是量出来的：再宽（1.3~1.6eq）反而更差 —— 场把远处的街区也
      // 提前掰成平行，等流线真正走到边界时已经带着一段弧度，入射角照样是斜的。
      // 窄而强（0.9eq × 1.5）只在紧贴边界的一圈里说话，街道是"到了边上才发现
      // 这里有堵墙"，于是它本来就平行 —— 实测斜插率 15% → 8%。
      radius: eq * 0.9,
      strength,
      falloff: 1.4,
      // 只在轮廓外侧生效（内侧反正要被切掉）；fade 收到 0.15 单位（≈1 m），
      // 几乎就是硬切 —— 街道必须在贴着禁区的那一米就已经平行，不能等到 7 m 外才转正。
      only: 'outside',
      fade: 0.15,
      mask: ring,
    });
  }
  return out;
}

export interface FieldLinesResult {
  /** 组装好的场（调试 / 取方向用） */
  field: TensorField;
  major: FieldLine[];
  minor: FieldLine[];
  /** 两族合并、已定级的线 */
  lines: { pts: Pt[]; cls: EdgeClass }[];
  footprint: Pt[];
  /** 全局主朝向 */
  axis: Pt;
  radius: number;
  obstacles?: ZoneObstacles;
}

/**
 * 建场 + 追线（**不含**平面图切块）。
 *
 * 单独抽出来，是为了让"只看流线"的诊断脚本（tmp/flow-view.ts）和主链路
 * 共用**同一份**场配置 —— 否则调参时看到的线和真正建城时的线是两回事，
 * 而禁区避障恰恰是个只能靠"看线"来调的功能。
 */
export function buildFieldLines(opts: TensorLayoutOptions): FieldLinesResult {
  const R = Math.max(20, opts.radius);
  const S = Math.max(4, opts.spacing);
  // 10 = 6/3/1 的断面配比循环（见 edgeclass.lineClassOf）
  const kArt = Math.max(4, Math.round(opts.arterialEvery ?? 10));
  const warp = opts.warp ?? 0.6;

  const footprint = makeFootprint(R);

  // ---------------- 场源
  // 配比原则：全局基准必须占主导，否则次方向会全部收敛到中心点（退化成放射城市）；
  // 边界和局部扰动只负责"把街道带弯"，不负责定调。
  //
  // 主朝向：**有禁建区就锁到禁区的边**。
  //
  // 用户原本的想法是"建了禁区就把默认的 grid / edge 两条线删掉，全交给禁区的边"。
  // 那样确实能让禁区说了算，但城郊四分之三个城市会**失去全局基准** ——
  // 只剩中心场源和禁区近旁的几条延长线，远离禁区的街区会在两条流线之间随机
  // 漂，出现"一块地朝东、隔壁朝北"的碎肌理。
  //
  // 所以不是删掉基准，是**把基准的朝向改成禁区的朝向**：
  // 全城仍有一个统一主朝向（street spacing / 主干道分布都还成立），而这个朝向
  // 恰好和禁区平行 —— 禁区不再是一个"别的方向的东西"，它本来就是这座城市
  // 网格的一段，只是形状被固定住了。这才是"自然融合"。
  const zoneAng = zoneAxisOf(opts.zones ?? []);
  const ang = zoneAng === null ? Rng.float() * Math.PI * 0.5 : zoneAng;

  const sources: FieldSource[] = [
    // 全局基准：给整城一个主朝向
    {
      id: 'grid',
      type: 'grid',
      direction: new Pt(Math.cos(ang), Math.sin(ang)),
      radius: R,
      strength: 0.9,
    },
    // 边界：越靠近轮廓，方向越顺着轮廓切线 —— 这是"街区顺着地块边界弯过去"的来源
    { id: 'edge', type: 'boundary', radius: R * 0.3, strength: 1.0, falloff: 1.6 },
  ];

  // 中心：只影响中心一小片（半径 0.34R），用来做一个局部旋涡 / 放射核心，
  // 强度必须低于基准，否则整城会被它带成"环 + 辐条"
  const centerKind = Rng.bool() ? 'vortex' : 'radial';
  sources.push({
    id: 'core',
    type: centerKind,
    position: new Pt(0, 0),
    radius: R * 0.34,
    strength: 0.18 + 0.3 * warp,
    falloff: 2.2,
  });

  // 禁建区：轮廓怎么参与方向合成，取决于它的"形状性格"。
  //
  // 多边形（矩形 / L 形 / 用户画的四边形）有明确的主方向：把每条边延长成一条
  // 长直线，街道就顺着边一路铺出去，禁区边界从"一堵横在路上、谁都不肯让的墙"
  // 变成"网格里本来就有的一条线"。
  //
  // 圆润轮廓（圆、椭圆、随手画的团）没有主方向，边延长线会退化成四条互不相干
  // 的直线，反而更乱；那种情况下"顺着轮廓切向弯过去"才是对的。
  //
  // 旧实现对**所有**轮廓都用切向 `path` 源。切向的致命处在于：轮廓是一个闭合
  // 环，切向在拐角处会急转，流线积分过去就是"贴着边急转"，于是缺口两侧残留的
  // 街道端头横向错开，看图像路口错了位，斜交路口糊成一片楔形沥青。
  // （那一版的实测表记在这里，供回退参考：
  //   strength  radius  入射角<30°  急角路口(<50°)
  //   0.30      2.5eq   13%         2.5%
  //   0.75      0.9eq   11%         2.5%   ← 窄带
  //   0.75      2.5eq    4%         2.1%   ← 上面那版
  // ）
  // 禁建区：两种截然不同的处理方式，由 zoneAvoid 选。
  //
  // · avoid（默认）：禁区**不参与方向合成**，只当几何障碍。街网该朝哪还是朝哪，
  //   穿过禁区的那几段流线在追踪阶段被换成绕行的弧（field/obstacle.ts）。
  //   这样路不进门、不贴边、也没有被布尔切出来的断头。
  //
  // · extend（旧）：把每条边延长成一条长直线，街网被掰成与禁区平行。
  //   它能让禁区看起来像"网格里本来就有的一条线"，但代价是路一路铺到禁区红线上，
  //   转角处等级还跳变 —— 就是用户说的"路硬怼在禁区上"。保留它只为对照。
  // 避障模式下禁区**不参与**定调（不加 grid / 边延长线那类平行场源）。
  // 它只做两件事：
  //   · deflect —— 在积分方向上加一个无散度的偶极子扰动，让流线像水绕石头
  //     一样自己弯过去（field/deflect.ts）。这是"自然避开"的主力。
  //   · obstacles —— 兜底。万一偏转没兜住（正交入射的那一条会卡在驻点），
  //     进禁区的段直接剪掉；贴边不足让距的点推到让距线上。
  //
  // 试过但**不行**的做法，留个记号免得再走：给禁区挂一条窄的切向 path 源。
  // 长边的切向与全局主朝向同向 → 场没有转的动力；短边的切向与主朝向垂直 →
  // 2θ 空间里反向抵消 → 方向直接翻 90°。两条路都出不来"顺着弯"。
  const zoneAvoid = opts.zoneAvoid !== false;
  const padU = Math.max(0, opts.zoneAvoidPad ?? 0);
  const hasZone = (opts.zones?.length ?? 0) > 0;
  const obstacles = zoneAvoid && hasZone ? new ZoneObstacles(opts.zones ?? [], padU) : undefined;
  // 弧线绕障是**实验开关**，默认关：默认行为是"路到禁区跟前直着让开"。
  // 打开后流线会绕着禁区弯过去（见 field/deflect.ts），好看一段弧度，
  // 但长条禁区两端会挤出两条贴得很近的平行街 —— 用户实测觉得"有点奇怪"。
  const deflector =
    zoneAvoid && hasZone && opts.zoneAvoidBend === true
      ? new ZoneDeflector(opts.zones ?? [], padU)
      : undefined;

  if (!zoneAvoid) {
    (opts.zones ?? []).forEach((ring, i) => {
      if (ring.length < 3) return;
      const eq = Math.max(2, Math.sqrt(Math.abs(area(ring)) / Math.PI));
      if (zoneAng !== null) {
        sources.push(...zoneEdgeLines(ring, i, eq, zoneAng));
        return;
      }
      sources.push({
        id: `zone${i}`,
        type: 'path',
        path: ring,
        radius: eq * 2.5,
        strength: 0.75,
        falloff: 1.2,
        only: 'outside',
        fade: 1,
      });
    });
  }

  const field = new TensorField(sources.concat(opts.sources ?? []), footprint);
  const inside = (p: Pt) => pointInPolygon(p, footprint);

  const minX = Math.min(...footprint.map((p) => p.x));
  const maxX = Math.max(...footprint.map((p) => p.x));
  const minY = Math.min(...footprint.map((p) => p.y));
  const maxY = Math.max(...footprint.map((p) => p.y));
  const bounds = { minX, maxX, minY, maxY };

  const maxLines = opts.maxLines ?? 96;
  const maxLength = R * 2.4;

  // ---------------- 两组流线
  // 等级先给个占位，追完再按"空间位置"重新分级（见 classifyFamily）。
  // 注意不能按 order 分级：种子是打乱后入队的，order 等于随机顺序，
  // 那样分出来的是"随机哪条宽"，而不是"每隔几个街区一条宽路"。
  const major = traceFamily(field, 'major', {
    spacing: S,
    inside,
    bounds,
    maxLines,
    maxLength,
    classFor: () => 'local',
    obstacles,
    deflector,
  });
  const minor = traceFamily(field, 'minor', {
    spacing: S,
    inside,
    bounds,
    maxLines,
    maxLength,
    classFor: () => 'local',
    obstacles,
    deflector,
  });

  // 两族都要有主干道 —— 现实中街网就是"两个方向各每隔几个街区一条主干道"。
  // 之前只让 major 族领主干道，minor 族最高只能到次干道，
  // 于是城市看上去"只有竖向有宽路、横向几乎全是窄路"。
  classifyFamily(major, kArt);
  classifyFamily(minor, kArt);

  const lines = major.concat(minor).map((l) => ({ pts: l.pts, cls: l.cls }));

  return {
    field,
    major,
    minor,
    lines,
    footprint,
    axis: new Pt(Math.cos(ang), Math.sin(ang)),
    radius: R,
    obstacles,
  };
}

export function buildTensorLayout(opts: TensorLayoutOptions): GridLayout {
  const fl = buildFieldLines(opts);
  const R = fl.radius;
  const S = Math.max(4, opts.spacing);

  // ---------------- 平面图 → 面
  const arr = buildArrangement(fl.lines, fl.footprint, {
    minArea: S * S * 0.1,
    maxArea: S * S * 12,
    // 线头差一块砖没接上就会留下悬挂节点，路网跟着断。吸附半径取 1/4 街区尺度。
    snapTol: S * 0.25,
  });

  if (arr.faces.length < 6) {
    throw new Error(`张量场切块失败：只切出 ${arr.faces.length} 个街区`);
  }

  const footprint = fl.footprint;

  // ---------------- 面 → 地块
  const patches: Patch[] = [];
  for (const f of arr.faces) {
    const patch = new Patch([]);
    patch.shape = new Polygon(f.ring);
    patches.push(patch);
  }

  // ---------------- 补洞
  // 平面图偶尔会漏掉一个面（顶点处共线退化、半边配对异常等），
  // 俯视图上就是城里一块没内容的空地。用"面的总面积 vs 轮廓面积"判定，
  // 少了就用布尔差补回来，顶点吸附到既有地块的顶点对象上，
  // 这样补出来的地块和邻居共享顶点，路网照样能配对。
  const fpArea = area(footprint);
  let covered = 0;
  for (const p of patches) covered += area(Array.from(p.shape));
  if (covered < fpArea * 0.94) {
    let missing: Pt[][] = [];
    try {
      missing = subtract(footprint, patches.map((p) => Array.from(p.shape)));
    } catch {
      missing = [];
    }
    const vertOf = new Map<string, Pt>();
    for (const p of patches) {
      for (const v of p.shape) vertOf.set(`${Math.round(v.x * 1000)},${Math.round(v.y * 1000)}`, v);
    }
    let filled = 0;
    for (const ring of missing) {
      if (ring.length < 3) continue;
      const a = area(ring);
      // 太大的多半是"轮廓外侧那一圈"，它形心落在城里，靠下面的判定排除
      if (a < S * S * 0.12 || a > fpArea * 0.35) continue;
      let cx = 0;
      let cy = 0;
      for (const v of ring) {
        cx += v.x;
        cy += v.y;
      }
      const centroid = new Pt(cx / ring.length, cy / ring.length);
      // 真洞：形心不在任何已有地块里。外圈那条环的形心在城里，会被排除
      if (!pointInPolygon(centroid, footprint)) continue;
      if (patches.some((p) => pointInPolygon(centroid, Array.from(p.shape)))) continue;

      const snapped = ring.map(
        (v) => vertOf.get(`${Math.round(v.x * 1000)},${Math.round(v.y * 1000)}`) ?? v
      );
      // 真洞的边界全是已有地块的边，顶点必然全部能在既有顶点里找到 ——
      // 必须 100% 命中，否则补出来的地块会有一条边和邻居对不上，
      // 那条路就只剩一侧地块（buildRoadNet 会丢掉它），路网反而被切断。
      let hit = 0;
      for (const v of snapped) if (vertOf.get(`${Math.round(v.x * 1000)},${Math.round(v.y * 1000)}`)) hit++;
      if (hit < snapped.length) continue;

      const patch = new Patch([]);
      patch.shape = new Polygon(ccw(snapped));
      patches.push(patch);
      filled++;
      if (filled >= 16) break;
    }
  }

  let core: Patch | null = null;
  let coreDist = Infinity;
  for (const patch of patches) {
    const ring = Array.from(patch.shape);
    let sx = 0;
    let sy = 0;
    for (const v of ring) {
      sx += v.x;
      sy += v.y;
    }
    const dist = Math.hypot(sx / ring.length, sy / ring.length);
    // 留一圈城郊（绿地/工业），否则城市会一直铺到轮廓边
    patch.withinCity = dist < R * 0.9;
    if (patch.withinCity && dist < coreDist) {
      coreDist = dist;
      core = patch;
    }
  }

  return { patches, edgeClass: arr.edgeClass, radius: R, core, axis: fl.axis };
}
