# dsh-tweaks

一组**可单独开关**的小改动，为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 服务。

把「我开了哪几个小开关」收敛成一块 YAML 配置，让它随 profile 跨机器同步，
而不是散落在十来个文件里靠记忆维持。

## 为什么单独做一个插件

需求是"隐藏内置供应商那一组""剔掉选不中的死模型""加个一键重启"这类**小**改动。
如果每个都手改 `cordis.patch.yml`，会带来三个问题：

1. **无法开关**：想临时恢复默认，得记住原来那段长什么样。
2. **无法跨机**：改在哪一层、改了几处，换台机器就丢。
3. **无法追溯**：半年后看到一条 `disabled: true`，不知道是谁为什么加的。

所以这里把每个改动登记成一条带 `why` 的记录，开关统一成
`config.tweaks.<id>.enabled`。加新开关 = `index.js` 里加一行 + 配置里加一行。

## 设计约束（对齐 dsh 架构）

| 约束 | 做法 |
| --- | --- |
| 配置是数据不是代码 | 每个 tweak 只有 `enabled` 加少量参数；`index.js` 的 `TWEAKS` 是唯一登记处 |
| 参数不写死在代码里 | 凡是可能因部署而异的值（重试次数/间隔、对账上限、刷新间隔）都是 `Config` 字段 + 默认值，见 `Config` schema |
| 只走官方扩展点 | ① profile 条目列表（就是 `cordis.patch.yml` 的用途）② 自己前缀下的 loopback 路由。**不碰其它包的内部** |
| 事件驱动优于轮询 | 条目类改动在启动与 `app-boot/config-reload` / `plugin-manager/changed` 时对账，**不做定时轮询**；确需兜底可用 `fallbackReconcileMs` |
| 幂等且可逆 | `ctx.effect` 注册副作用，卸载时自动回滚；重复应用不会叠加 |
| 绝不阻塞启动 | 单个 tweak 失败只记录到 `/dsh-tweaks/status`，应用照常启动 |
| 不写出坏配置 | 写 ③ 之前必须先过 YAML 解析闸门；解析不过就拒绝写入（③ 坏掉＝下次启动整层丢失） |
| 如实汇报 | 状态路由同时给出 `enabled`（想开吗）与 `applied`（真的生效了吗），避免"开了但没反应"无从排查 |

## 现有开关

| id | 默认 | 作用 | 生效对象 |
| --- | --- | --- | --- |
| `hideBuiltinDeepseek` | 关 | 隐藏内置供应商（模型列表只留「DeepSeek 账号」） | Loader 条目 `llm-deepseek` |
| `hideUnroutableModels` | 关 | 剔掉用不了的模型（一选就报错的那些） | 插件 `dsh-tap` 的设置路由 |
> 重启入口**不在本插件**：已迁到独立插件 `dsh-restart`（`/restart` 命令 + `restart_harness` 工具 + 同源端点）。原先的 `restartButton` / `POST /dsh-tweaks/restart` 与 `allowRestart` 配置已移除。
| `fixTapWebPin` | 关 | 修掉 dsh-tap 常驻的「宿主漂移」假告警（本机维护脚本，不是插件该做的事） | 磁盘文件 `node_modules/dsh-tap/index.js` |
| `sidebarBalance` | 关 | 侧边栏底部显示 DSH 内置账号余额（充值 / 赠金分开，右侧带刷新） | 宿主服务 `deepseekAccount` |

### `sidebarBalance` 的依据

把「设置 → 账号」里的余额挪到侧边栏，与渠道余量卡片（`dsh-tap-quota`）并排，
一眼能同时看到**平台余额**和**上游渠道余量**。

- **数据源**：宿主服务 `deepseekAccount.getBalance`（与「设置 → 账号」同源、同口径）。
  余额是十进制**字符串**，原样透传 —— 内置 `formatBalance` 用 Big 做 roundDown，
  先转 `Number` 会把 `12.34` 变成 `12.339999`，最后一位就漂了。浏览器端按同一套
  字符串截断规则格式化（`fmtMoney`），充值与赠金**分开显示、不相加**。
