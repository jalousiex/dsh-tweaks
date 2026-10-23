/**
 * dsh-tweaks —— 浏览器半。
 *
 * 贡献两处 UI，全部读 `GET /dsh-tweaks/status`：
 *
 *  1. **设置窗口的一级分区「增强补丁」**（官方 slot `settings.section`）——
 *     具体补丁开关的**权威入口**，可交互 checkbox，按归属对象分组。
 *     为什么放这里而不是插件详情页：开关一改就写配置 → 插件条目热重载 →
 *     详情页重建 → 界面跳回"只有插件信息"（用户痛点）。settings.section 是设置
 *     窗口自己的导航分区，不挂在插件条目下，不受这条重载链影响。
 *  2. **设置 › 插件 › dsh-tweaks 详情页**（slot `plugins.bundle.config`）——
 *     **只读说明**：一句指路 + 启用计数。不放开关，理由同上。
 *
 * 重启入口为什么只在插件页：侧边栏底部（`sidebar.footer.action`）试过又撤掉——
 * 那一行与 dsh-tap-quota 的余额卡片共用，按钮挤在「设置」旁位置不对；而头像菜单
 * （`AccountMenu`，`settings.launcher` 的 single 占用者）没有任何菜单项 slot
 * 可扩展（88 个 slot 里没有「头像菜单项」这种槽）。
 *
 * 加载器契约（dsh 硬规则）：本文件**必须**是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧的 `{ id, exports: fn }` 形态会让宿主抛
 * `registered.factory is not a function`，直接崩掉整个 web boot。
 *
 * DOM 纪律：本插件只用 slot 贡献 UI，不读他人 DOM / 样式。
 */

