// SPDX-License-Identifier: MIT
// Copyright (c) 2026 aaljman
//
// The GaussianViewer node's frontend: a splat view inside the node, orbit / pan / fly controls,
// and Set Camera, which stores the camera in the node's hidden `camera` widget. When the node runs
// with a camera it has not rendered yet, the server asks this tab to render it (render request).
//
// Camera model, OpenCV axes (x right, y down, z forward): the photo's camera is the base (R, C);
// the view orbits a target at `dist` with yaw / pitch / roll applied on top of the base rotation,
// so reset (all zero, dist = median splat depth) is exactly the photo's camera.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { SplatRenderer } from "./splat_renderer.js";

const RATIOS = ["source", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];
const CONTROLS_KEY = "gaussian_viewer.controls";
const KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "KeyZ", "KeyC",
                      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

// 3x3 matrices are row-major arrays of 9.
const mul3 = (a, b) => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]));
const apply3 = (m, v) => [0, 1, 2].map(i => m[3 * i] * v[0] + m[3 * i + 1] * v[1] + m[3 * i + 2] * v[2]);
const add3 = (a, b, k = 1) => a.map((x, i) => x + b[i] * k);
const rotX = t => [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
const rotY = t => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
const rotZ = t => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
const round = x => Math.round(x * 1e6) / 1e6;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// World-to-camera as 4x4 nested rows (for the node outputs) from a camera-to-world rotation and position.
function w2cRows(R, C) {
    const t = [0, 1, 2].map(i => -(R[i] * C[0] + R[3 + i] * C[1] + R[6 + i] * C[2]));
    return [[R[0], R[3], R[6], t[0]], [R[1], R[4], R[7], t[1]], [R[2], R[5], R[8], t[2]], [0, 0, 0, 1]].map(r => r.map(round));
}
const columnMajor = rows => new Float32Array([0, 1, 2, 3].flatMap(j => rows.map(r => r[j])));
// The numbers that decide the output; views restored from rounded JSON differ by ~1e-6.
const cameraKey = cam => [...cam.w2c.flat(), ...cam.K.flat(), cam.width, cam.height];
const sameCamera = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-4 * Math.max(1, Math.abs(b[i])));

const CSS = `
.gv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#0d0d0d;color:#cfcfcf;font:11px/1.35 system-ui,"Segoe UI",sans-serif;border-radius:6px;overflow:hidden}
.gv-stage{position:relative;flex:1 1 0;min-height:0;overflow:hidden}
.gv-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;cursor:grab;touch-action:none}
.gv-stage canvas.gv-drag{cursor:grabbing}
.gv-frame{position:absolute;pointer-events:none;outline:1px solid rgba(255,255,255,.45);box-shadow:0 0 0 9999px rgba(0,0,0,.5);display:none}
.gv-overlay{position:absolute;pointer-events:none;opacity:0;display:none}
.gv-hud{position:absolute;left:8px;top:6px;right:38px;pointer-events:none;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gv-hud div{overflow:hidden;text-overflow:ellipsis}
.gv-dim{color:#8a8a8a}.gv-ok{color:#7fd1a8}.gv-warn{color:#e6b450}.gv-err{color:#ff7b72;white-space:normal}
.gv-info{position:absolute;right:6px;top:6px;width:22px;height:22px;border-radius:50%;border:1px solid #5a5a5a;background:rgba(20,20,20,.8);color:#ddd;font:italic 600 13px/20px Georgia,serif;cursor:pointer;padding:0}
.gv-info:hover{border-color:#8a8a8a}
.gv-root.gv-open .gv-info{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
.gv-bar{display:none;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px;background:#1b1b1b;border-top:1px solid #2c2c2c}
.gv-root.gv-open .gv-bar{display:flex}
.gv-bar button{background:#333;color:#eee;border:1px solid #474747;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
.gv-bar button:hover{background:#3e3e3e}
.gv-bar button.gv-primary{background:#3b5bdb;border-color:#3b5bdb;color:#fff;font-weight:600}
.gv-bar button.gv-primary:hover{background:#4c6ef5}
.gv-bar button:disabled{opacity:.45;cursor:default}
.gv-bar label{display:inline-flex;align-items:center;gap:4px;color:#9a9a9a}
.gv-bar input[type=range]{width:84px;margin:0}
.gv-bar select{background:#262626;color:#ddd;border:1px solid #474747;border-radius:4px;font:inherit;padding:1px 4px}
.gv-num{min-width:3.2em;color:#ccc;font-variant-numeric:tabular-nums}
.gv-help{flex-basis:100%;color:#8a8a8a}.gv-help b{color:#c4c4c4;font-weight:600}
`;