- **路由**：`GET /dsh-tweaks/balance`（受 `statusRoute` 把关），10s 缓存 + 6s 硬性超时；
  任何异常都转成可解析的 JSON，**绝不抛进响应**（否则浏览器端当成网络错误并退避）。
  两个读（`getState` / `getBalance`）**各自**超时兜底：余额慢不该把登录态也拖没。
- **失败语义**：「读失败」与「未登录」是两件事 —— `getBalance` 抛错记 `read-failed`，
  服务没有该方法才记 `signed-out`，不把失败误报成未登录。
- **渲染**：侧边栏底部注入一条（兄弟块，与 `dsh-tap-quota` 同一套挂载方式：
  一次有界结构查询 + `childList` observer + `ResizeObserver` 管折叠轨道，
  **绝不 observe `class`、绝不整页扫描**）。`⟳` 在金额右侧（`margin-left:auto`），
  **平时不可见，悬停余额行才出现**（用 `opacity` 隐藏并保留占位，悬停不横跳）。
  它的外观、出现规则、转圈反馈、底色取自所在行背景，**与 `dsh-tap-quota` 的角标共用同一套规格**
  （14×11、radius 3、11px、悬停 0.75 / 按下 1 / 禁用 0.3，底色走同一个自定义属性
  `dsh-tap-quota:refresh-bg`；`dsh-tweaks/test/run.mjs` 逐项比对两边的 CSS，改一边忘了另一边会红）。
  点击 `stopPropagation` 只发一次请求。透明无底色 —— 与 `dsh-tap-quota` 的卡片观感一致。
- **不显示企业套餐额度**：CodeBuddy/WorkBuddy 企业旗舰版在网页控制台显示的
  「月度限额 / 累积剩余」来自 **cookie 体系**，OAuth 不可达（见
  `dsh-tap/docs/rules/quota-signals.md` R-Q10，标未解）。这里不估算、不冒充。

> 余额行为什么不在 `dsh-tap-quota`：那个包管的是**上游渠道余量**
> （CodeBuddy / Trae / Qoder），数据源是 dsh-tap 的 `/settings` 路由；
> DSH 内置余额来自**另一个服务**（`deepseekAccount`），两者不同源，分开由各自插件管。

### 开关卡片上有什么

每条开关在插件页是一张卡片。**只留核心信息**，其余全部收进悬浮提示
（之前七块并排太吵，反而看不出重点）：

| 卡片上 | 悬浮提示里 |
| --- | --- |
| 勾选框（启用状态） | 当前启用状态 |
| 短标题 | — |
| 一句白话描述（`what`） | 完整作用 |
| 生效对象 chip（如「插件：dsh-tap（CodeBuddy 网关）」） | 生效对象全名 |
| 对象状态 chip（就绪 / 已禁用 / 对象缺失…） | 对象状态详情 |
| 出错或本次动作结果（仅在有内容时出现） | 生效方式（`effect`）、生效条件（`appliesWhen`）、依据（`why`） |

`subjectStatus` 取值（只看此刻的事实，不猜）：

| status | 含义 |
| --- | --- |
| `idle` | 开关没开 |
| `ready` | 对象在位、可用 |
| `pending` | 对象在位，但效果还没落上去（刚启动/还没对账） |
| `disabled` | 对象在位且已被本开关禁用（条目类改动的稳态） |
| `missing` | 对象不在：插件没装、条目不在 Loader 树里、文件找不到 |
| `mismatch` | 对象在，但形态对不上（例如补丁片段与上游不匹配） |

### `hideUnroutableModels` 的依据

这条改的是**数据**，不是 Loader 条目 —— 为了剔几个模型把 `dsh-tap` 整条禁掉是不行的。

- **清单来源**：上游「目录里有 ≠ `/v2` 可路由」是 dsh-tap 的既有事实
  （`providers/codebuddy/catalog.js` 的 `UNROUTABLE_MODELS`，恒 `11102 service info not found`）。
  本插件不复制这张表，而是读它的 `POST /dsh-tap/settings {action:'model-list'}` 响应里的
  `unroutable` + `catalog.models`，只处理**目录里仍在列**的 id（上游删了的历史 id 不再动）。
