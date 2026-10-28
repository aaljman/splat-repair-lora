// SPDX-License-Identifier: MIT
// Copyright (c) 2026 aaljman
//
// WebGL2 Gaussian-splat renderer (3DGS EWA splatting). One instanced quad per splat, read from the
// worker's packed texture in the worker's back-to-front order. Splats are blended in linear light
// into a half-float target, then resolved to sRGB, which is how SHARP's own renderer composites;
// without float render targets it falls back to blending sRGB in an 8-bit target.
//
// Cameras use OpenCV axes: view = 4x4 world-to-camera (column-major), cam = [fx, fy, cx, cy] in
// pixels of the target being drawn.

const SPLAT_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uData;
uniform mat4 uView;
uniform vec4 uCam;
uniform vec2 uSize;
uniform bool uLinear;
in vec2 aCorner;
in uint aIndex;
out vec4 vColor;
out vec2 vPos;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

void main() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // outside the clip volume unless replaced below
    ivec2 t = ivec2(int(aIndex & 1023u) << 1, int(aIndex >> 10));
    uvec4 a = texelFetch(uData, t, 0);
    uvec4 b = texelFetch(uData, t + ivec2(1, 0), 0);
    vec3 p = (uView * vec4(uintBitsToFloat(a.xyz), 1.0)).xyz;
    if (p.z < 0.01) return;
    float opacity = float(a.w >> 24) / 255.0;
    if (opacity < 1.0 / 255.0) return;

    vec4 q = normalize((vec4(uvec4(b.w, b.w >> 8, b.w >> 16, b.w >> 24) & 255u) - 128.0) / 127.0);
    float w = q.x, x = q.y, y = q.z, z = q.w;
    mat3 rot = mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
                    2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
                    2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
    vec3 s = uintBitsToFloat(b.xyz);
    mat3 m = mat3(uView) * rot * mat3(s.x, 0.0, 0.0, 0.0, s.y, 0.0, 0.0, 0.0, s.z);

    // Perspective Jacobian at the splat centre, with the centre clamped near the frustum as 3DGS does.
    vec2 lim = 1.3 * max(uCam.zw, uSize - uCam.zw) / uCam.xy;
    vec2 tc = clamp(p.xy / p.z, -lim, lim) * p.z;
    float iz = 1.0 / p.z;
    mat3 J = mat3(uCam.x * iz, 0.0, 0.0, 0.0, uCam.y * iz, 0.0,
                  -uCam.x * tc.x * iz * iz, -uCam.y * tc.y * iz * iz, 0.0);
    mat3 T = J * m;
    mat3 cov = T * transpose(T);
    float ca = cov[0][0] + 0.3, cb = cov[0][1], cc = cov[1][1] + 0.3;

    float mid = 0.5 * (ca + cc);
    float rad = length(vec2(0.5 * (ca - cc), cb));
    float l1 = mid + rad, l2 = mid - rad;
    if (l2 <= 0.0) return;
    vec2 e1 = abs(cb) > 1e-12 ? normalize(vec2(cb, l1 - ca)) : (ca >= cc ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    // Cut the quad where the splat's alpha drops below 1/255 (at most 3 sigma).
    float k = min(3.0, sqrt(2.0 * log(255.0 * opacity)));
    vec2 r = min(k * sqrt(vec2(l1, l2)), vec2(2048.0));

    vec2 c = uCam.xy * p.xy * iz + uCam.zw;
    if (any(lessThan(c + r.x, vec2(0.0))) || any(greaterThan(c - r.x, uSize))) return;
    vec2 px = c + aCorner.x * r.x * e1 + aCorner.y * r.y * vec2(-e1.y, e1.x);
    gl_Position = vec4(px.x / uSize.x * 2.0 - 1.0, 1.0 - px.y / uSize.y * 2.0, 0.0, 1.0);
    vPos = aCorner * k;
    vec3 rgb = vec3(uvec3(a.w, a.w >> 8, a.w >> 16) & 255u) / 255.0;
    vColor = vec4(uLinear ? toLinear(rgb) : rgb, opacity);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 outColor;
void main() {
    float alpha = min(0.99, vColor.a * exp(-0.5 * dot(vPos, vPos)));
    if (alpha < 1.0 / 255.0) discard;
    outColor = vec4(vColor.rgb * alpha, alpha);
}`;

const RESOLVE_VS = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Mode 0: preview, over black. Mode 1: straight-alpha RGBA, rows flipped so readPixels comes out top-down.
const RESOLVE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform bool uLinear;
uniform int uMode;
out vec4 outColor;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    if (uMode == 1) p.y = textureSize(uAccum, 0).y - 1 - p.y;
    vec4 s = texelFetch(uAccum, p, 0);
    float a = clamp(s.a, 0.0, 1.0);
    vec3 c = a > 1e-5 ? clamp(s.rgb / a, 0.0, 1.0) : vec3(0.0);
    if (uLinear) c = toSrgb(c);
    outColor = uMode == 1 ? vec4(c, a) : vec4(c * a, 1.0);
}`;

function program(gl, vs, fs, attribs = []) {
    const p = gl.createProgram();
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
}

export class SplatRenderer {
    constructor(canvas) {
        const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false,
                                                 powerPreference: "high-performance" });
        if (!gl) throw new Error("WebGL2 is not available in this browser");
        this.gl = gl;
        this.linear = !!gl.getExtension("EXT_color_buffer_float");
        this.splat = program(gl, SPLAT_VS, SPLAT_FS, ["aCorner", "aIndex"]);
        this.resolve = program(gl, RESOLVE_VS, RESOLVE_FS);
        this.count = 0;
        this.target = null;

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.bindVertexArray(null);

        this.dataTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
        for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    }

    get maxSize() { return this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE); }

    setSplats(data, rows) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
        this.count = 0;
    }

    setOrder(order, visible) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
        this.count = visible;
    }

    _accumTarget(w, h) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (this.linear) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { tex, fb, w, h };
    }

    _freeTarget(t) {
        this.gl.deleteFramebuffer(t.fb);
        this.gl.deleteTexture(t.tex);
    }

    _splats(target, view, cam) {
        const gl = this.gl, { p, u } = this.splat;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, target.w, target.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!this.count) return;
        gl.useProgram(p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
        gl.uniform1i(u.uData, 0);
        gl.uniformMatrix4fv(u.uView, false, view);
        gl.uniform4fv(u.uCam, cam);
        gl.uniform2f(u.uSize, target.w, target.h);
        gl.uniform1i(u.uLinear, this.linear ? 1 : 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(this.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
    }

    _resolve(source, fb, w, h, mode) {
        const gl = this.gl, { p, u } = this.resolve;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(0, 0, w, h);
        gl.useProgram(p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source.tex);
        gl.uniform1i(u.uAccum, 0);
        gl.uniform1i(u.uLinear, this.linear ? 1 : 0);
        gl.uniform1i(u.uMode, mode);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Draw to the canvas; w and h are its drawing-buffer size.
    draw(view, cam, w, h) {
        if (!this.target || this.target.w !== w || this.target.h !== h) {
            if (this.target) this._freeTarget(this.target);
            this.target = this._accumTarget(w, h);
        }
        this._splats(this.target, view, cam);
        this._resolve(this.target, null, w, h, 0);
    }

    // Render offscreen at w x h and return straight-alpha RGBA bytes, top row first.
    capture(view, cam, w, h) {
        const gl = this.gl;
        const accum = this._accumTarget(w, h);
        const out = { tex: gl.createTexture(), fb: gl.createFramebuffer(), w, h };
        gl.bindTexture(gl.TEXTURE_2D, out.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
        try {
            this._splats(accum, view, cam);
            this._resolve(accum, out.fb, w, h, 1);
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px;
        } finally {
            this._freeTarget(accum);
            this._freeTarget(out);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    dispose() {
        if (this.target) this._freeTarget(this.target);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
}
