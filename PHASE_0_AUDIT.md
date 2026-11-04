# PHASE 0 · 代码审查与基线冻结

> 场景：`seed 682063530` / `nPatches 15` / plaza on。所有数字只属于这个场景。
> 城内外 Block 44 个，Planner 覆盖 47，Legacy 5，全城规划 1213 ms。

---

## 1. 实际调用关系（哪些能直接复用）

| 层 | 模块 | 现状 | 结论 |
|---|---|---|---|
| 城市意图 | `town/model.ts` + `params` | 种子 → 张量场 → patch | **复用**，M1 只在它下游加派生数据 |
| 用地分配 | `town/landuse.ts::planLandUse` | 半径分位数三档 + 临街等级 + 固定比例 | **要改**（M1 的落点之一，见 §3-6） |
| 路网 | `road/system.ts`（buildRoadNet / roadSurfaces） | 边/路口/条带/圆角/标线 | **复用**。Phase G 只动圆角与接缝，不动拓扑 |
| 街区/地块 | `town/patch.ts`、`planning/adapters/model.ts::parcelOf` | patch → parcel（按边退线内缩）→ buildable | **复用**（已验：parcel 是合法闭合多边形，无处越界） |
| 规划路由 | `planning/core/context.ts::typologyOfUse` | use → typology（9 类） | **复用**，M1 只需给 typology 之外再加一层"形态场" |
| 生成器 | `planning/generators.ts::generateCandidates` | 生成 → 矩形化 → 补量 → 残地认领 → 诊断 | **复用**；M3 在 archetype 内改高度/数量来源 |
| Archetype | `archetypes/{industrial,retail,multifamily,hotel,datacenter,singlefamily,green,park,civic}` | 9 套语法 | **复用 + 局部改**（§3 的硬编码表） |
| 评价 | `core/evaluator.ts` + `typologies/*.ts` | 15 项权重 + 各 typology 覆盖 | **复用**；M4 增加"容积率偏差/覆盖率/数量合理性"三项 |
| 落地 | `realize/*` | Candidate → SceneIR（ownership / 停车 / 场景） | **复用** |
| 审计 | `diagnostics/geometry-audit.ts` | A/B/C/O + 精确重叠 | **复用**，Phase E 的回归基线 |
| 缓存 | 无 | 每次 `buildScene` 全量重算 | **缺**，Phase E 从 M1 起就得设计 |

---

## 2. 基线数据（冻结）

### 2.1 按用途

| use | 块数 | 建筑数 | 平均栋数 | 覆盖率 | 估算 FAR | 最高 m | 平均最高 m |
|---|---|---|---|---|---|---|---|
| residential | 16 | 141 | 8.81 | 15.2% | **0.93** | 24 | 21 |
| industrial | 2 | 19 | 9.50 | 23.5% | 0.71 | 9 | 9 |
| commercial | 14 | 91 | 6.50 | 14.4% | 0.34 | 9 | 9 |
| cbd | 5 | 27 | 5.40 | 12.7% | **0.67** | 54 | 44 |
| civic | 2 | 2 | 1.00 | 10.3% | 0.49 | 15 | 15 |
| green/park | 9 | 0 | — | — | — | — | — |

体块合计 **280 个**，有建筑的 block **39 个**。

### 2.2 强度梯度（半径归一化分档）—— **梯度是反的**

| 分档 | 块数 | 平均栋数 | 平均 FAR | 平均最高 m |
|---|---|---|---|---|
| 内 0~0.33 | 6 | 4.83 | **0.55** | 32 |
| 中 0.33~0.66 | 18 | 7.06 | **0.48** | 14 |
| 外 0.66~1 | 15 | 8.27 | **0.90** | 18 |

**外围 FAR 0.90 > 中心 0.55。** 原因：外围是住宅（14~16 栋 5~7 层板楼），中心是 CBD（5 栋小楼 + 1 栋塔）。这正是用户说的"缺少 CBD 到郊区的梯度"。

### 2.3 高度分布 —— **24~36 m 完全空缺**

| 区间 | 数量 | 占比 |
|---|---|---|
| 0~12 m | 134 | 47.9% |
| 12~24 m | 141 | 50.4% |
| **24~36 m** | **0** | **0.0%** |
| 36~60 m | 5 | 1.8% |
| 60 m+ | 0 | 0.0% |

城市只有"低层 + 5 栋塔"，中间层完全没有。中国现代城市最常见的 30~80 m 住宅/办公群一个都没有。

### 2.4 栋数分布

| 栋数 | 块数 | 占比 |
|---|---|---|
| 1 | 2 | 5.1% |
| 3 | 3 | 7.7% |
| 5 | 3 | 7.7% |
| **6** | **12** | **30.8%** |
| 7 | 4 | 10.3% |
| 8 | 5 | 12.8% |
| 9 | 5 | 12.8% |
| 12~16 | 5 | 12.8% |

不是"永远三栋"，但**栋数完全由 archetype 的排布节奏决定**（零售一排 6~8 个 7 m 盒子、住宅 6 行板楼），与地块面积/目标强度无关。

### 2.5 最大地块的表现