- **怎么剔**：对每个「在列且当前在选择器里」的 id 发
  `POST /dsh-tap/settings {patch:{modelSetEnabled:{id,enabled:false}}}` —— 和设置卡勾选框
  同一条路径，dsh-tap 自己会把宿主镜像重铺，选择器立刻跟上；宿主发起没有 `Origin` 头，
  落在它「壳转发/非浏览器放行」的语义里。**不直接写它的文件。**
- **列表里的行**：浏览器半只加一条 CSS（`.cbc-listrow.cbc-unroutable{display:none}`，
  以及「某个分组小标题后面只剩死条目时连标题一起隐去」），不动别人的 DOM 节点、
  不对 `class` 做 MutationObserver。
- **可逆**：开之前处于启用状态的 id 记在 `~/.dsh/.cache/dsh-tweaks/hide-unroutable.json`
  （本机 `.cache`，不进同步盘）；关闭开关时按这份清单勾回去。
- **不做周期对账**：只在启动/开关时执行一次。在 dsh-tap 卡里手动勾回的条目，
  下次启动会被再剔一次；`GET /dsh-tweaks/status` 的 `note` 会写清这次动了哪几个 id。

### `fixTapWebPin` 的依据（补丁类 · 本机维护脚本）

> ⚠ **这一项不属于插件职责**：它修改的是 dsh-tap **已安装的产物**（`node_modules`），
> 升级/重装即失效，是一笔技术债。之所以还留在这里，只是为了可追溯 + 每次启动自动补回。
> 根治办法是把修复报给 dsh-tap 上游。

dsh-tap 0.20.0 的「web 钉选对账」探测 `webService?.()?.searchProviderId / fetchProviderId`。
这两个**实例字段在 dsh-web 的 `WebRuntime` 上不存在**——真实值在 config 的 volatile 字段
（`svc.config.searchProvider.get()`，cosmokit `createVolatile` 返回冻结的 `{get}`），env 兜底与
`search()` 内一致（`$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER`）。于是 CodeBuddy 卡的
「宿主漂移」是**常驻假 warn**。

- **怎么补**：对 `profiles\<profile>\node_modules\dsh-tap\index.js` 做原样字符串替换
  （`TAP_WEBPIN_OLD` → `TAP_WEBPIN_NEW`）。profile 目录名不硬编码，扫描带 `node_modules\dsh-tap` 的那个。
- **幂等 + 自愈**：开=打上（已在位则不写），**每次启动自动补回**，所以 `dsh plugin add dsh-tap`
  重装/升级冲掉补丁也无所谓；关=还原上游原样。
- **对不上就不动**：`state ∈ patched / upstream / unknown`。上游形态变了 → `unknown`，不改文件，
  `note` 如实写「上游代码形态变了，补丁对不上——未改动文件」。
- **生效条件**：改的是 `node_modules`，**重启 DSH 才生效**（hmr 不监听 node_modules）。
- web 钉选的权威配置在 dsh-tap 自己的 bundle patch（`node_modules\dsh-tap\cordis.patch.yml` 末尾
  `searchProvider: codebuddy`）；③ 里那份是显式冗余。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-tweaks/status` | 每个 tweak 的 `enabled` / `applied` / `present` / `effective` / `subject*` / `note` / `error`，外加一段 `config`（下发给浏览器半的 `statusRefreshMs`） |
| `GET` | `/dsh-tweaks/balance` | `sidebarBalance` 的数据：`{ ok, at, signedIn, balance:{ok,wallets,bonusWallets,error?}, reason? }`。10s 缓存，`?refresh=1` 绕过 |
| `POST` | `/dsh-tweaks/toggle` | 把某个 tweak 的 `enabled` 写回 **③** 的 `dsh-tweaks` 段（界面开关走这条）。**落盘前先做 YAML 解析校验**，不过就拒绝写入 |

前两条由 `config.statusRoute` 把关（默认开，只读且在 loopback 上）。

## 配置写在哪一层

① 包内 `cordis.patch.yml`（重装即重置）→ ② `profiles/desktop/cordis.patch.yml`（界面与 `configEditor` 写这里）→
③ `~/.dsh/cordis.patch.yml`（本机覆盖层，**优先级最高**）。

- 本插件的开关只认 **③**：`toggle` 按行改 ③ 的 YAML 文本（容忍行尾注释）；写在 ② 会被 ③ 覆盖。
- **写 ③ 前必须过 YAML 解析闸门**（`validatePatchText`）：③ 是覆盖层，一旦写成不可解析的文档，
  宿主下次启动会在 `parsePatchList` 直接抛错、**整层丢失**（等于所有开关失效）。
  开关本身现在还带这个保护——解析不过就拒绝写入并报错。
- ③ 写盘后 hmr 会重新应用并**重新 import 插件代码**——改完 `index.js` 不用重启。
- 但 `node_modules` 里**别的**插件代码不受监听：那类改动（含 `fixTapWebPin` 打的补丁）要重启 DSH。

## 配置

```yaml
- insert:
    - id: dsh-tweaks
      name: 'dsh-tweaks'
      config:
        statusRoute: true      # 只读状态路由
        # 可调参数（官方约定：可能因部署而异的值都要进 Config）
        dataRetry:             # 数据类改动等上游路由就绪的重试
          attempts: 8
          intervalMs: 2000
        reassertLimit: 10      # 对账被反复弹回的重试上限
        fallbackReconcileMs: 0 # >0 才额外开兜底定时对账（默认纯事件驱动）
        statusRefreshMs: 600000 # 浏览器半状态兜底刷新间隔
        tweaks:
          hideBuiltinDeepseek:
            enabled: true
          hideUnroutableModels:
            enabled: true
          fixTapWebPin:
            enabled: true
          sidebarBalance:
            enabled: true
