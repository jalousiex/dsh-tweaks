# dsh-tweaks

一组**可单独开关**的小改动，为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 服务。

把「我开了哪几个小开关」收敛成一块 YAML 配置，让它随 profile 跨机器同步，
而不是散落在十来个文件里靠记忆维持。

## 为什么单独做一个插件

需求是"去掉设置里的模型清单页""加个一键重启"这类**小**改动。
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
| 只走官方扩展点 | ① profile 条目列表（就是 `cordis.patch.yml` 的用途）② 自己前缀下的 loopback 路由。**不碰其它包的内部** |
| 幂等且可逆 | `ctx.effect` 注册副作用，卸载时自动回滚；重复应用不会叠加 |
| 绝不阻塞启动 | 单个 tweak 失败只记录到 `/dsh-tweaks/status`，应用照常启动 |
| 如实汇报 | 状态路由同时给出 `enabled`（想开吗）与 `applied`（真的生效了吗），避免"开了但没反应"无从排查 |

## 现有开关

| id | 默认 | 作用 |
| --- | --- | --- |
| `hideSettingsModels` | 关 | 隐藏设置里的「模型清单」页，只留「账号与余额」 |
| `hideBuiltinDeepseek` | 关 | 隐藏内置 DeepSeek 供应商，只留「DeepSeek 账号」 |
| `hideUnroutableModels` | 关 | 把目录里已知不可路由的模型（含 `hy4-preview-x`）从选择器与设置卡列表里剔掉 |
| `restartButton` | 关 | 菜单里加一个「重启 DeepSeek Harness」入口 |

### `hideSettingsModels` 的依据

设置里那一页由 `@deepseek-ai/dsh-client-ui-settings-models` 提供，
注册点在 `dsh-web-app/cordis.patch.yml` 第 294 行（`id: ui-settings-models`）。

按 dsh 的 patch 语义（「一条 patch 按 id 定位某个条目并替换其整个 config」），
把该条目 `disabled: true` 即可 —— 不是改别人的文件，是走它自己的扩展点。
`disabled` 也不是本插件发明的字段：bundle 层自己就在用（同文件第 448 行起有 6 处）。

**范围说明**：模型清单本身是 dsh-tap 网关返回的上游目录。关掉这一页
**不影响** `/model` 下拉和模型选择，只少一个只读展示页。

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

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-tweaks/status` | 每个 tweak 的 `enabled` / `applied` / `note` / `error` |
| `POST` | `/dsh-tweaks/toggle` | 把某个 tweak 的 `enabled` 写回 ③ 的 `dsh-tweaks` 段（界面开关走这条） |
| `POST` | `/dsh-tweaks/restart` | 真重启宿主。**需显式 `allowRestart: true`**，默认关（会中断会话） |
| `POST` | `/dsh-tweaks/diag` | 浏览器半诊断，落 `~/.dsh/.cache/dsh-tweaks-client.json` |

## 配置

```yaml
- insert:
    - id: dsh-tweaks
      name: 'dsh-tweaks'
      config:
        statusRoute: true      # 只读状态路由
        allowRestart: false    # 允许 POST /dsh-tweaks/restart
        tweaks:
          hideSettingsModels:
            enabled: true
          hideUnroutableModels:
            enabled: true
          restartButton:
            enabled: false
```

## 两种改动的形态

| 形态 | 效果落在哪 | 声明 |
| --- | --- | --- |
| Loader 条目类 | 把目标条目的 `disabled` 置真 | `target: '<entry id>'` |
| 数据类 | 调目标插件自己的路由（如 dsh-tap 的设置路由）+ 浏览器半 CSS | `menu: true` 加 `apply` / `restore` |

两种都只在 `config.tweaks.<id>.enabled` 上开关；`/dsh-tweaks/status` 对两者一视同仁地
报 `enabled` / `applied` / `note` / `error`。

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
数据类的 `apply` 只在启动/开关时跑一次，失败会按 2 秒间隔重试 8 次再记进状态。

## Dev

```bash
node test/run.mjs      # 67 assertions：注册表 / 不可路由清单 / 开关解析 / 状态汇报 / DOM 纪律
```

## License

MIT
