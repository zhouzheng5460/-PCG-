# R8 · Frontend Product Integration

> 这份文档记录的是**"发动机接到产品上"**这一步：Planner 的完整链路第一次进入
> 你每天实际用的那个前端界面。之后的每一次优化都能立刻在画面上看到。

---

## 1. 前端真实入口在哪

先确认了"按钮最终调用的是谁"，才动手改：

```
index.html
  └─ src/ui/app.ts            ← 主界面（三栏：左显示控制 / 中画布 / 右生成参数）
       ├─ regenerate()         ← "重新生成"按钮
       │    └─ model.generate() （城市本体，不含地块内容）
       └─ view2d / view3d
            └─ src/scene/build.ts :: buildScene(model, opts)   ★ 唯一出口
                 └─ 2D（view2d.ts）/ 3D（view3d.ts → build3d.ts）/ GLB 导出
```

**关键结论**：`buildScene()` 是 2D / 3D / GLB 三者的唯一出口，
而且它的第 3 步"地块内容"正是 legacy 链路（`ModernWard.lot`）。
所以接入点只有一个：`buildScene()` 里换成 Planner 的产物，三条渲染路径自动一起变。

**红线落实**：`realizeSitePlan()` 产出的特征**直接进 Scene**，
被接管的地块不再经过 `ModernWard.lot` 那条 legacy 规划逻辑 ——
测试用**几何归属**（质心落在这块地里）判定"场景里的实体是否全部来自 planner"，
不是靠名字（legacy 的实体名在不同地块之间是重复的，靠名字会误判）。

---

## 2. 三态运行模式

顶栏新增一组切换（`index.html` 的 `.modes`）：

| 模式 | 渲染 | 用途 |
|---|---|---|
| **Legacy** | 全部走 legacy（默认，行为不变） | 基线对比 |
| **Planner** | industrial / multi_family / retail 三类由 Planner 接管，其余仍 legacy | 看真实产出 |
| **Shadow** | 渲染仍是 legacy，Planner 的方案叠成**红色虚线轮廓** | 一眼对比两套 |

URL 参数 `?mode=planner` / `?mode=shadow` 可直接进入（截图 / 手测用）。

### Shadow 模式的语义

主场景 = legacy（一个字节都不改），Planner 的建筑画成红色虚线轮廓、
Planner 的地面画成淡红色虚线。因为不填色，legacy 的实体形态仍然可读，
Planner 的体块像投影一样浮在上面 —— 这是"两套方案并排看"最省事的实现。

---

## 3. Planner Mode 的链路（严格按要求）

```
Parcel
 → siteContextFromModel()      （src/town/planning/adapters/model.ts）
 → generateCandidates()         （src/town/planning/generators.ts，按 typology 路由）
 → selectBestCandidate()        （src/town/shadow/runner.ts，显式选优 + margin）
 → realizeSitePlan()            （src/town/realize，忠实落地）
 → Scene 特征
 → 现有 2D / 3D Renderer
```

`generateCandidates()` 是新抽出来的**共享路由表**（`planning/generators.ts`）——
之前映射表写在 `shadow/runner.ts` 里，前端若照抄一份就会变成两份真相，
Shadow 报的数和前端看到的数会对不上。现在两边共用同一个。

---

## 4. 第一批只接三类

```ts
export const PLANNER_ENABLED_TYPOLOGIES: SiteTypology[] = ['industrial', 'multi_family', 'retail'];
```

Hotel / Data Center / Single-Family **暂时继续 legacy** —— 这三类没有 Shadow 样本、
没有声明强度带，假装校准过就是自欺。HUD 上会明写"暂未接入"。

未接管的地块也在报告里写明原因（"没有可用候选" / "该类型暂未接入"），
不会静默回落。

---

## 5. Planner Debug HUD

左上角浮层（`src/ui/planner-hud.ts`），字段按用户给的规格：

```
Mode: Planner
Typology: Multi-Family
Parcel: -454:-275
Archetype: mf-court-rear-open
Score: 7.31
Margin: 0.33
Intensity: FAR ×6 2.1 / preferred 1.4–2.2 · 带内(优)
体量: 3 栋 · 覆盖 35%
候选 3 个
```

- `Margin` 低于 0.15 时显示**黄色 `⚠ LOW`**（64 个样本里还有 20 个低置信，
  这个信号必须在开发期随时看得见）；
- 强度超出目标带（偏稀 / 偏密）时同样标黄；
- 没选中地块时显示全局摘要（接管 N/M 块 + 按 typology 的分项）。