function el(tag, cls, props = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return Object.assign(e, props);
}

function readControlsOpen() {
    try { return localStorage.getItem(CONTROLS_KEY) === "1"; } catch { return false; }
}

class Viewer {
    constructor(node, cameraWidget) {
        this.node = node;
        this.cameraWidget = cameraWidget;
        this.ply = null;          // info of the PLY shown (from the node's output)
        this.loading = null;      // promise of the current load
        this.base = null;         // the photo's camera
        this.view = null;         // { target, dist, yaw, pitch, roll, zoom }
        this.ratio = "source";
        this.held = new Set();
        this.raf = 0;
        this.gen = 0;             // bumps on every loaded PLY; sorts for older data are dropped
        this.sortSeq = 0;
        this.sortWaiters = new Map();
        this.loadWaiter = null;

        this.buildDom();
        try {
            this.renderer = new SplatRenderer(this.canvas);
        } catch (err) {
            this.renderer = null;
            this.setMessage(`Cannot start the viewer: ${err.message}`, "gv-err");
        }
        this.worker = new Worker(new URL("./splat_worker.js", import.meta.url));
        this.worker.onmessage = e => this.onWorker(e.data);
        this.onRender = e => this.onRenderRequest(e.detail);
        api.addEventListener("gaussian_viewer.render", this.onRender);
        this.resizeObserver = new ResizeObserver(() => this.invalidate());
        this.resizeObserver.observe(this.stage);
        this.restore();
    }

    buildDom() {
        if (!document.getElementById("gaussian-viewer-css")) {
            document.head.append(el("style", "", { id: "gaussian-viewer-css", textContent: CSS }));
        }
        this.root = el("div", "gv-root");
        this.stage = el("div", "gv-stage");
        this.canvas = el("canvas", "", { tabIndex: 0 });
        this.frameBox = el("div", "gv-frame");
        this.overlay = el("img", "gv-overlay", { alt: "" });
        this.hud = el("div", "gv-hud");
        this.hudFile = el("div", "gv-dim", { textContent: "Run the node to load a splat." });
        this.hudState = el("div");
        this.hud.append(this.hudFile, this.hudState);
        this.infoButton = el("button", "gv-info", { textContent: "i", title: "Show or hide the controls and help" });
        this.stage.append(this.canvas, this.overlay, this.frameBox, this.hud, this.infoButton);

        const bar = el("div", "gv-bar");
        const reset = el("button", "", { textContent: "Reset", title: "Back to the photo's camera" });
        this.zoom = el("input", "", { type: "range", min: 0.2, max: 3, step: 0.01, value: 1, title: "Focal length (zoom without moving)" });
        this.zoomText = el("span", "gv-num", { textContent: "1.00×" });
        const zoomLabel = el("label", "", { textContent: "Zoom" });
        zoomLabel.append(this.zoom, this.zoomText);
        this.ratioSelect = el("select", "", { title: "Output aspect ratio (crops the photo's frame)" });
        for (const r of RATIOS) this.ratioSelect.append(el("option", "", { value: r, textContent: r === "source" ? "Photo" : r }));
        const ratioLabel = el("label", "", { textContent: "Ratio" });
        ratioLabel.append(this.ratioSelect);
        this.overlayAlpha = el("input", "", { type: "range", min: 0, max: 1, step: 0.01, value: 0, title: "Show the reference image over the view (lines up at the photo's camera)" });
        this.overlayLabel = el("label", "", { textContent: "Overlay" });
        this.overlayLabel.append(this.overlayAlpha);
        this.overlayLabel.style.display = "none";
        this.setButton = el("button", "gv-primary", { textContent: "Set Camera", title: "Use this view as the node's output (Enter)", disabled: true });
        const help = el("div", "gv-help");
        help.innerHTML = "<b>Drag</b> orbit · <b>Right-drag</b> or <b>Shift-drag</b> pan · <b>Wheel</b> dolly · "
            + "<b>W A S D</b> move · <b>Arrows</b> pan · <b>Q E</b> turn · <b>R F</b> look up / down · <b>Z C</b> roll · "
            + "<b>Shift</b> fine · <b>Enter</b> Set Camera. The node outputs the set camera's view when you queue.";
        bar.append(reset, zoomLabel, ratioLabel, this.overlayLabel, this.setButton, help);
        this.root.append(this.stage, bar);
        this.root.classList.toggle("gv-open", readControlsOpen());

        this.infoButton.addEventListener("click", () => {
            const open = this.root.classList.toggle("gv-open");
            try { localStorage.setItem(CONTROLS_KEY, open ? "1" : "0"); } catch { /* storage blocked */ }
            this.invalidate();
        });
        reset.addEventListener("click", () => this.reset());
        this.setButton.addEventListener("click", () => this.setCamera());
        this.zoom.addEventListener("input", () => {
            if (!this.view) return;
            this.view.zoom = +this.zoom.value;
            this.changed();
        });
        this.ratioSelect.addEventListener("change", () => { this.ratio = this.ratioSelect.value; this.invalidate(); });
        this.overlayAlpha.addEventListener("input", () => { this.overlay.style.opacity = this.overlayAlpha.value; });
        this.bindInput();
    }

