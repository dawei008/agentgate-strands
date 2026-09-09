# 0011 浮层三分法：表单=右侧抽屉 / 确认=居中卡 / 菜单=浮层

Status: accepted（2026-08）
Extended-by: [0013 长文交付物住在页面上](0013-long-form-lives-on-a-page.md) —— 本条定
「用哪一种浮层」，0013 定**它前面那个问题**：该不该用浮层（判据是内容量）。
本条对表单/确认/菜单的六条硬规则**未被改动**；被改的只有下面 Consequences 第 5 条
里「报告抽屉是浮层」这个前提。

## Context

资源库页原本有三种互不相干的「打开表单」方式：评估器表单是卡片内分块展开、
数据集表单是表格行内展开（`<tr class="-form">` 插在被编辑行下面）、AI 生成
器是页脚下方追加一块。三种呈现共存的代价：

- **上下文丢失**：行内展开把表格撑开甚至顶掉视口，改完不知道自己在编哪一行。
- **交互语言不一致**：同一页里「取消」有时是收起分块、有时是卸载行，Esc 有
  的地方管有的地方不管；改了一半点别处就静默丢失。
- **危险操作零护栏**：删除数据集直接发请求（UI-004），AI 生成流式跑到一半
  点别处就断（结果只随流回传、不落库，断了取不回）。
- **校验规则各家一套**：回归/模拟生成器非法 JSON 时保存按钮禁用，红队生成器
  同样场景按钮仍可点（UI-008）。

## Decision

**浮层只有三类，各自唯一实现，不许再造第四种。**

| 用途 | 呈现 | 实现 |
| --- | --- | --- |
| 表单（新建/编辑/生成） | 右侧抽屉 | `web/src/pages/resources/FormDrawer.tsx`（壳走公共 `components/Drawer.tsx`） |
| 确认（危险/不可逆/丢弃） | 居中卡 | `web/src/components/ConfirmCard.tsx` |
| 菜单（筛选/更多操作） | 浮层 popover | 就地 popover，不升级成抽屉 |

配套六条硬规则：

1. **两档宽度，没有第三档**：普通表单 600、含 JSON 编辑区的宽表单 760
   （`FormDrawer.tsx:13-14` 两个导出常量，`FormDrawer.tsx:66` 二选一）。
   资源库现状：评估器表单 600（`ResourcesPage.tsx:204-230`），数据集/模拟集
   表单与三个生成器都是 760（`DatasetsBlock.tsx:220-262 / 388-430 / 816-834`）。
2. **禁止抽屉叠抽屉**：一个面上同时只有一个抽屉。数据集的「新建」与「编辑」
   共用单例壳，靠 `editingDataset` 是否为空区分模式（`DatasetsBlock.tsx:150-152`）；
   打开抽屉的按钮之间互斥置位（`DatasetsBlock.tsx:186` / `:206`）。
   **此规则有代价，见 Consequences 第 3 条。**
3. **双向锚定**：从表格行打开抽屉时该行高亮（`.row-anchored`，纯 tint + 左侧
   强调条，表格零玻璃纪律不破——`resources.css:8-12`），抽屉头带身份行说明
   在编辑哪个对象（`FormDrawer.tsx:71-77`）；关闭时高亮撤销、焦点还原到触发
   按钮（还原由公共 Drawer 内建：`components/Drawer.tsx:39` 记
   `lastFocus`、`:63` cleanup 里还原）。
4. **脏确认**：有未保存修改时 Esc/mask/关闭按钮都不直接关，先弹丢弃确认
   （`FormDrawer.tsx:51-56` 的 `requestClose`）。脏的判定是表单值对初始值
   浅比较（`useDirty.ts`，初始值 `useRef` 定格——重渲染不重设基线，否则脏
   确认永远不触发）。表单自己的「取消」按钮与 Esc/mask **同刑**：走函数式
   children 拿到的同一个 `requestClose`（`FormDrawer.tsx:45-47` 的契约、
   `:89` 的调用），保存成功才走 `onClose` 硬关不问脏。
5. **进行中锁**：流式生成期间关闭先弹「生成中，确定中断？」，确认才关
   （`FormDrawer.tsx:52`：busy 优先于 dirty 判定）。生成结束进 review 态后
   恢复普通脏确认，但措辞加重成「生成结果还没保存，关闭就会丢失（需重新
   生成）」——因为结果只随流回传、不落库（`DatasetsBlock.tsx:19`
   `GEN_DISCARD_MSG`，经 `FormDrawer` 的 `dirtyMessage` 注入）。
   busy/dirty 都由子表单经 `useEffect` 上报，**不在渲染期调父 setState**
   （`GenCasesForm.tsx:102-111`、`RedteamGenerator.tsx:61-68`）——渲染期
   调父 setState 会触发 React「Cannot update a component while rendering a
   different component」，这是本项目踩过的坑。
6. **确认卡默认焦点在取消**：`initialFocus="cancel"`（`ConfirmCard.tsx:17/28/45`），
   危险操作不给回车顺手确认。抽屉的脏/忙确认（`FormDrawer.tsx:97`）、数据集
   删除（`DatasetsBlock.tsx:748`）、评估器删除（`ResourcesPage.tsx:345`）
   三处共用同一个组件同一档焦点行为。

抽屉化顺带把落在这四个面上的队列项一并解掉（同一改动面，分开做要碰两遍）：