---

## 6. 前端验收（不是单测，是肉眼）

### 6.1 接线正确性 —— `test/planning-frontend.test.ts`（198 项断言）

| Gate | 结果 |
|---|---|
| 接管地块的实体**全部**来自 planner（几何归属判定） | ✅ |
| 接管地块**没有** legacy 实体混入 | ✅ |
| Shadow 主场景 == legacy | ✅ |
| 三类产出互不相同 | ✅ 工业 6 栋/停车 91u² · 住宅 94 栋/开放 2473u² · 零售 27 栋/停车 1776u² |
| 切 legacy/planner 的几何确实不同 | ✅ legacy 396 栋/1600u² vs planner 182 栋/2692u² |
| 未接入的三类没被接管 | ✅ |

### 6.2 浏览器实测（`tmp/r8-shot.mjs`，无头 Chrome + CDP）

| 截图 | 内容 |
|---|---|
| `out/r8-legacy.png` | Legacy 全城 |
| `out/r8-planner.png` | Planner 全城 —— 住宅变成大板楼围合院子，商业变长条大盒，工业变大仓库 + 前场货场 |
| `out/r8-shadow.png` | Shadow：红色虚线叠在 legacy 实体上 |
| `out/r8-hud-mf/ind/ret/low.png` | 四块地的 HUD（含 LOW 黄色标记） |
| `out/r8-3d-planner.png` / `r8-3d-legacy.png` | 3D 两种模式 |

**肉眼结论**：三种场地规划在 Planner 模式下与 legacy 差异显著（板楼 vs 小楼群、
条形大盒 vs 散铺小店、仓库 + 货场 vs 随意体块）；
切换 legacy/planner 时右下角建筑数从 **396 变成 182**，一眼能确认接线生效。

---

## 7. 顺带修掉的两个工程问题

| 问题 | 原因 | 修法 |
|---|---|---|
| `vite dev` 起不来 | vite 会把项目里**所有** .html 当入口扫依赖，而 `tmp/` 下堆着早期 CDP 调试留下的浏览器用户目录（Edge Wallet / 扩展页面…），里面有大量解析不了的动态 import | 新增 `vite.config.ts`：`optimizeDeps.entries: ['index.html']` |
| 右栏建筑数在 Planner 模式下还是 legacy 的数 | `updateStats()` 读的是 `model.stats()`，而场景已经是 Planner 的了 | 改成读 `view2d.ensureScene().solids.length`（为此把场景构建从 `draw()` 里抽成 `ensureScene()`） |

---

## 8. R8 Visual Review（表现层，已落地）

接线做完之后做视觉复核。**全部是表现层的事，不碰任何规划几何与评分**。

### 8.1 诊断（先量，再改）

| 要素 | legacy | Planner（改进前） | 问题 |
|---|---|---|---|
| 墙体 | concrete 255 / panel 97 / glass 33 | concrete 145 / stone 38 / panel 6 | **wallGlass 归零** —— 全城一个色调 |
| 树 | 3639 | 3035 | Planner 接管的地块**内部一棵树都没有** |
| 院子 | — | stonePave 大片浅灰 | 和屋面 roofLight 几乎同色 → 读成"空地" |
| 建筑厚度 | 小房子自带颗粒感 | 大板楼是一块平色 | 没有厚度线索 |

### 8.2 四项改动

**① 地块内配景（`src/town/realize/scenery.ts`，新增）**

Planner 接管的地块走的是另一条链，`modern.ts` 那套地块内部配景不会跑，
于是院子是空的。补一个 `realizeScenery()`：读 Candidate 已经定好的
Ground Program（courtyard / landscape / amenity / landscape_buffer…），
按程序撒树。仍然是纯转译 —— 不决定"哪儿该有树"（Planner 已经用 program 标出来了），
只把这些 program 翻译成看得见的树。

撒点用「固定网格 + 抖动」，抖动量由 `candidate.id` 的哈希决定 → 确定性。
并且避开**建筑 footprint、车位、货场**（车位上不长树）。

实测：树 3035 → **3291**（+256）、针叶 173 → 330、小树 37 → 134。

**② 建筑外观按 typology 分层（`TYPOLOGY_APPEARANCE`）**

legacy 链里住宅是 `brick / concrete 随机`、板楼是 `concrete / panel 随机`、
塔楼是玻璃幕墙 —— 于是俯视图上**一眼能读出这是住宅区还是商业区**。
Planner 链早期把 `house` 固定成 wallConcrete，全城一个色调（"素白大盒子"）。

