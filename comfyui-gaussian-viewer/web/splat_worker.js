// SPDX-License-Identifier: MIT
// Copyright (c) 2026 aaljman
//
// Web worker: downloads and parses a Gaussian-splat PLY into the renderer's texture layout, then
// depth-sorts the splats for every new camera. ComfyUI also imports every .js file in web/ as an
// extension, so the body only runs inside a worker.
//
// Texture layout, 2 RGBA32UI texels (8 uint32) per splat, 1024 splats per 2048-texel row:
//   [x, y, z, rgba8]  [scale_x, scale_y, scale_z, quat8888 (w, x, y, z)]
// Positions and scales are float32 bits; colour is sRGB, alpha is the opacity.

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
    const SH_C0 = 0.28209479177387814;
    const SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
                    int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
    const GETTERS = { char: "getInt8", int8: "getInt8", uchar: "getUint8", uint8: "getUint8",
                      short: "getInt16", int16: "getInt16", ushort: "getUint16", uint16: "getUint16",
                      int: "getInt32", int32: "getInt32", uint: "getUint32", uint32: "getUint32",
                      float: "getFloat32", float32: "getFloat32", double: "getFloat64", float64: "getFloat64" };

    let positions = null;   // Float32Array xyz, kept for sorting
    let count = 0;
    let depths = null;
    const counts = new Uint32Array(65536);

    function parseHeader(buf) {
        const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536)));
        const end = head.indexOf("end_header");
        if (!head.startsWith("ply") || end < 0) throw new Error("not a PLY file");
        const lines = head.slice(0, end).split(/\r?\n/);
        if (!lines.some(l => l.startsWith("format binary_little_endian"))) {
            throw new Error("only binary little-endian PLY files are supported");
        }
        const elements = [];
        for (const line of lines) {
            const p = line.trim().split(/\s+/);
            if (p[0] === "element") elements.push({ name: p[1], count: +p[2], props: [], stride: 0 });
            else if (p[0] === "property" && elements.length) {
                if (p[1] === "list") throw new Error("PLY list properties are not supported");
                const el = elements[elements.length - 1];
                el.props.push({ name: p[2], type: p[1], offset: el.stride });
                el.stride += SIZES[p[1]] ?? NaN;
            }
        }
        let offset = head.indexOf("\n", end) + 1;
        for (const el of elements) {
            if (el.name === "vertex") return { ...el, offset };
            offset += el.count * el.stride;
        }
        throw new Error("PLY has no vertex element");
    }

    // prop(name) returns i => value for one vertex property, read through a Float32Array when
    // every property is a float (the usual case) and through a DataView otherwise.
    function reader(buf, v) {
        const col = Object.fromEntries(v.props.map(p => [p.name, p]));
        if (v.props.every(p => p.type === "float" || p.type === "float32")) {
            const aligned = v.offset % 4 === 0;
            const f = new Float32Array(aligned ? buf : buf.slice(v.offset, v.offset + v.count * v.stride),
                                       aligned ? v.offset : 0, v.count * v.stride / 4);
            const w = v.stride / 4;
            return { col, prop: name => { const k = col[name].offset / 4; return i => f[i * w + k]; } };
        }
        const dv = new DataView(buf, v.offset);
        return { col, prop: name => {
            const { offset, type } = col[name];
            const read = dv[GETTERS[type]].bind(dv);
            return i => read(i * v.stride + offset, true);
        } };
    }

    function pack(buf, base) {
        const v = parseHeader(buf);
        const { col, prop } = reader(buf, v);
        for (const k of ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]) {
            if (!col[k]) throw new Error(`not a Gaussian splat PLY (no "${k}" property)`);
        }
        const sh = !!col.f_dc_0;
        if (!sh && !col.red) throw new Error("PLY has no colour (f_dc_* or red/green/blue)");
        const rgbScale = !sh && col.red.type.startsWith("u") && SIZES[col.red.type] === 1 ? 1 / 255 : 1;
        const [X, Y, Z, OP, S0, S1, S2, Q0, Q1, Q2, Q3] = ["x", "y", "z", "opacity", "scale_0", "scale_1",
            "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"].map(prop);
        const [R, G, B] = (sh ? ["f_dc_0", "f_dc_1", "f_dc_2"] : ["red", "green", "blue"]).map(prop);
        const cm = sh ? SH_C0 : rgbScale, ca = sh ? 0.5 : 0;

        const n = v.count;
        const rows = Math.max(1, Math.ceil(n / 1024));
        const u32 = new Uint32Array(rows * 8192);
        const f32 = new Float32Array(u32.buffer);
        const pos = new Float32Array(n * 3);
        const byte = x => Math.max(0, Math.min(255, Math.round(x * 255)));
        for (let i = 0; i < n; i++) {
            const o = i * 8;
            const x = X(i), y = Y(i), z = Z(i);
            pos[3 * i] = f32[o] = x;
            pos[3 * i + 1] = f32[o + 1] = y;
            pos[3 * i + 2] = f32[o + 2] = z;
            const a = 1 / (1 + Math.exp(-OP(i)));
            u32[o + 3] = (byte(ca + cm * R(i)) | byte(ca + cm * G(i)) << 8 | byte(ca + cm * B(i)) << 16 | byte(a) << 24) >>> 0;
            f32[o + 4] = Math.exp(S0(i));
            f32[o + 5] = Math.exp(S1(i));
            f32[o + 6] = Math.exp(S2(i));
            const qw = Q0(i), qx = Q1(i), qy = Q2(i), qz = Q3(i);
            const ql = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1;
            const q = c => Math.max(1, Math.min(255, Math.round(c / ql * 127 + 128)));
            u32[o + 7] = (q(qw) | q(qx) << 8 | q(qy) << 16 | q(qz) << 24) >>> 0;
        }
        return { u32, rows, n, pos, stats: stats(pos, n, base) };
    }

    // Median depth and frustum half-angles of the splats as seen from the photo's camera.
    function stats(pos, n, w2c) {
        const R = w2c || [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
        const step = Math.max(1, Math.floor(n / 60000));
        const zs = [], tx = [], ty = [];
        for (let i = 0; i < n; i += step) {
            const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
            const cz = R[2][0] * x + R[2][1] * y + R[2][2] * z + R[2][3];
            if (!(cz > 1e-4)) continue;
            zs.push(cz);
            tx.push(Math.abs((R[0][0] * x + R[0][1] * y + R[0][2] * z + R[0][3]) / cz));
            ty.push(Math.abs((R[1][0] * x + R[1][1] * y + R[1][2] * z + R[1][3]) / cz));
        }
        const q = (a, f) => a.length ? a.sort((p, r) => p - r)[Math.min(a.length - 1, Math.floor(f * a.length))] : 1;
        return { medianDepth: q(zs, 0.5), tanX: q(tx, 0.998), tanY: q(ty, 0.998) };
    }

    // Back-to-front order for the camera whose forward row is (a, b, c, d): 16-bit counting sort.
    function sort([a, b, c, d]) {
        if (!positions) return { order: new Uint32Array(1), visible: 0 };
        if (!depths || depths.length < count) depths = new Float32Array(count);
        let lo = Infinity, hi = -Infinity, visible = 0;
        for (let i = 0; i < count; i++) {
            const z = a * positions[3 * i] + b * positions[3 * i + 1] + c * positions[3 * i + 2] + d;
            depths[i] = z;
            if (z > 0.01) {
                visible++;
                if (z < lo) lo = z;
                if (z > hi) hi = z;
            }
        }
        const order = new Uint32Array(Math.max(1, visible));
        if (!visible) return { order, visible };
        const scale = 65535 / Math.max(hi - lo, 1e-9);
        counts.fill(0);
        for (let i = 0; i < count; i++) {
            const z = depths[i];
            if (z > 0.01) counts[((hi - z) * scale) | 0]++;
        }
        for (let k = 0, sum = 0; k < 65536; k++) {
            const c0 = counts[k];
            counts[k] = sum;
            sum += c0;
        }
        for (let i = 0; i < count; i++) {
            const z = depths[i];
            if (z > 0.01) order[counts[((hi - z) * scale) | 0]++] = i;
        }
        return { order, visible };
    }

    self.onmessage = async ({ data: m }) => {
        try {
            if (m.type === "load") {
                const t0 = performance.now();
                const res = await fetch(m.url);
                if (!res.ok) throw new Error(`HTTP ${res.status} fetching the PLY`);
                const buf = await res.arrayBuffer();
                const t1 = performance.now();
                const { u32, rows, n, pos, stats } = pack(buf, m.base);
                positions = pos;
                count = n;
                self.postMessage({ type: "loaded", id: m.id, data: u32, rows, count: n, stats,
                                   ms: { fetch: t1 - t0, parse: performance.now() - t1 } }, [u32.buffer]);
            } else if (m.type === "sort") {
                const t0 = performance.now();
                const { order, visible } = sort(m.row);
                self.postMessage({ type: "sorted", id: m.id, order, visible, ms: performance.now() - t0 }, [order.buffer]);
            }
        } catch (err) {
            self.postMessage({ type: "error", id: m.id, error: String(err?.message || err) });
        }
    };
}