- **UI-003 同名新建静默覆盖**：前端在表单内拦（`DatasetsBlock.tsx:551-580`
  的 `validate`，名字空间取全局 `existingNames`——后端一张表一个 sk，跨 tab
  同名同样冲突），请求在新建模式带 `create_only: true`
  （`DatasetsBlock.tsx:594`）交给后端做第二道闸（`app/catalog.py` 的
  `save_dataset create_only`）。编辑模式两者都不生效，原名保存是正常路径。
- **UI-004 删除无确认**：删除按钮改为先开 ConfirmCard，卡里点名集合名 +
  用例数 + 「不可恢复」+ 引用它的方案会报缺失（`DatasetsBlock.tsx:739-751`）。
- **UI-005 空数组可存**：前端 `validate` 拒空（文案逐字照抄后端
  `数据集至少需要一条用例`），后端同刑。
- **UI-006 校验焦点+ARIA**：错误改为字段级，校验失败聚焦首个出错字段（按
  视觉顺序，`DatasetsBlock.tsx:579`），错误挂 `role="alert"` 并与输入用
  `aria-invalid`/`aria-describedby` 关联，改动该字段即清除其错误。
- **UI-008 红队非法 JSON 保存仍可点**：改为实时判定，与另两个生成器共用
  同一个 `parseCases`（`GenCasesForm.tsx:42-51` 导出，`RedteamGenerator.tsx:59`
  消费），非法或空数组 → 按钮禁用（`RedteamGenerator.tsx:271`）+ 就地提示
  （`RedteamGenerator.tsx:242-256`）。

## Consequences

1. **行内展开只剩「查看」**：表单迁走后 `.res-form-cell`/`.res-form-host`
   两个壳类删除，`resources.css:14-19` 只留红队「查看」的只读详情行。
   `.res-inlineform` 的「凹陷底 + 顶部蓝条」是行内展开的视觉语言，在抽屉里
   要中和掉（`resources.css:137-150`），否则抽屉里套一层假凹陷。
2. **玻璃预算不变**：抽屉壳的 1 层 blur 已在 `base.css .drawer-panel` 白名单里
   （`web/tests/glass-guard.test.ts:57`），本批次零新增 blur——抽屉内的表单
   一律实心底。
3. **「禁止抽屉叠抽屉」逼死了 AI 生成的追加模式老交互**：原来「追加到当前
   数据集」的前提是用户先在上方表格里打开某行的编辑表单，生成器读那个
   `currentDataset`。抽屉化后表格被遮罩挡住，这条路不可达，而开第二个抽屉
   又违反规则 2。**决定：追加目标改为抽屉内下拉**（`GenCasesForm.tsx:290-329`，
   候选是当前侧全部集合，勾选追加时缺省预选第一个）。`extend_dataset` 请求
   字段、名称锁定、合并 `existing_cases`、沿用原 `kind` 的语义全部不变——
   只换了「目标从哪里来」。这是抽屉化对交互的实质改动，不是纯呈现迁移。
4. **测试锚点必须改，断言语义不许改**：表单从「行内 DOM」变成「抽屉内 DOM」，
   等待锚点一律换成抽屉内的终态元素（回填完成的 JSON 文本、生成结果里的第
   二条用例、活性行），不等次数、不等中间态。资源库测试
   `web/tests/resources.test.tsx` 从 42 增到 65，新增覆盖：两档宽度、行锚定
   与焦点还原、脏确认三态、进行中锁三态、review 丢弃卡、UI-003/004/005/006/008。
5. **本 ADR 只约束资源库页**。方案编辑器、报告抽屉等既有浮层已符合三分法
   （都是右侧抽屉 + ConfirmCard），但本批次未改动它们；后续新增浮层按本
   ADR 选型，不再新造第四种呈现。
   🔻 **2026-08-27 更正（[0013](0013-long-form-lives-on-a-page.md)）**：报告
   **已不是浮层** —— 它成了独立页 `#/report/<run_key>`，抽屉壳虽在仓库里但无生产
   入口。本句「已符合三分法」在「它该是浮层」这个前提下为真，而那个前提被 0013
   改掉了（判据换成内容量：超过约一屏的连续长文用页面，不用浮层）。方案编辑器
   那半仍然照本条走。
6. **抽屉必须 portal 到 body，禁止挂进任何带 backdrop-filter/filter/
   transform 的祖先**（线上事故补条）。`.drawer-panel` 是 `position: fixed`
   （`base.css:269-277`），按 CSS 规范，filter/backdrop-filter/transform
   祖先会成为 fixed 后代的 containing block——本站玻璃卡 `.card` 恰好带
   `backdrop-filter`（`ui.css:250-253`）+ `overflow: hidden`，线上实测
   ReportDrawer（调用处在运行历史卡内）被夹扁成一条标题、内容全被裁剪，
   且历史行越少裁得越狠（卡片矮 → containing block 矮）。修法一处覆盖
   全体：公共壳 `components/Drawer.tsx` 用 `createPortal(…, document.body)`
   把 mask+panel 送出调用处 DOM。焦点陷阱/Esc 走 document 级监听、React
   合成事件在 portal 里仍沿 React 树冒泡，均不受迁出影响（契约测试
   `web/tests/drawer-portal.test.tsx` 钉死：panel/mask 直属 body、玻璃卡
   祖先不再包含它们、关闭三通道与焦点还原原样成立）。