现在每个 typology 有一组墙/屋面候选，按建筑序号确定性交替：

| typology | 外观 |
|---|---|
| multi_family | 砖红 / 涂料交替，平屋顶 |
| retail | 玻璃幕墙为主 |
| industrial | 金属面板 / 混凝土 |
| hotel / dc / single_family | （暂未接入，但表已备好） |

实测：wallBrick 0 → 65、wallGlass 0 → 27、roofFlat 0 → 29。

**③ 院子材质：stonePave → 草坪**（第一版用 grassLight，后来在 §10 改成 lawn）

`stonePave`(0.757) 和 `roofLight`(0.615) 在俯视图里几乎同色，
一大片院子读起来像"这块地空着"。换成修剪草坪之后，
院子 / 绿化(grass) / 铺装(paver) 三层一眼分得开。

**④ 2D 建筑加假投影 + 轮廓随体量加重（`view2d.ts`）**

同样是屋顶色，大板楼读起来像"一块铺装"，小房子才像"房子" —— 差的是厚度线索。
沿右下压一层半透明深色，体块立刻立起来。纯表现层，不碰几何。

### 8.3 视觉验收（浏览器实测）

| 截图 | 内容 |
|---|---|
| `out/r8-planner.png` | 全城：院子是绿的、有树、住宅砖红、商业幕墙、工业金属板 |
| `out/r8-close-mf.png` | 住宅地块特写：3 栋 6 层板楼 + 绿院子 + 树 + 停车位线 |
| `out/r8-close-ret.png` | 零售地块特写：店铺 + 顾客停车（车位线）+ 前场 + 后侧服务 |
| `out/r8-close-ind.png` | 工业地块特写 |
| `out/r8-3d-close-mf.png` | 3D 特写：6 层板楼的高度、绿院子、行道树、斑马线 |

### 8.4 防回归（`test/planning-frontend.test.ts` 231 项）

- 绿地型 typology 的地块 ≥80% 有树；
- 树不压建筑、不长在车位里；
- 院子材质必须是 `lawn`（低饱和草坪，见 §10）；
- 建筑外观按 typology 有多种材质（不能全城一个色调）。

### 8.5 这一步**没做**的（属于规划层，按"停止 Calibration"的指令先记着）

| 现象 | 属于哪一层 | 备注 |
|---|---|---|
| 零售地块 40% 是停车、几乎没有绿地 → 没树 | archetype | strip retail 需要一条沿街绿化带 |
| `amenity`（会客场地）是院子正中一块规则矩形 | archetype | 斜边地块上"院子一角"落到了中间 |
| ~~住宅地块 9% 的可建区没被任何 program 认领~~ | — | **已在 §9 修掉**，当时的数据也报错了：实际 MF 0.1% / 工业 20.4% / 零售 9.3% |
| 2D 里的停车位线偏细、curb / sidewalk 层级弱 | Realizer | 车位线已画，但线宽与层级没做 |
| L0/L1/L2 轮廓层级 | 场景层 | 未做 |

这些都会改变 archetype 的产出（进而影响评分与 winner），
所以**没有**在 Visual Review 这一轮里动 —— 等明确排期。


---

## 9. 地面归属与几何可靠性（P0 修复）

这一节记的是 R8 收尾时挖出来的**最严重的一个问题**，它的表象是"视觉脏点"，
根因却在几何内核。

### 9.1 现象：可建区里有一片没有主的地

量"可建区里有多少面积既不在 ground 也不在建筑里"：

| typology | 无主占比（修前） |
|---|---|
| industrial | **20.4%** |
| retail | 9.3% |
| multi_family | 3.6%（另有 3 块整块 100%） |

这些地在 Scene 里没有任何 ground program，2D 上就是一片纸面底色，
读起来像"这块地没规划完"。

### 9.2 根因：布尔运算静默失败 + 残地只认领最大一块

两层问题叠在一起：

**① 残地只认领最大一块。** 六个 archetype 都是这么写的：

```ts
const biggest = rest.reduce((a, b) => surfaceArea(a) >= surfaceArea(b) ? a : b);
if (surfaceArea(biggest) > buildable * 0.01) add('residual', biggest);
```

新月形地块上，剩下的是**两侧两条月牙**，只认领大的那条，小的直接丢掉。

**② 更糟的是 `surfaceSubtract` 会静默返回整块输入。**
polygon-clipping（martinez 实现）在"减数与可建区边界相切 / 顶点几乎重合"时抛