```
-355:-114  commercial  24569m²   8 栋  覆盖12%  FAR0.30  高 9/7/7/7/9/9/7/9
-230:572   residential 23130m²  14 栋  覆盖18%  FAR1.17  高 21/21/21/15/18/18/18/18/18/21/21/21/15/18
-469:284   residential 22391m²  16 栋  覆盖19%  FAR1.15  高 21/15/18/21/21/15/18/21/21/18/21/21/15/15/15/15
176:176    cbd         22251m²   5 栋  覆盖13%  FAR0.95  高 8/8/8/54/9
```

2.2~2.5 ha 的 CBD 地块只有 5 栋、覆盖 13%、FAR 0.95；2.2 ha 的住宅只有一排 18 m 板楼。**大型地块没有第二次切分**。

---

## 3. 固定模式的确切位置

| # | 现象 | 位置 | 代码 |
|---|---|---|---|
| 1 | **住宅高度只有三个值**，且永远"临街高、后侧矮" | `archetypes/multifamily/courtyard.ts:325-327` | `hFront = U(21); hSide = U(18); hRear = U(15);` |
| 2 | **塔楼高度只看地块面积**，与区位无关 | `archetypes/retail/strip.ts:201` | `towerH = lotM > 12000 ? U(54) : lotM > 7000 ? U(42) : U(30)` |
| 3 | **工业厂房固定 9 m** | `archetypes/industrial/rear-load.ts:257` | `height: U(9)` |
| 4 | 补量建筑高度按 typology 固定 | `generators.ts::INFILL_H` | 每类一个常数 |
| 5 | **用地只看"到原点半径分位数"**，无多中心、无商业走廊 | `town/landuse.ts:62-90` | `rank = i/(n-1)`，三档比例写死 |
| 6 | 外围 18% 概率工业、否则绿地 | `town/landuse.ts:72` | `Rng.bool(0.18) ? 'industrial' : 'green'` |
| 7 | 大型地块只调用一次单组团生成器 | `generators.ts::generateCandidates` | 无"二次切分 → 多组团"这一步 |

**这 7 条就是"M1+M2+M3"的全部落点。** 不需要重写任何生成器，都是在既有出口前/后插一层。

---

## 4. 可复用能力（明确不重做）

- `SiteContext`（parcel / buildable / frontages / access 候选 / 邻接）
- `PlanSurface` + `surface{Union,Subtract,Intersect,Inset,Offset}` + holes
- `riddle` 矩形化 `rectsInArea` / `asRects`、`chamferCorners`
- `ribbon()` / `clipTo()` / `minusAll()` / `siteFrame()`
- `evaluateLayout` + `weightsFor` + 各 typology 的 `diagnostics`
- `resolveGroundOwnership` / `realizeSitePlan` / `realizeParking`
- `parking.solveParking`（不动）
- `diagnostics/geometry-audit.ts`（A/B/C/O + 精确重叠，作为每阶段的回归闸门）
- `test/*` 13 个脚本、`tmp/golden.ts`（11 个 Golden Case）

**明确不碰**：Road Graph 数据结构与拓扑、Planner Core 契约、停车求解器、编辑器 UI。

---

## 5. 开发顺序与交付闸门

| 阶段 | 内容 | 闸门（必须通过才进下一阶段） |
|---|---|---|
| **G** | 圆角 / 内侧圆角 / 路面-绿地接缝 | 接缝零缺口（精确求交 0 m²）+ `gen/layers/snapshot` 绿 |
| **M1** | `UrbanMorphology` 场（centrality / FAR / coverage / height band / zone） | FAR 梯度单调（内 > 中 > 外）+ 24~36 m 有空档 → 有楼 + 三张热力图 |
| **M2** | 大地块二次切分 → 多组团 | 2 ha+ 地块 ≥2 组团比例、无狭长残地、组团全部可建 |
| **M3** | 栋数/高度由 FAR+形态场反推 | 高度分布无空档、同类型地块栋数方差显著、无"固定三栋" |
| **M4** | 跨层评价 + 有限候选回退 | 目标 FAR 偏差 < 阈值、覆盖率合法、无碰撞 |
| **E** | 缓存 / 局部更新 / 性能 | 全城 ≤ 基线 1.2 倍、2D↔3D 不重算 |

**M1 的派生数据从第一天就用稳定 ID（`patchKey`）缓存** —— Phase D 已经证明候选名不能当场地标识。

---

## 6. 本轮先做哪一步

用户要求"先执行 Phase 0，输出…再按阶段实施"。Phase 0 到此为止，结论：

1. 问题不在"随机数不够"，而在 **7 处写死的常量与缺失的一层派生数据**。
2. 最省力、收益最大的是 **M1**：一个 `UrbanMorphology` 场，不改任何生成器就能让 CBD/外围的
   强度、高度带、覆盖率有梯度；随后 M3 让 archetype *读* 这个场，替换 §3 表里的常量。
3. **M2 是唯一需要新代码的**（二次切分 + 多组团候选），但可以完全复用现有 `siteFrame` +
   `minusAll` + `rectsInArea`，并且只对 ≥ 8000 m² 的地块触发。