window.__ModuleLoader__.load({
	id: "dsh-tweaks",
	factory: function (require) {
		"use strict";
		var React = require("react");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STATUS = "/dsh-tweaks/status";
		var TOGGLE = "/dsh-tweaks/toggle";
		var MARK = "data-dsh-tweaks";
		// 兜底刷新间隔的兜底值（毫秒）：正常由宿主 GET /dsh-tweaks/status 的
		// config.statusRefreshMs 下发，这里只是它也拿不到时的最后默认值。
		var DEFAULT_REFRESH_MS = 600000;
		var BUNDLE_KEY = "dsh-tweaks";
		/** 设置窗口一级分区 id（settings.section）：具体补丁开关的入口。
		 *  惯例参考 dshmarket 的 `id: 'market'`、github-copilot 的 `id: 'github-copilot'`
		 *  ——短 slug，与插件条目 id 分属不同命名空间，同名也不冲突。 */
		var SECTION_ID = "tweaks";

		// 开关列表：每条一个卡片，含「启用状态 / 描述 / 生效对象 / 对象状态 / 生效条件」。
		var CSS_TEXT = [
			'.dtw-pagehint{margin:0 0 4px;opacity:.65;font-size:12px}',
			'.dtw-pagehint-warn{color:#d29922;opacity:.95}',
			'.dtw-pagehint-error{color:#f85149;opacity:.95}',
			'.dtw-section{margin-top:10px}',
			'.dtw-section:first-of-type{margin-top:4px}',
			'.dtw-group{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0 2px;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2));margin-bottom:2px}',
			'.dtw-groupname{font-size:12px;font-weight:600;opacity:.9;letter-spacing:.02em}',
			'.dtw-groupmeta{font-size:11px;opacity:.55;white-space:nowrap}',
			'.dtw-card{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2))}',
			'.dtw-card:last-child{border-bottom:0}',
			'.dtw-head{display:flex;align-items:flex-start;gap:10px}',
			'.dtw-headcheck{flex:0 0 auto;margin-top:2px}',
			'.dtw-headtext{flex:1;min-width:0}',
			'.dtw-title{display:block;font-weight:600}',
			'.dtw-what{display:block;opacity:.75;font-size:12px;margin-top:2px;white-space:normal}',
			'.dtw-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-left:24px}',
			'.dtw-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.25));opacity:.85;white-space:normal}',
			'.dtw-chip-key{opacity:.6}',
			'.dtw-chip-ready{color:#3fb950;border-color:#3fb95055}',
			'.dtw-chip-disabled{color:#58a6ff;border-color:#58a6ff55}',
			'.dtw-chip-pending{color:#d29922;border-color:#d2992255}',
			'.dtw-chip-missing,.dtw-chip-mismatch{color:#f85149;border-color:#f8514955}',
			'.dtw-chip-idle{opacity:.55}',
			'.dtw-note{margin-left:24px;font-size:11px;opacity:.6;white-space:normal}',
			'.dtw-note-error{color:#f85149;opacity:.9}',
			'.dtw-actions{margin-left:24px;margin-top:6px;display:flex;align-items:center;gap:8px}',
			'.dtw-btn{font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer}',
			'.dtw-btn:hover:not(:disabled){border-color:var(--dsw-alias-stroke-strong,rgba(128,128,128,.6))}',
			'.dtw-btn:disabled{opacity:.45;cursor:not-allowed}',
			'.dtw-btn-danger{border-color:#f8514966;color:#f85149}',
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-tweaks"]';
			var existing = document.querySelector(tag);
			if (existing) return;
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tweaks");
			el.setAttribute("data-plugin-css", "dsh-tweaks");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// State: rows = 参与开关列表的 tweak（menu 声明或带 target）。
		// ------------------------------------------------------------------
		var state = { rows: [], loaded: false, refreshMs: DEFAULT_REFRESH_MS };
		var listeners = [];

		function readTweaks(doc) {
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			var rows = [];
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (!t || typeof t.id !== "string") continue;
				if (!(t.menu === true || t.target || t.action)) continue;
				rows.push({
					id: t.id,
					title: t.title || t.id,
					// 一句话「它改什么」——比 why 更适合放在卡片正文里。
					what: typeof t.what === "string" ? t.what : "",
					why: typeof t.why === "string" ? t.why : "",
					note: typeof t.note === "string" ? t.note : "",
					error: typeof t.error === "string" ? t.error : "",
					enabled: t.enabled === true,
					applied: t.applied === true,
					effective: t.effective === true,
					present: t.present === true,
					// 生效对象：{ kind, label }（kind ∈ entry / plugin / file / host）
					subjectKind: typeof t.subjectKind === "string" ? t.subjectKind : "",
					subjectLabel: typeof t.subjectLabel === "string" ? t.subjectLabel : "",
					// 对象状态：idle / ready / pending / disabled / missing / mismatch
					subjectStatus: typeof t.subjectStatus === "string" ? t.subjectStatus : "unknown",
					subjectStatusLabel: typeof t.subjectStatusLabel === "string" ? t.subjectStatusLabel : "",
					effect: typeof t.effect === "string" ? t.effect : "",
					appliesWhen: typeof t.appliesWhen === "string" ? t.appliesWhen : "",
					// 归属（分组用）：标识这条补丁属于哪个组件。
					ownerName: typeof t.ownerName === "string" ? t.ownerName : "",
					ownerLabel: typeof t.ownerLabel === "string" ? t.ownerLabel : "",
					ownerKind: typeof t.ownerKind === "string" ? t.ownerKind : "",
					group: typeof t.group === "string" ? t.group : "",
					// 有 action 的条目带按钮（当前没有这类条目：重启已迁出）。
					action: typeof t.action === "string" ? t.action : null,
					actionReady: t.actionReady === true,
					actionBlockedBy: typeof t.actionBlockedBy === "string" ? t.actionBlockedBy : "",
				});
			}
			var refreshMs = DEFAULT_REFRESH_MS;
			var cfg = doc && doc.config;
			if (cfg && typeof cfg.statusRefreshMs === "number" && cfg.statusRefreshMs > 0) {
				refreshMs = cfg.statusRefreshMs;
			}
			return { rows: rows, loaded: true, refreshMs: refreshMs };
		}

		function notify() {
			// ⚠ 必须把当前 state 传给 listener：React useState 的 setter 无参调用
			// 等价于 setState(undefined)，会把组件 state 置为 undefined，
			// 下一次渲染时 s.rows 抛错 → 整棵 React 树崩溃 → 界面白屏。
			for (var i = 0; i < listeners.length; i++) {
				try { listeners[i](state); } catch (e) {}
			}
		}

		// 状态落地后的钩子（install 用它按新间隔重排兜底刷新定时器）。
		var statusSink = null;
		var stopQuickRef = null;

		function fetchStatus() {
			return fetch(STATUS, { headers: { accept: "application/json" } })
				.then(function (r) {
					return r.text().then(function (text) {
						var doc = null;
						try {
							doc = JSON.parse(text);
						} catch (e) {
							doc = null;
						}
						state = readTweaks(doc);
						ensureStyles();
						if (statusSink) { try { statusSink(state); } catch (e) {} }
						notify();
						return state;
					});
				})
				.catch(function () {
					// ⚠ 关键：**不要**把 rows 清空。宿主写 ③ 后会重载插件、重放配置，
					// 这期间 /status 会短暂失败；若这里把 rows 置空，整张列表会瞬间消失
					// ——这正是「点一下开关，列表整个没了」的根因。
					// 正确做法：保留上一份好数据，只标一个 stale 标记。
					state = {
						rows: state.rows || [],
						loaded: state.loaded,
						refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
						stale: true,
					};
					if (statusSink) { try { statusSink(state); } catch (e) {} }
					notify();
					return state;
				});
		}

		/**
		 * 切一个开关。
		 *
		 * 宿主只写它自己的状态文件并就地重跑 apply，**不触发插件条目热重载**，
		 * 所以这次切换是即时的：请求回来后再取一次 /status 即可，不需要轮询等
		 * 「已经生效」。界面（分区、勾选框、滚动位置）全程不重建。
		 */
		function toggle(id, next) {
			// 乐观更新：先让勾选框立刻响应，失败再回滚（避免"点了没反应"的观感）。
			state = {
				rows: (state.rows || []).map(function (r) {
					return r.id === id ? Object.assign({}, r, { enabled: next === true }) : r;
				}),
				loaded: state.loaded,
				refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
			};
			notify();
			return fetch(TOGGLE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, enabled: next }),
			}).then(function (r) {
				return r.text().then(function (text) {
					var doc = null;
					try { doc = JSON.parse(text); } catch (e) { doc = null; }
					if (!doc || doc.ok === false) {
						throw new Error((doc && doc.error) || ("写入失败（HTTP " + r.status + "）"));
					}
					return doc;
				});
			}).then(fetchStatus).catch(function (error) {
				// 失败：回滚乐观更新并记错误，列表照旧保留。
				state = {
					rows: (state.rows || []).map(function (r) {
						return r.id === id ? Object.assign({}, r, { enabled: next !== true }) : r;
					}),
					loaded: state.loaded,
					refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
					lastError: String((error && error.message) || error),
				};
				notify();
				return state;
			});
		}

		/**
		 * 轮询 /status 直到某个条目的 enabled 等于期望值，或超时。
		 * 只读、不写，超时返回 false（调用方再取一次状态即可）。
		 */
		function waitForApplied(id, want, timeoutMs) {
			var deadline = Date.now() + timeoutMs;
			function poll() {
				if (Date.now() > deadline) return Promise.resolve(false);
				return fetch(STATUS, { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (doc) {
						var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
						for (var i = 0; i < list.length; i++) {
							if (list[i] && list[i].id === id) {
								if ((list[i].enabled === true) === (want === true)) return true;
								break;
							}
						}
						return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
					})
					.catch(function () {
						// 宿主正在重载：稍等再试，不要当失败。
						return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
					});
			}
			return poll();
		}


		// ------------------------------------------------------------------
		// React: 设置 › 插件 › dsh-tweaks 页的开关列表（plugins.bundle.config）。
		// ------------------------------------------------------------------
		function useTweaks() {
			var s = React.useState(function () { return state; });
			var set = s[1];
			React.useEffect(function () {
				listeners.push(set);
				return function () {
					var i = listeners.indexOf(set);
					if (i >= 0) listeners.splice(i, 1);
				};
			}, []);
			return s[0];
		}

		var SUBJECT_KIND_LABEL = {
			entry: "Loader 条目",
			plugin: "插件",
			file: "磁盘文件",
			host: "宿主进程",
		};

		var STATUS_LABEL = {
			idle: "未启用",
			ready: "就绪",
			pending: "待生效",
			disabled: "已禁用",
			missing: "对象缺失",
			mismatch: "形态不匹配",
			unknown: "未知",
		};

		function Chip(props) {
			return React.createElement("span", {
				className: "dtw-chip dtw-chip-" + props.kind,
				title: props.title || undefined,
			}, React.createElement("span", { className: "dtw-chip-key" }, props.label), props.value);
		}

		/**
		 * 一条 tweak = 一张卡片。勾选框恢复可交互——它现在挂在**设置窗口的独立分区**
		 * （settings.section，「增强补丁」），不再是插件详情条目下的内容，
		 * 因此点开关触发的条目热重载不会把界面打回插件信息页。
		 *
		 * 卡片只留核心：勾选框 + 短标题 + 一句描述 + 生效对象 chip + 对象状态 chip。
		 * 详细依据（why / effect / appliesWhen）全部收进悬浮 title。
		 */
		function TweakCard(props) {
			var row = props.row;
			var hint = [
				row.enabled ? "当前：已启用" : "当前：未启用",
				row.what ? "作用：" + row.what : "",
				row.subjectLabel ? "生效对象：" + row.subjectLabel : "",
				row.subjectStatusLabel ? "对象状态：" + row.subjectStatusLabel : "",
				row.effect ? "生效方式：" + row.effect : "",
				row.appliesWhen ? "生效条件：" + row.appliesWhen : "",
				row.why ? "依据：" + row.why : "",
			].filter(Boolean).join("\n");
			var subjectKindText = row.subjectKind
				? (SUBJECT_KIND_LABEL[row.subjectKind] || row.subjectKind)
				: "";
			return React.createElement("div", { className: "dtw-card", title: hint || undefined },
				React.createElement("div", { className: "dtw-head" },
					React.createElement("input", {
						type: "checkbox",
						className: "dtw-headcheck",
						checked: row.enabled === true,
						onChange: function (e) { toggle(row.id, e.target.checked); },
					}),
					React.createElement("div", { className: "dtw-headtext" },
						React.createElement("span", { className: "dtw-title" }, row.title),
						row.what ? React.createElement("span", { className: "dtw-what" }, row.what) : null)),
				// 只留两个 chip：作用在谁身上 + 它现在什么状况。
				React.createElement("div", { className: "dtw-meta" },
					row.subjectLabel
						? React.createElement(Chip, {
							kind: row.enabled ? "disabled" : "idle",
							label: (subjectKindText ? subjectKindText + "：" : ""),
							value: row.subjectLabel,
						})
						: null,
					React.createElement(Chip, {
						kind: row.subjectStatus,
						label: "",
						value: STATUS_LABEL[row.subjectStatus] || row.subjectStatus,
						title: row.subjectStatusLabel || undefined,
					})),
				// 只在真出问题时才占行（正常状态不刷屏）。
				row.error ? React.createElement("div", { className: "dtw-note dtw-note-error" }, "错误：" + row.error) : null,
				row.note ? React.createElement("div", { className: "dtw-note" }, row.note) : null);
		}

		/**
		 * 按**归属对象**（owner）分组。
		 *
		 * 顺序固定：DSH 自身 → 各插件 → 其他。
		 */
		var OWNER_ORDER = ["dsh"];

		function groupRows(rows) {
			var byOwner = {};
			var order = [];
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var key = r.ownerName || "other";
				if (!byOwner[key]) { byOwner[key] = { name: key, label: r.ownerLabel || key, kind: r.ownerKind || "other", rows: [] }; order.push(key); }
				byOwner[key].rows.push(r);
			}
			// 固定顺序：OWNER_ORDER 里列出的优先，其余按首次出现顺序。
			var names = [];
			for (var o = 0; o < OWNER_ORDER.length; o++) {
				if (byOwner[OWNER_ORDER[o]]) names.push(OWNER_ORDER[o]);
			}
			for (var j = 0; j < order.length; j++) {
				if (names.indexOf(order[j]) < 0) names.push(order[j]);
			}
			var out = [];
			for (var n = 0; n < names.length; n++) {
				var g = byOwner[names[n]];
				out.push({
					name: g.name,
					label: g.label,
					kind: g.kind,
					rows: g.rows,
				});
			}
			return out;
		}

		/** 组标题：归属对象 + 这一组的整体状况（开几个 / 有没异常）。 */
		function GroupHeader(props) {
			var rows = props.rows;
			var on = 0;
			var bad = 0;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].enabled) on++;
				if (rows[i].subjectStatus === "missing" || rows[i].subjectStatus === "mismatch") bad++;
			}
			return React.createElement("div", { className: "dtw-group" },
				React.createElement("span", { className: "dtw-groupname" }, props.label),
				React.createElement("span", { className: "dtw-groupmeta" },
					on + "/" + rows.length + " 已启用" + (bad ? " · " + bad + " 项异常" : "")));
		}

		function TweaksPage() {
			var s = useTweaks();
			var rows = s.rows || [];
			var groups = groupRows(rows);
			var status = null;
			if (s.stale) {
				status = React.createElement("p", { className: "dtw-pagehint dtw-pagehint-warn" },
					"宿主正在重载，下面是上一次读到的状态（会自动刷新）。");
			} else if (s.lastError) {
				status = React.createElement("p", { className: "dtw-pagehint dtw-pagehint-error" },
					"上一次操作失败：" + s.lastError);
			}
			return React.createElement("div", null,
				React.createElement("p", { className: "dtw-pagehint" },
					"每条改动单独开关，按归属对象分组；开关写回 profile 配置，随 profile 跨机同步。"),
				status,
				groups.length
					? groups.map(function (grp) {
						return React.createElement("div", { key: grp.name, className: "dtw-section" },
							React.createElement(GroupHeader, { label: grp.label, rows: grp.rows }),
							grp.rows.map(function (row) {
								return React.createElement(TweakCard, { key: row.id, row: row });
							}));
					})
					: React.createElement("p", { style: { opacity: 0.6 } },
						s.loaded ? "宿主还没有登记任何开关。" : "正在读取开关状态……"));
		}

		/**
		 * 插件详情页（设置 › 插件 › dsh-tweaks）里那一块 ——**只读说明**。
		 *
		 * 为什么这里不放开关：开关一改就要写配置 → 插件条目热重载 → 本页重建，
		 * 界面会跳回"只有插件信息"的状态（用户明确反馈的痛点）。所以开关移到
		 * 设置窗口的一级分区（settings.section，「增强补丁」），那里不挂在插件条目下，
		 * 不受这条重载链影响。这里只留一句指路 + 状态摘要。
		 */
		function PluginInfo() {
			var s = useTweaks();
			var rows = s.rows || [];
			var on = 0;
			for (var i = 0; i < rows.length; i++) if (rows[i].enabled) on++;
			return React.createElement("div", null,
				React.createElement("p", { className: "dtw-pagehint" },
					"本插件登记了一组小改动开关。开关在设置窗口的「增强补丁」分区里改（左侧导航），不在本页——"
					+ "改开关会触发插件重载，放在本页会打断浏览。"),
				React.createElement("p", { className: "dtw-pagehint" },
					"当前：" + on + "/" + rows.length + " 项已启用。"));
		}

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var timer = null;

			// 兜底刷新：间隔由宿主 /dsh-tweaks/status 的 config.statusRefreshMs 下发
			// （不写死在浏览器半），这里按当前值重排定时器。
			function armRefresh() {
				if (timer) clearInterval(timer);
				var ms = state.refreshMs > 0 ? state.refreshMs : DEFAULT_REFRESH_MS;
				timer = setInterval(function () {
					if (typeof document !== "undefined" && document.hidden) return;
					fetchStatus();
				}, ms);
			}

			armRefresh();

			// 每次状态落地（首帧 / 每次 toggle / 每次兜底刷新）都按服务端下发的
			// 间隔重排定时器，这样 statusRefreshMs 改一次就全局生效，不写死。
			statusSink = function () { armRefresh(); };
			fetchStatus();

			// 首帧没拿到内容时快速重试几次（宿主可能还没注册完路由 / 正忙）。
			// 只重试「真的空」，不重试「已经拿到但列表为空」——后者是宿主如实回答。
			var quick = 0;
			var quickTimer = setInterval(function () {
				if (quick++ >= 5) { clearInterval(quickTimer); return; }
				if (state.rows.length > 0) { clearInterval(quickTimer); return; }
				fetchStatus();
			}, 400);
			var stopQuick = function () {
				clearInterval(quickTimer);
				if (quickTimer) quickTimer = null;
			};
			stopQuickRef = stopQuick;

			return function dispose() {
				if (timer) clearInterval(timer);
				if (stopQuickRef) { stopQuickRef(); stopQuickRef = null; }
				statusSink = null;
				listeners = [];
			};
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-tweaks: status polling and styles");
			// ── 具体补丁开关：设置窗口的**一级分区**（settings.section，「增强补丁」）──
			// 这是开关的权威入口。为什么不用 plugins.bundle.config（插件详情页）：
			// 开关一改 → 写配置 → 插件条目热重载 → 详情页重建 → 界面跳回"只有插件信息"
			// （用户明确反馈的痛点）。settings.section 是设置窗口自己的导航分区，
			// 不挂在插件条目下，不受这条重载链影响，所以 checkbox 可以放心交互。
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: 45,
					label: function () { return "增强补丁"; },
				}, TweaksPage);
			});
			// ── 插件本身的配置：设置 › 插件列表 › dsh-tweaks 详情页（只读说明）──
			// 只留一句指路 + 启用计数，不放开关（理由见 PluginInfo / 上面）。
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_KEY,
				}, PluginInfo);
			});
			// 重启入口只在插件页。侧边栏底部（sidebar.footer.action）试过又撤掉了：
			// 那一行是和 dsh-tap-quota 的余额卡片共用的 flex 行，按钮挤在「设置」旁边
			// 位置不对；而头像菜单（AccountMenu，settings.launcher 的 single 占用者）
			// 没有任何菜单项 slot 可扩展——88 个 slot 里没有「头像菜单项」这种槽。
		}

		exports.STATUS = STATUS;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			toggle: toggle,
		};
		return module.exports;
	},
});