```
Unable to complete output ring starting at [5.94, 6.79]. Last matching segment found ends at [...]
```

而 `surfaceSubtract` 有 `catch { return as }` 的兜底 —— 于是
`subtract(可建区, 已用地)` 返回**整块可建区**，调用方把它标成 `landscape`，
一张 4928 m² 的假"绿地"盖住了整块 4928 m² 的地。**2D 上完全看不出来**，
因为那就是地块底色；只有"无主面积"这个度量能发现。

### 9.3 修法（三层，全在 Core 与 archetype 内，不改契约）

| 层 | 做法 |
|---|---|
| 输入 | 送进布尔运算的坐标**量化到 1e-6 世界单位**（≈7 μm）。martinez 对 1e-15 级差异极脆，量化把它消掉 |
| 退化 | 批量 difference 失败时**降级为逐块减**：每次只面对一个减数。宁可少切（残地偏少），也绝不返回整块（残地 = 整块在视觉上是假满铺） |
| 可观测 | 新增 `geometryFailures` / `resetGeometryFailures()`。`catch` 里计数，测试断言三个计数为 0 —— 兜底不再无声 |

再加 `claimResidual()`（`archetypes/shared/claim.ts`）：**全部残地按面积分档认领**
（≥0.8% 给绿地 program、≥0.15% 给 residual、更小丢弃），六个 archetype 共用。
typology 由 archetype **显式传入**，不从 `ctx.typology` 推导 ——
DC 的测试 fixture 用了 `use: 'industrial'`，靠 ctx 推导会把工业的
`landscape_buffer` 漏进数据中心的白名单校验里。

### 9.4 结果

| 指标 | 修前 | 修后 |
|---|---|---|
| 无主占比 | 5.73% | **0.02%** |
| 布尔静默失败 | union 4 / subtract 3 / intersect 4 | **0 / 0 / 0** |
| 整块无主的地 | 4 块 | **0 块** |
| 有方案的 MF 地块 | 26 | **29**（3 块原本生成失败的地现在成功） |

### 9.5 一次判断失误（记录下来）

中途我以为"建筑在 Planner 模式下还是浅灰、没变深"，连续调了两轮屋顶色。
实际采样截图像素才确认建筑是 `rgb(97,90,78)`、院子是 `rgb(163,176,116)` ——
**颜色早已正确，是缩略图的主观感受骗了自己**。

教训：涉及"颜色够不够对比"这种判断，**采样像素，不要靠看图**。
这也是为什么下面 §10 的配色结论都带具体 rgb。

---

## 10. 地面与建筑的配色层次（可复用的结论）

`palette.ts` 的值是 **sRGB 0~1**，`css()` 直接 `*255`，**不做线性→sRGB 转换**。
（注释里写的是 sRGB，之前有人按线性值估算亮度，估出来的对比度全是错的。）

按亮度排出的可用层次：

| 档 | 材质 | 用途 |
|---|---|---|
| 0.76 | `stonePave` | 入口前场 |
| 0.70 | `paver` | 会客场地、人行 |
| 0.60 | **`lawn`（新增）** | 围合院子的草坪 |
| 0.52 | `gravel` | **工业缓冲带**、残地 |
| 0.40 | `grassDark` | 地块边缘绿化 |
| 0.40 / 0.30 | `roofFlat` / `roofDark` | 住宅屋面 |
| 0.27 | `asphaltLot` | 停车 |

三条改动：

1. **院子用 `lawn`（低饱和浅绿），不用 `grassLight`。**
   院子占围合式住宅地块的 **67%**，饱和草绿铺满之后整座城读起来是
   "公园里散着几栋楼"，不像规划图。专业总图上的草坪是浅而灰的绿。
2. **工业缓冲带用 `gravel` 而不是草。**
   工业地块的 `landscape_buffer` 现在占 23%（全认领之后），给草会把整片工业区染绿；
   真实的工业场地边缘本来就是碎石/杂草。
3. **住宅屋面压到 `roofDark` / `roofFlat`。**
   2D 用 roofMat 填充，所以"屋顶浅"等于"楼是白的" —— 这正是用户说的"素白大盒子"。
   压深之后，浅绿院子上的深灰条 = 楼，figure-ground 才立起来。

### 10.1 遗留：院子内部是空的

院子现在是一整块纯色 + 几棵树，没有**步道连接各栋楼入口**、没有儿童场地分区。
这是 archetype 几何（加 `pedestrian` 分支会改变 `pedestrianClarity` 评分），
按"停止 Planning Calibration"的指令没有动，需要单独排期。
