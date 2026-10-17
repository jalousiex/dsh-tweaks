/**
 * Browser half of dsh-tweaks.
 *
 * Currently contributes one thing: a **restart menu item**, rendered only when
 * the host says the `restartButton` tweak is on. Everything else this plugin
 * does is host-side config patching, which the browser never needs to see.
 *
 * Loader contract (dsh hard rule): this file MUST be
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * The old `{ id, exports: fn }` shape makes the host throw
 * `registered.factory is not a function` and kills the whole web boot.
 *
 * DOM discipline (the rule that keeps the UI from freezing):
 *   - never observe `class`; only `childList + subtree` and a narrow attributeFilter
 *   - never scan the whole document from a mutation callback — only the added subtree
 *   - one rAF-coalesced pass at most, per-node idempotency via WeakMap
 *   - if the host DOM does not match our selectors, do nothing (never throw)
 */

window.__ModuleLoader__.load({
	id: "dsh-tweaks",
	factory: function (require) {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STATUS = "/dsh-tweaks/status";
		var RESTART = "/dsh-tweaks/restart";
		var MARK = "data-dsh-tweaks";
		var REFRESH_MS = 600000;

		var CSS_TEXT = [
			'.dtw-item{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px}',
			'.dtw-item:hover{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16))}',
			'.dtw-item[disabled]{opacity:.55;cursor:default}',
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-tweaks"]';
			var existing = document.querySelector(tag);
			if (existing) {
				if (existing.textContent !== CSS_TEXT) existing.textContent = CSS_TEXT;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tweaks");
			el.setAttribute("data-plugin-css", "dsh-tweaks");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// State: what the host reports. `tweaks` is keyed by id.
		// ------------------------------------------------------------------
		var state = { restart: false, loaded: false };
		var decorated = new WeakMap();
		var diag = { sweeps: 0, inserts: 0 };

		function readTweaks(doc) {
			var next = { restart: false };
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (t && t.id === "restartButton" && t.enabled === true) next.restart = true;
			}
			return next;
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
						state.loaded = true;
						return state;
					});
				})
				.catch(function () {
					// Host unreachable: leave everything off rather than guessing.
					state = { restart: false, loaded: true };
					return state;
				});
		}

		function report(extra) {
			if (typeof fetch !== "function") return;
			var payload = {
				plugin: "dsh-tweaks",
				at: Date.now(),
				state: { restart: state.restart, loaded: state.loaded },
				stats: { sweeps: diag.sweeps, inserts: diag.inserts },
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
		// Rendering: one menu item, inserted into the account/status menu when
		// the host has the tweak on. Placement is best-effort by attribute or
		// known slot container; when nothing matches we simply do not render.
		// ------------------------------------------------------------------
		function makeItem() {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute(MARK, "");
			btn.setAttribute("role", "menuitem");
			btn.className = "dtw-item";
			btn.textContent = "重启 DeepSeek Harness";
			btn.addEventListener("click", function () {
				btn.disabled = true;
				btn.textContent = "正在重启…";
				fetch(RESTART, { method: "POST" }).catch(function () {
					btn.disabled = false;
					btn.textContent = "重启 DeepSeek Harness";
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
			if (!state.restart || !container) return;
			var prev = decorated.get(container);
			if (prev && prev.parentNode === container) return;
			try {
				container.appendChild(makeItem());
				container.setAttribute(MARK + "-host", "");
				decorated.set(container, makeItem());
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

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var raf = 0;
			var timer = null;
			var observer = null;

			function sweepAll() {
				diag.sweeps++;
				try {
					var found = findContainers(document);
					for (var i = 0; i < found.length; i++) decorate(found[i]);
				} catch (e) {}
			}

			function schedule() {
				if (raf) return;
				var run = function () {
					raf = 0;
					if (typeof document !== "undefined" && document.hidden) return;
					if (observer) observer.disconnect();
					try {
						sweepAll();
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
				if (state.restart) sweepAll();
				report({ event: "install" });
			});

			timer = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				fetchStatus().then(function (s) {
					if (s.restart) sweepAll();
				});
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
			}, "dsh-tweaks: restart entry");
		}

		exports.STATUS = STATUS;
		exports.RESTART = RESTART;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			findContainers: findContainers,
		};
		return module.exports;
	},
});
