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

## 8. 这一步**没有**做的事（留给 R8 Visual Review）

- **palette 统一**：Planner 的建筑现在是默认的素白大盒，材质层次（墙/屋面/裙房）没做；
- **缺树**：legacy 地块有行道树，Planner 接管的地块没有（`props` 只有开口和车位）；
- **院子材质**：`stonePave` 的大院子在 2D 里是一大片浅灰，缺少草地 / 水景的层次；
- **停车线 / curb / sidewalk 层级**：2D 还看不出立体关系；
- **3D 高度层次**：6 层板楼和 1 层大盒在 3D 里区分度不够；
- **轮廓层级 L0/L1/L2**：未做。

这些都属于"看起来像不像专业方案"，不影响"跑的是不是 Planner"这条判定 ——
所以按用户的排序，**先接链路，再做视觉**。