    bindInput() {
        const c = this.canvas;
        let drag = null;
        c.addEventListener("contextmenu", e => e.preventDefault());
        c.addEventListener("pointerdown", e => {
            c.focus({ preventScroll: true });
            if (!this.view) return;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
            c.setPointerCapture(e.pointerId);
            c.classList.add("gv-drag");
            e.preventDefault();
            e.stopPropagation();
        });
        c.addEventListener("pointermove", e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            drag.x = e.clientX;
            drag.y = e.clientY;
            const fine = e.altKey ? 0.1 : 1;
            if (drag.pan) {
                const { R } = this.pose();
                const perPx = this.view.dist / this.display.fx * (c.width / c.getBoundingClientRect().width);
                this.view.target = add3(this.view.target, apply3(R, [-dx, -dy, 0]), perPx * fine);
            } else {
                this.view.yaw += dx * 0.005 * fine;
                this.view.pitch = clamp(this.view.pitch - dy * 0.005 * fine, -1.55, 1.55);
            }
            this.changed();
            e.stopPropagation();
        });
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null;
            c.classList.remove("gv-drag");
        };
        c.addEventListener("pointerup", end);
        c.addEventListener("pointercancel", end);
        c.addEventListener("wheel", e => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.view) return;
            const v = this.view, b = this.base;
            const step = (e.deltaMode === 1 ? 33 : 1) * e.deltaY * (e.shiftKey ? 0.0001 : 0.001);
            const minDist = b.depth * 0.02;
            if (step < 0 && v.dist <= minDist * 1.001) {
                // Already at the target: carry it forward so the camera keeps moving in.
                v.target = add3(v.target, apply3(this.pose().R, [0, 0, 1]), -step * b.depth);
            } else {
                v.dist = Math.max(minDist, v.dist * Math.exp(step));
            }
            this.changed();
        }, { passive: false });
        c.addEventListener("keydown", e => {
            if (e.code === "Enter") {
                this.setCamera();
            } else if (KEYS.has(e.code)) {
                this.held.add(e.code);
                this.invalidate();
            } else if (!e.code.startsWith("Shift")) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
        });
        c.addEventListener("keyup", e => {
            this.held.delete(e.code);
            if (KEYS.has(e.code)) e.stopPropagation();
        });
        c.addEventListener("blur", () => this.held.clear());
        this.fine = false;
        c.addEventListener("keydown", e => { this.fine = e.shiftKey; });
        c.addEventListener("keyup", e => { this.fine = e.shiftKey; });
    }

    // --- camera ---

    pose(view = this.view) {
        const R = mul3(mul3(mul3(this.base.R, rotY(view.yaw)), rotX(view.pitch)), rotZ(view.roll));
        return { R, C: add3(view.target, apply3(R, [0, 0, 1]), -view.dist) };
    }

    // The output image: the photo's frame cropped to the ratio, focal scaled by zoom.
    outputFrame() {
        const b = this.base;
        let w = b.width, h = b.height;
        if (this.ratio !== "source") {
            const [rw, rh] = this.ratio.split(":").map(Number);
            if (w / h > rw / rh) w = Math.round(h * rw / rh); else h = Math.round(w * rh / rw);
        }
        const z = this.view.zoom;
        return { w, h, fx: b.fx * z, fy: b.fy * z, cx: b.cx - (b.width - w) / 2, cy: b.cy - (b.height - h) / 2 };
    }

    currentCamera() {
        const f = this.outputFrame();
        const { R, C } = this.pose();
        return {
            w2c: w2cRows(R, C),
            K: [[f.fx, 0, f.cx], [0, f.fy, f.cy], [0, 0, 1]].map(r => r.map(round)),
            width: f.w,
            height: f.h,
            ratio: this.ratio,
            view: Object.fromEntries(Object.entries(this.view).map(([k, v]) => [k, Array.isArray(v) ? v.map(round) : round(v)])),
        };
    }

    setBase(ply, stats) {
        const K = ply.intrinsics;
        let fx, fy, cx, cy, width, height;
        if (K && K[0][0] > 0 && K[0][2] > 0 && K[1][2] > 0) {
            [fx, fy, cx, cy] = [K[0][0], K[1][1], K[0][2], K[1][2]];
            [width, height] = [Math.round(2 * cx), Math.round(2 * cy)];
        } else {
            // No intrinsics: rebuild the photo's frustum from the splats, 1024 px on the long side.
            const aspect = stats.tanX / stats.tanY;
            [width, height] = aspect >= 1 ? [1024, Math.round(1024 / aspect)] : [Math.round(1024 * aspect), 1024];
            fx = fy = width / 2 / stats.tanX;
            [cx, cy] = [width / 2, height / 2];
        }
        const E = ply.extrinsics;
        const R = E ? [E[0][0], E[1][0], E[2][0], E[0][1], E[1][1], E[2][1], E[0][2], E[1][2], E[2][2]] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const C = E ? apply3(R, [-E[0][3], -E[1][3], -E[2][3]]) : [0, 0, 0];
        this.base = { R, C, fx, fy, cx, cy, width, height, depth: Math.max(0.05, stats.medianDepth) };
    }

    reset() {
        if (!this.base) return;
        const b = this.base;
        this.view = { target: add3(b.C, apply3(b.R, [0, 0, b.depth])), dist: b.depth, yaw: 0, pitch: 0, roll: 0, zoom: 1 };
        this.zoom.value = 1;
        this.changed();
    }

    applyKeys(dt) {
        const v = this.view, h = this.held;
        const k = (this.fine ? 0.1 : 1) * dt;
        const axis = (plus, minus) => (h.has(plus) ? 1 : 0) - (h.has(minus) ? 1 : 0);
        const move = [axis("KeyD", "KeyA") + axis("ArrowRight", "ArrowLeft"), axis("ArrowDown", "ArrowUp"), axis("KeyW", "KeyS")];
        if (move.some(Boolean)) v.target = add3(v.target, apply3(this.pose().R, move), 0.5 * this.base.depth * k);
        const turn = axis("KeyE", "KeyQ"), look = axis("KeyR", "KeyF"), roll = axis("KeyC", "KeyZ");
        if (turn || look) {
            // Turn about the camera itself, not the target.
            const { C } = this.pose();
            v.yaw += turn * 1.0 * k;
            v.pitch = clamp(v.pitch + look * 1.0 * k, -1.55, 1.55);
            v.target = add3(C, apply3(this.pose().R, [0, 0, 1]), v.dist);
        }
        if (roll) v.roll += roll * 0.8 * k;
        this.changed();
    }

    changed() {
        this.requestSort();
        this.invalidate();
    }

    setCamera() {
        if (!this.view) {
            this.setMessage("Run the node first, so there is a splat to frame.", "gv-warn");
            return;
        }
        const cam = this.currentCamera();
        this.stored = cameraKey(cam);
        this.cameraWidget.value = JSON.stringify(cam);
        this.cameraWidget.callback?.(this.cameraWidget.value);
        this.node.setDirtyCanvas?.(true, true);
        this.invalidate();
    }

    // Read the camera saved in the workflow; its view is applied when the PLY loads.
    restore() {
        try {
            const cam = this.cameraWidget?.value ? JSON.parse(this.cameraWidget.value) : null;
            this.stored = cam ? cameraKey(cam) : null;
            this.savedView = cam?.view ?? null;
            this.ratio = RATIOS.includes(cam?.ratio) ? cam.ratio : "source";
            this.ratioSelect.value = this.ratio;
        } catch {
            this.stored = this.savedView = null;
        }
        if (this.savedView && this.base) {
            this.view = { ...this.savedView };
            this.zoom.value = this.view.zoom;
            this.changed();
        }
    }

    // --- loading, sorting, drawing ---

    show(info) {
        if (info.overlay !== undefined) {
            const o = info.overlay;
            this.overlay.style.display = o ? "block" : "none";
            this.overlayLabel.style.display = o ? "" : "none";
            if (o) this.overlay.src = api.apiURL(`/view?filename=${encodeURIComponent(o.filename)}&type=${o.type}&subfolder=${encodeURIComponent(o.subfolder || "")}`);
        }
        if (this.ply?.token === info.token && this.loading) return this.loading;
        this.ply = info;
        this.hudFile.className = "gv-dim";
        this.hudFile.textContent = `Loading ${info.name} (${info.size_mb} MB)…`;
        this.loading = new Promise((resolve, reject) => { this.loadWaiter = { resolve, reject, token: info.token }; });
        this.loading.catch(() => {});
        this.worker.postMessage({ type: "load", id: info.token, url: new URL(api.apiURL(info.url), location.href).href,
                                  base: info.extrinsics });
        return this.loading;
    }

    onWorker(m) {
        if (m.type === "loaded") {
            if (!this.loadWaiter || m.id !== this.loadWaiter.token) return;
            const first = !this.base;
            this.renderer?.setSplats(m.data, m.rows);
            this.gen++;
            this.setBase(this.ply, m.stats);
            if (this.savedView && !this.view) {
                this.view = { ...this.savedView };
                this.zoom.value = this.view.zoom;
            } else if (first || !this.view) {
                this.reset();
            }
            this.setButton.disabled = false;
            this.hudFile.className = "";
            this.hudFile.textContent = `${this.ply.name} · ${(m.count / 1e6).toFixed(2)}M splats`;
            this.hudFile.title = `download ${m.ms.fetch.toFixed(0)} ms, parse ${m.ms.parse.toFixed(0)} ms`;
            this.changed();
            this.loadWaiter.resolve();
            this.loadWaiter = null;
        } else if (m.type === "sorted") {
            const w = this.sortWaiters.get(m.id);
            this.sortWaiters.delete(m.id);
            if (w?.gen === this.gen) {
                this.renderer?.setOrder(m.order, m.visible);
                this.sortMs = m.ms;
            }
            w?.resolve();
            this.invalidate();
        } else if (m.type === "error") {
            if (this.loadWaiter && m.id === this.loadWaiter.token) {
                this.loadWaiter.reject(new Error(m.error));
                this.loadWaiter = null;
                this.loading = null;
                this.ply = null;
            } else {
                this.sortWaiters.get(m.id)?.resolve();
                this.sortWaiters.delete(m.id);
            }
            this.setMessage(m.error, "gv-err");
        }
    }

    sortNow(rows) {
        const id = ++this.sortSeq;
        return new Promise(resolve => {
            this.sortWaiters.set(id, { resolve, gen: this.gen });
            this.worker.postMessage({ type: "sort", id, row: rows[2] });
        });
    }

    // Keep at most one sort for the live view in flight; the latest view wins.
    requestSort() {
        if (!this.view || !this.base) return;
        if (this.sorting) { this.sortAgain = true; return; }
        this.sorting = true;
        const { R, C } = this.pose();
        this.sortNow(w2cRows(R, C)).then(() => {
            this.sorting = false;
            if (this.sortAgain) { this.sortAgain = false; this.requestSort(); }
        });
    }

    invalidate() {
        if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t));
    }

    frame(t) {
        this.raf = 0;
        if (this.held.size && this.view) {
            this.applyKeys(this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 1 / 60);
            this.lastT = t;
        } else {
            this.lastT = 0;
        }
        this.draw();
    }

    draw() {
        const c = this.canvas;
        const rect = c.getBoundingClientRect();
        if (!this.renderer || !this.view || rect.width < 2 || rect.height < 2) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.min(4096, Math.round(rect.width * dpr)), h = Math.min(4096, Math.round(rect.height * dpr));
        if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];

        // Fit the output frame inside the canvas; draw the whole canvas with the same camera.
        const f = this.outputFrame();
        const k = Math.min(w / f.w, h / f.h);
        this.display = { fx: f.fx * k, fy: f.fy * k, cx: w / 2 + (f.cx - f.w / 2) * k, cy: h / 2 + (f.cy - f.h / 2) * k };
        const { R, C } = this.pose();
        this.renderer.draw(columnMajor(w2cRows(R, C)), [this.display.fx, this.display.fy, this.display.cx, this.display.cy], w, h);

        const s = c.clientWidth / w;   // drawing-buffer px -> layout px
        const box = { left: `${(w - f.w * k) / 2 * s}px`, top: `${(h - f.h * k) / 2 * s}px`,
                      width: `${f.w * k * s}px`, height: `${f.h * k * s}px` };
        Object.assign(this.frameBox.style, box, { display: "block" });
        Object.assign(this.overlay.style, box);
        this.zoomText.textContent = `${this.view.zoom.toFixed(2)}×`;
        this.updateState();
    }

    updateState() {
        if (this.message) return;
        const set = this.stored && sameCamera(cameraKey(this.currentCamera()), this.stored);
        this.hudState.className = set ? "gv-ok" : this.stored ? "gv-warn" : "gv-dim";
        this.hudState.textContent = set ? "✓ Camera set — queue to render this view"
            : this.stored ? "View moved — Set Camera (Enter) to use it"
            : `No camera set — frame a view and press Set Camera (Enter)${this.root.classList.contains("gv-open") ? "" : ", or ⓘ for controls"}`;
    }

    setMessage(text, cls) {
        this.message = text;
        this.hudState.className = cls;
        this.hudState.textContent = text;
        clearTimeout(this.messageTimer);
        this.messageTimer = setTimeout(() => { this.message = null; this.updateState(); }, 6000);
    }

    // --- server render requests ---

    async onRenderRequest(d) {
        if (!d || String(d.node).split(":").pop() !== String(this.node.id)) return;
        const accept = await api.fetchApi(`/gaussian_viewer/accept/${d.request}`, { method: "POST" });
        if (!accept.ok) return;   // another tab took it
        const reply = (query, init) => api.fetchApi(`/gaussian_viewer/result/${d.request}${query}`, { method: "POST", ...init });
        try {
            if (!this.renderer) throw new Error("WebGL2 is not available in this browser");
            await this.show(d.ply);
            const cam = JSON.parse(d.camera);
            const max = this.renderer.maxSize;
            if (cam.width > max || cam.height > max) throw new Error(`output ${cam.width}x${cam.height} exceeds the GPU limit ${max}`);
            await this.sortNow(cam.w2c);
            const K = cam.K;
            const px = this.renderer.capture(columnMajor(cam.w2c), [K[0][0], K[1][1], K[0][2], K[1][2]], cam.width, cam.height);
            this.requestSort();
            this.invalidate();
            await reply(`?w=${cam.width}&h=${cam.height}`, { body: px, headers: { "Content-Type": "application/octet-stream" } });
        } catch (err) {
            await reply("", { body: JSON.stringify({ error: String(err?.message || err) }), headers: { "Content-Type": "application/json" } });
        }
    }

    dispose() {
        cancelAnimationFrame(this.raf);
        api.removeEventListener("gaussian_viewer.render", this.onRender);
        this.resizeObserver.disconnect();
        this.worker.terminate();
        this.renderer?.dispose();
    }
}

app.registerExtension({
    name: "gaussian_viewer.viewer",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "GaussianViewer") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const camera = this.widgets?.find(w => w.name === "camera");
            if (camera) {
                camera.hidden = true;
                camera.computeSize = () => [0, -4];
            }
            this.gaussianViewer = new Viewer(this, camera);
            // hideInPanel: otherwise selecting the node moves the viewer into the properties panel,
            // which leaves it at the panel's width on the canvas (as ComfyUI's own 3D viewers do).
            const viewer = this.addDOMWidget("viewer", "gaussian_viewer", this.gaussianViewer.root,
                                             { serialize: false, hideInPanel: true, getMinHeight: () => 220 });
            viewer.serialize = false;   // keep it out of widgets_values, or the saved camera is not restored

            this.setSize([Math.max(this.size[0], 520), Math.max(this.size[1], 560)]);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.gaussianViewer?.restore();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            onExecuted?.apply(this, arguments);
            const info = output?.gaussian_viewer?.[0];
            if (info) this.gaussianViewer?.show(info).catch(() => {});
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.gaussianViewer?.dispose();
            return onRemoved?.apply(this, arguments);
        };
    },
});