```

## 三种改动的形态

| 形态 | 效果落在哪 | 声明 |
| --- | --- | --- |
| Loader 条目类 | 把目标条目的 `disabled` 置真 | `target: '<entry id>'` |
| 数据类 | 调目标插件自己的路由（如 dsh-tap 的设置路由）+ 浏览器半 CSS | `menu: true` 加 `apply` / `restore` |
| 补丁类 | 直接改 `node_modules` 里目标插件的磁盘文件（幂等字符串替换） | `menu: true` 加 `apply` / `restore`，无 `target` |

三种都只在 `config.tweaks.<id>.enabled` 上开关；`/dsh-tweaks/status` 一视同仁地报状态。

Loader 启动与配置热应用时（`app-boot/config-reload` / `plugin-manager/changed`）会 reconcile 重建条目，
所以条目类不是"置真一次就完"：插件在这些时机**事件驱动地对账**，最多 `reassertLimit`（默认 10）次
（`reasserts` 如实上报；超限后仍翻回来就报 `target flips back after disable`）。默认**不做定时轮询**；
确需兜底可把 `fallbackReconcileMs` 设为 >0。

## 加一个开关

```js
// index.js —— Loader 条目类
{
  id: 'myTweak',
  title: '一句话说明它改什么',
  why: '为什么要改、依据是什么、范围边界在哪里 —— 写给半年后的自己看',
  target: 'ui-some-entry',   // 把这个条目的 disabled 置真
}

