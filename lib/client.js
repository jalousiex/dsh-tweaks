/**
 * dsh-tweaks —— 浏览器半。
 *
 * 贡献：账户菜单里的**开关行**（每个带 target 的 tweak 一行，
 * 点一下 POST /dsh-tweaks/toggle），以及按需的状态刷新。
 *
 * 加载器契约（dsh 硬规则）：本文件**必须**是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧的 `{ id, exports: fn }` 形态会让宿主抛
 * `registered.factory is not a function`，直接崩掉整个 web boot。
 *
 * DOM 纪律（这条是 UI 卡死的根因）：
 *   · 绝不 observe `class`；只用 `childList + subtree` 加窄 attributeFilter；
 *   · 绝不在 mutation 回调里整页扫描 —— 只看新增子树；
 *   · 最多一次 rAF 合帧，按节点用 WeakMap 幂等；
 *   · 宿主 DOM 对不上我们的选择器时就什么都不做（绝不抛错）。
 */

window.__ModuleLoader__.load({
	id: "dsh-tweaks",
	factory: function (require) {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STATUS = "/dsh-tweaks/status";
		var TOGGLE = "/dsh-tweaks/toggle";
		var MARK = "data-dsh-tweaks";
		var REFRESH_MS = 600000;

		var CSS_TEXT = [
			'.dtw-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px}',
			'.dtw-item:hover{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16))}',
			'.dtw-item[disabled]{opacity:.55;cursor:default}',
			'.dtw-check{flex:0 0 auto;width:14px;text-align:center;opacity:.85}',
			'.dtw-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		].join("\n");

		// hideUnroutableModels 的浏览器半：dsh-tap 设置卡里 `cbc-unroutable` 的行
		// 整行隐去；如果某个分组小标题后面只剩死条目（典型是「未启用（4）」），
		// 连标题一起隐去，免得留下空分组和一个数不上的计数。
		// 只用 CSS —— 不动别人的 DOM 节点，不对 class 做 MutationObserver（DOM 纪律）。
		var HIDE_UNROUTABLE_CSS = [
			'.cbc-listrow.cbc-unroutable{display:none!important}',
			'.cbc-scrollbox>p.cbc-subtitle:not(:has(~.cbc-listrow:not(.cbc-unroutable))){display:none!important}',
		].join("\n");

		function styleText() {
			return state.hideUnroutable ? CSS_TEXT + "\n" + HIDE_UNROUTABLE_CSS : CSS_TEXT;
		}

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var wanted = styleText();
			var tag = 'style[data-plugin-css="dsh-tweaks"]';
			var existing = document.querySelector(tag);
			if (existing) {
				if (existing.textContent !== wanted) existing.textContent = wanted;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tweaks");
			el.setAttribute("data-plugin-css", "dsh-tweaks");
			el.textContent = wanted;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// State: 菜单行 = 带 target 的 tweak，或宿主显式声明 menu 的数据类 tweak
		// （restartButton 这类两边都没有的，不进菜单）。
		// ------------------------------------------------------------------
		var state = { rows: [], loaded: false, hideUnroutable: false };
		var decorated = new WeakMap();
		var diag = { sweeps: 0, inserts: 0, toggles: 0 };

		function readTweaks(doc) {
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			var rows = [];
			var hideUnroutable = false;
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (!t || typeof t.id !== "string") continue;
				// 这个开关的浏览器半效果（隐藏死条目行）与它有没有菜单行无关。
				if (t.id === "hideUnroutableModels") hideUnroutable = t.enabled === true;
				if (!(t.menu === true || t.target)) continue;
				rows.push({ id: t.id, title: t.title || t.id, enabled: t.enabled === true });
			}
			return { rows: rows, loaded: true, hideUnroutable: hideUnroutable };
		}

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
						return state;
					});
				})
				.catch(function () {
					state = { rows: [], loaded: true, hideUnroutable: false };
					return state;
				});
		}

		function report(extra) {
			if (typeof fetch !== "function") return;
			var payload = {
				plugin: "dsh-tweaks",
				at: Date.now(),
				state: { rows: state.rows.length, loaded: state.loaded, hideUnroutable: state.hideUnroutable },
				stats: { sweeps: diag.sweeps, inserts: diag.inserts, toggles: diag.toggles },
			};
			for (var k in extra || {}) payload[k] = extra[k];
			try {
				fetch("/dsh-tweaks/diag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					keepalive: true,
				}).catch(function () {});
			} catch (e) {}
		}

		// ------------------------------------------------------------------
		// Rendering: one row per tweak inside the account/status menu.
		// ------------------------------------------------------------------
		function makeRow(row) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute(MARK, "");
			btn.setAttribute("role", "menuitemcheckbox");
			btn.setAttribute("aria-checked", row.enabled ? "true" : "false");
			btn.className = "dtw-item";

			var mark = document.createElement("span");
			mark.className = "dtw-check";
			mark.textContent = row.enabled ? "☑" : "☐";

			var label = document.createElement("span");
			label.className = "dtw-label";
			label.textContent = row.title;

			btn.appendChild(mark);
			btn.appendChild(label);

			btn.addEventListener("click", function (e) {
				e.preventDefault();
				e.stopPropagation();
				if (btn.disabled) return;
				btn.disabled = true;
				var next = !row.enabled;
				fetch(TOGGLE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: row.id, enabled: next }),
				})
					.then(function (r) {
						return r.text();
					})
					.then(function () {
						diag.toggles++;
						// 宿主写盘后由 hmr 重新应用，稍等一下再取状态。
						return new Promise(function (resolve) {
							setTimeout(resolve, 600);
						}).then(fetchStatus);
					})
					.then(function () {
						renderAll();
					})
					.catch(function () {
						btn.disabled = false;
					});
			});

			return btn;
		}

		/** Candidate containers, most specific first. Empty = nothing to do. */
		function findContainers(root) {
			if (!root || !root.querySelectorAll) return [];
			var out = [];
			var selectors = ['[role="menu"]', '[class*="_menu"]', '[class*="_popover"]'];
			for (var i = 0; i < selectors.length; i++) {
				var found = root.querySelectorAll(selectors[i]);
				for (var j = 0; j < found.length; j++) {
					if (found[j].getAttribute(MARK + "-host")) continue;
					out.push(found[j]);
				}
				if (out.length) break;
			}
			return out;
		}

		function decorate(container) {
			if (!container || !state.rows.length) return;
			var prev = decorated.get(container);
			if (prev && prev.length && prev.every(function (n) { return n.parentNode === container; })) return;
			try {
				// 菜单节点会复用：先清掉上一轮的开关行，避免 ✅ 残留。
				for (var i = 0; i < container.children.length; i++) {
					var child = container.children[i];
					if (child && child.getAttribute && child.getAttribute(MARK) !== null) {
						container.removeChild(child);
						i--;
					}
				}
				var nodes = [];
				for (var r = 0; r < state.rows.length; r++) {
					var node = makeRow(state.rows[r]);
					container.appendChild(node);
					nodes.push(node);
				}
				container.setAttribute(MARK + "-host", "");
				decorated.set(container, nodes);
				diag.inserts++;
			} catch (e) {
				// host-owned DOM changed shape; skip silently
			}
		}

		function collect(node) {
			if (!node || node.nodeType !== 1) return;
			try {
				var found = findContainers(node);
				for (var i = 0; i < found.length; i++) decorate(found[i]);
			} catch (e) {}
		}

		function renderAll() {
			try {
				// 样式表内容随状态变化（hideUnroutable 开/关），每次重渲染前对齐一次。
				ensureStyles();
				var found = findContainers(document);
				for (var i = 0; i < found.length; i++) decorate(found[i]);
			} catch (e) {}
		}

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var raf = 0;
			var timer = null;
			var observer = null;

			function schedule() {
				if (raf) return;
				var run = function () {
					raf = 0;
					if (typeof document !== "undefined" && document.hidden) return;
					if (observer) observer.disconnect();
					try {
						diag.sweeps++;
						renderAll();
					} finally {
						if (observer) observe();
					}
				};
				raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 16);
			}

			function observe() {
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["aria-expanded", "aria-label"],
				});
			}

			function onMutations(records) {
				var touched = false;
				for (var i = 0; i < records.length; i++) {
					var rec = records[i];
					if (rec.type === "attributes") {
						touched = true;
						continue;
					}
					for (var j = 0; j < rec.addedNodes.length; j++) collect(rec.addedNodes[j]);
					if (rec.addedNodes.length) touched = true;
				}
				if (touched) schedule();
			}

			fetchStatus().then(function () {
				renderAll();
				report({ event: "install" });
			});

			timer = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				fetchStatus().then(renderAll);
			}, REFRESH_MS);

			observer = new MutationObserver(onMutations);
			observe();

			return function dispose() {
				if (timer) clearInterval(timer);
				if (raf) {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
					else clearTimeout(raf);
				}
				if (observer) observer.disconnect();
				try {
					var mine = document.querySelectorAll("button[" + MARK + "]");
					for (var i = 0; i < mine.length; i++) {
						if (mine[i].parentNode) mine[i].parentNode.removeChild(mine[i]);
					}
				} catch (e) {}
				decorated = new WeakMap();
			};
		}

		var inject = [];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-tweaks: toggle rows");
		}

		exports.STATUS = STATUS;
		exports.TOGGLE = TOGGLE;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			findContainers: findContainers,
			styleText: styleText,
			HIDE_UNROUTABLE_CSS: HIDE_UNROUTABLE_CSS,
		};
		return module.exports;
	},
});