// index.js —— 数据类（要调目标插件自己的路由 / 需要浏览器半配合）
{
  id: 'myDataTweak',
  title: '…',
  why: '…',
  menu: true,                                   // 账号菜单里给一行
  apply({ origin, stateFile }) { /* 开 */ },
  restore({ origin, stateFile }) { /* 关：把开之前的状态还回去 */ },
}
```

再在 `cordis.patch.yml` 的 `tweaks` 下加 `myTweak: { enabled: false }`。
数据类的 `apply` 只在启动/开关时跑一次，失败会按 `dataRetry`（默认 2 秒间隔、最多 8 次）重试再记进状态。

**每条开关都必须说清「生效对象」**（否则卡片上会出现"不知道作用在谁身上"的行）：

```js
{
  id: 'myTweak',
  title: '一句话标题',
  what: '它改什么（一句话，会直接显示在卡片上）',
  why: '为什么要改、依据是什么、范围边界 —— 写给半年后的自己看',
  subject: { kind: 'entry' | 'plugin' | 'file' | 'host', name: '<对象标识>', label: '<给人看的名字>' },
  effect: '它怎么生效（禁用条目 / 调它的路由 / 改它的文件 / 退进程）',
  appliesWhen: '什么前提下才生效（对象在位？还要另一个开关开？）',
  // 按形态再补其一：
  target: 'ui-some-entry',                              // 条目类
  apply({ origin, stateFile }) {}, restore({ origin, stateFile }) {},  // 数据类/补丁类
  action: 'restart',                                    // 带按钮的动作类
  menu: true,                                           // 要不要在卡片列表里出现
}
```

`subjectStatus` 由 `describeSubject()` 按 `subject.kind` 自动判定（entry 看 Loader 树、
plugin 看 apply 结果、file 看文件在不在、host 看可执行文件能不能定位），不用手写。

## 安装形态的坑（Junction 会让插件静默失活）

`plugin_manager install_bundle` 传**绝对路径**时，会把 profile 里的 spec 改写成
`file:C:/...`，pnpm 据此把本包装成 **Junction**（`LinkType='Junction'`）。
Junction 让 `index.js` 的依赖解析基准落到**源码目录**（在同步盘上、没有 `node_modules`），
于是 `import '@deepseek-ai/schemastery'` 找不到 → `apply` 抛错 → 条目 `fiberPhase: null`
→ `/dsh-tweaks/status` 返回 404，**而且重启也不会自愈**（Node 缓存了失败的模块解析，
失败的 fiber 不会自己重试）。

兄弟包（`dsh-model-info` / `dsh-tap-quota`）是真实目录（`LinkType=''`）所以不受影响。

排查与修复：

```powershell
# 1. 安装形态：LinkType 应为空
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tweaks" -Force | Select-Object LinkType

# 2. 条目是否真的活了：plugin_manager → list_plugins，看末尾几条
#    （其余插件都是 active；它是 null 就说明没起来）

# 3. 修：spec 改回相对形式 + 删掉 junction + 按 file: 重新解析安装
#    完整步骤见 3-pcsetting\.dsh\dsh-plugins\AGENTS.md「安装与依赖」

# 4. 必须重启 DSH 才生效
```

一句话判据：**源码包不能以链接形态装进 profile**，否则依赖解析会跑到同步盘上去。

## Dev

```bash
node test/run.mjs      # 165 assertions：注册表与生效对象元数据 / 对象状态判定 /
                       # 不可路由清单 / 开关写回 / YAML 校验闸门 / Config 可调参数 /
                       # 事件驱动对账 / 重启三重闸门与令牌 / 侧边栏入口已撤销 /
                       # 卡片字段与精简纪律 / DOM 纪律 / 无死请求
```

## 已知偏离官方架构之处（知情取舍 / 技术债）

官方文档（[插件开发](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、
`docs/subsystems/{settings,slots}`、`ui-plugin.md`）给出的默认做法与本插件的取舍：

| # | 偏离 | 取舍理由 |
| --- | --- | --- |
本插件贡献两处 UI，全部走官方 slot（`plugins.bundle.config` 开关卡片），
只有第二处是例外：

| 1 | **就地行（`decorateTapSection` + `.cbc-*` CSS）直读 dsh-tap 的 DOM/样式** | 官方要求只用 slot 贡献 UI。这里保留是因为产品要求"在 dsh-tap 卡里就地开关"；代价是 dsh-tap 改结构就失效（对不上锚点就静默不做，不崩） |
| 2 | **`fixTapWebPin` 改他人已安装产物** | 属本机维护脚本，技术债；根治要报上游 |
| 3 | **配置写 ③ 而非官方 `config-editor`（落 ②）** | 跨机约定要求权威配置在 ③；官方 `config-editor` 只写 ②，会被 ③ 覆盖。官方另一条路是声明 `Config` 后由 `ctx.settings` 自动投影成表单，但它的写入同样落 ② |
| 5 | **未给 agent 暴露 Tool** | 官方要求"一个操作两个入口"（UI + Tool）共用同一实现；目前只有 UI + loopback 路由 |
| 6 | **缺 locale/icon** | 官方建议 bundle 导出 `locale/*.json` 的 `meta.title/description` 与图标；当前落回 `package.json` 的英文描述 |

> 保持不变的纪律：只用 `ctx.effect` 注册可逆副作用、失败不阻塞启动、如实上报状态、
> 浏览器端绝不 observe `class`、只看新增子树 + rAF 合帧 + WeakMap 幂等。

## License

MIT
