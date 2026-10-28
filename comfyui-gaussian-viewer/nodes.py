# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2025 ComfyUI-GaussianViewer Contributors

"""GaussianViewer: look at a Gaussian-splat PLY inside the node, pick a camera, output that view.

The browser does all the rendering (web/). The chosen camera lives in the node's hidden `camera`
widget, so it is saved with the workflow. When the node runs:

- no camera set yet: the viewer loads the PLY and the nodes downstream are skipped;
- this camera was already rendered for this PLY: the cached render is loaded from disk;
- otherwise the open ComfyUI tab is asked to render that camera and the node waits for it.

Cameras use SHARP's convention: OpenCV axes (x right, y down, z forward), EXTRINSICS is the 4x4
world-to-camera matrix and INTRINSICS the 3x3 pixel matrix of the output image.
"""

from __future__ import annotations

import glob
import hashlib
import json
import math
import os
import threading
import time
import uuid

import numpy as np
import torch
from aiohttp import web
from PIL import Image

import comfy.model_management
import folder_paths
from comfy_execution.graph_utils import ExecutionBlocker
from server import PromptServer

RENDER_DIR = os.path.join(folder_paths.get_input_directory(), "gaussian_viewer")
KEEP_RENDERS = 64      # newest cached renders kept in RENDER_DIR
ACCEPT_TIMEOUT = 10    # s for an open tab to answer a render request
RENDER_TIMEOUT = 120   # s for it to download, parse and render the PLY

_plys: dict[str, str] = {}      # token -> path; the only files /gaussian_viewer/ply serves
_jobs: dict[str, dict] = {}     # render request id -> state shared with the HTTP handlers


def _resolve_ply(ply_path: str) -> str:
    path = os.path.abspath(ply_path.strip().strip('"'))
    if os.path.isdir(path):  # SharpPredict returns a folder for image batches
        found = sorted(glob.glob(os.path.join(path, "*.ply")))
        if not found:
            raise FileNotFoundError(f"No .ply files in {path}")
        path = found[0]
    if not os.path.isfile(path):
        raise FileNotFoundError(f"PLY not found: {path}")
    return path


def _ply_token(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]


def _matrix(m, rows: int) -> list[list[float]] | None:
    """EXTRINSICS / INTRINSICS arrive as nested lists or (batched) tensors; return the first as lists."""
    if m is None:
        return None
    a = np.asarray(m.detach().cpu() if isinstance(m, torch.Tensor) else m, dtype=np.float64)
    while a.ndim > 2:
        a = a[0]
    return a[:rows, :rows].tolist() if a.shape[0] >= rows else None


def _save_overlay(image: torch.Tensor) -> dict:
    arr = (image[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    name = f"gaussian_viewer_overlay_{hashlib.sha1(arr.tobytes()).hexdigest()[:16]}.png"
    path = os.path.join(folder_paths.get_temp_directory(), name)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.fromarray(arr).save(path, compress_level=1)
    return {"filename": name, "subfolder": "", "type": "temp"}


def _wait(event: threading.Event, timeout: float, message: str) -> None:
    end = time.monotonic() + timeout
    while not event.wait(0.2):
        comfy.model_management.throw_exception_if_processing_interrupted()
        if time.monotonic() > end:
            raise RuntimeError(message)


def _render_in_browser(node_id: str, ply: dict, camera: str) -> np.ndarray:
    rid = uuid.uuid4().hex
    job = {"accepted": threading.Event(), "done": threading.Event(), "rgba": None, "error": None}
    _jobs[rid] = job
    try:
        PromptServer.instance.send_sync("gaussian_viewer.render",
                                        {"request": rid, "node": node_id, "ply": ply, "camera": camera})
        _wait(job["accepted"], ACCEPT_TIMEOUT,
              "GaussianViewer: no open ComfyUI tab answered the render request. "
              "Open this workflow in the browser and queue it again.")
        _wait(job["done"], RENDER_TIMEOUT, "GaussianViewer: the browser took too long to render the view.")
        if job["error"]:
            raise RuntimeError(f"GaussianViewer: the viewer could not render: {job['error']}")
        return job["rgba"]
    finally:
        _jobs.pop(rid, None)


def _prune_renders() -> None:
    files = sorted(glob.glob(os.path.join(RENDER_DIR, "*.png")), key=os.path.getmtime, reverse=True)
    for f in files[KEEP_RENDERS:]:
        try:
            os.remove(f)
        except OSError:
            pass


class GaussianViewerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ply_path": ("STRING", {"forceInput": True, "tooltip": "Gaussian splat PLY file (or a folder of them)"}),
            },
            "optional": {
                "extrinsics": ("EXTRINSICS", {"tooltip": "4x4 world-to-camera matrix of the photo's camera"}),
                "intrinsics": ("INTRINSICS", {"tooltip": "3x3 intrinsics of the photo; sets the output size"}),
                "image": ("IMAGE", {"tooltip": "Reference image shown over the view"}),
                "camera": ("STRING", {"default": "", "tooltip": "Set by the viewer's Set Camera button"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "EXTRINSICS", "INTRINSICS", "MASK")
    RETURN_NAMES = ("image", "extrinsics", "intrinsics", "mask")
    OUTPUT_TOOLTIPS = (
        "The view from the set camera, over black",
        "4x4 world-to-camera matrix of the set camera",
        "3x3 intrinsics of the output image",
        "1 where the splat left a hole (nothing drawn), 0 where it is solid",
    )
    OUTPUT_NODE = True
    FUNCTION = "view"
    CATEGORY = "geompack/visualization"
    DESCRIPTION = "Orbit a Gaussian splat in the node, press Set Camera, and output that view."

    @classmethod
    def IS_CHANGED(cls, ply_path, camera="", **_):
        try:
            return f"{_ply_token(_resolve_ply(ply_path))}|{camera}"
        except (OSError, FileNotFoundError):
            return float("nan")

    def view(self, ply_path, extrinsics=None, intrinsics=None, image=None, camera="", unique_id=None):
        path = _resolve_ply(ply_path)
        token = _ply_token(path)
        _plys[token] = path
        ply = {
            "token": token,
            "url": f"/gaussian_viewer/ply/{token}",
            "name": os.path.basename(path),
            "size_mb": round(os.path.getsize(path) / 2**20, 1),
            "extrinsics": _matrix(extrinsics, 4),
            "intrinsics": _matrix(intrinsics, 3),
        }
        ui = {"gaussian_viewer": [{**ply, "overlay": _save_overlay(image) if image is not None else None}]}

        cam = json.loads(camera) if camera.strip() else None
        if not cam:
            blocked = ExecutionBlocker(None)
            return {"ui": ui, "result": (blocked,) * 4}

        name = hashlib.sha1(f"{camera}|{token}".encode()).hexdigest()[:20] + ".png"
        cached = os.path.join(RENDER_DIR, name)
        if os.path.exists(cached):
            rgba = np.asarray(Image.open(cached).convert("RGBA"))
        else:
            rgba = _render_in_browser(str(unique_id), ply, camera)
            os.makedirs(RENDER_DIR, exist_ok=True)
            Image.fromarray(rgba, "RGBA").save(cached, compress_level=1)
            _prune_renders()

        px = torch.from_numpy(rgba.astype(np.float32) / 255.0)
        alpha = px[..., 3:]
        return {"ui": ui, "result": ((px[..., :3] * alpha)[None], cam["w2c"], cam["K"], (1.0 - alpha[..., 0])[None])}


def _euler_yxz(R) -> tuple[float, float, float]:
    """Pitch, yaw, roll in degrees of a camera-to-world rotation R = Ry(yaw) Rx(pitch) Rz(roll) in OpenCV
    axes, the viewer's own order: yaw > 0 turns right, pitch > 0 looks up, roll about the view axis."""
    if abs(R[1][2]) < 0.99999:
        pitch = math.asin(-R[1][2])
        yaw = math.atan2(R[0][2], R[2][2])
        roll = math.atan2(R[1][0], R[1][1])
    else:
        pitch = math.copysign(math.pi / 2, -R[1][2])
        yaw = math.atan2(-R[2][0], R[0][0])
        roll = 0.0
    return math.degrees(pitch), math.degrees(yaw), math.degrees(roll)


class ExtrinsicsToPoseNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"extrinsics": ("EXTRINSICS", {"tooltip": "4x4 world-to-camera matrix"})}}

    RETURN_TYPES = ("FLOAT", "FLOAT", "FLOAT", "FLOAT", "FLOAT", "FLOAT", "STRING")
    RETURN_NAMES = ("x", "y", "z", "pitch", "yaw", "roll", "pose_string")
    FUNCTION = "convert"
    CATEGORY = "geompack/camera"
    DESCRIPTION = "Camera position and pitch/yaw/roll (degrees) from a world-to-camera matrix."

    def convert(self, extrinsics):
        w2c = np.asarray(_matrix(extrinsics, 4))
        R = w2c[:3, :3].T                      # camera-to-world rotation
        x, y, z = (-R @ w2c[:3, 3]).tolist()   # camera position
        pitch, yaw, roll = _euler_yxz(R.tolist())
        v = [round(a, 2) for a in (x, y, z, pitch, yaw, roll)]
        pose = ",".join(f'"{k}":{a}' for k, a in zip(("x", "y", "z", "pitch", "yaw", "roll"), v))
        return (*v, pose)


def _srgb_to_linear(c: torch.Tensor) -> torch.Tensor:
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: torch.Tensor) -> torch.Tensor:
    return torch.where(c <= 0.0031308, c * 12.92, 1.055 * c.clamp(min=0.0031308) ** (1 / 2.4) - 0.055)


def _push_pull(rgb: torch.Tensor, solid: torch.Tensor) -> torch.Tensor:
    """Fill the pixels where `solid` is 0 from the solid ones around them: average down a pyramid of
    halved images (weighted by coverage), then push the coarse colours back up into the gaps.
    rgb is HxWx3 sRGB in 0..1, solid HxW in {0, 1}. Blends in linear light."""
    levels = [(_srgb_to_linear(rgb) * solid[..., None], solid)]
    while min(levels[-1][1].shape) > 1:
        c, w = levels[-1]
        h2, w2 = (w.shape[0] + 1) // 2, (w.shape[1] + 1) // 2
        c = torch.nn.functional.pad(c, (0, 0, 0, w2 * 2 - c.shape[1], 0, h2 * 2 - c.shape[0]))
        w = torch.nn.functional.pad(w, (0, w2 * 2 - w.shape[1], 0, h2 * 2 - w.shape[0]))
        levels.append((c.reshape(h2, 2, w2, 2, 3).sum((1, 3)), w.reshape(h2, 2, w2, 2).sum((1, 3))))
    out = None
    for c, w in reversed(levels):
        est = torch.where(w[..., None] > 0, c / w.clamp(min=1e-9)[..., None], torch.zeros_like(c))
        if out is None:
            out = est
            continue
        conf = w.clamp(max=1.0)[..., None]
        up = out.repeat_interleave(2, 0).repeat_interleave(2, 1)[: w.shape[0], : w.shape[1]]
        out = est * conf + up * (1 - conf)
    filled = _linear_to_srgb(out).clamp(0, 1)
    return torch.where(solid[..., None] > 0, rgb, filled)


class FillSplatHolesNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The view from GaussianViewer"}),
                "mask": ("MASK", {"tooltip": "GaussianViewer's mask: 1 where the splat left a hole"}),
                "threshold": ("FLOAT", {"default": 4 / 255, "min": 0.0, "max": 1.0, "step": 0.001,
                                        "tooltip": "Pixels with coverage below this count as holes"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "fill"
    CATEGORY = "geompack/visualization"
    DESCRIPTION = ("Fill the splat's holes by smearing in the surrounding colours (push-pull), "
                   "the same fill the splat-repair LoRAs were trained on.")

    def fill(self, image, mask, threshold=4 / 255):
        out = []
        for i in range(image.shape[0]):
            rgb = image[i, ..., :3].double().cpu()
            m = mask[min(i, mask.shape[0] - 1)].double().cpu()
            if m.shape != rgb.shape[:2]:
                m = torch.nn.functional.interpolate(m[None, None], size=rgb.shape[:2], mode="nearest")[0, 0]
            solid = ((1.0 - m) >= threshold - 1e-6).double()  # the mask went through float32
            out.append(_push_pull(rgb, solid).float())
        return (torch.stack(out).to(image.device),)


routes = PromptServer.instance.routes


@routes.get("/gaussian_viewer/ply/{token}")
async def _serve_ply(request):
    path = _plys.get(request.match_info["token"])
    if not path or not os.path.isfile(path):
        return web.Response(status=404)
    # The token changes whenever the file does, so the browser may keep its copy.
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@routes.post("/gaussian_viewer/accept/{rid}")
async def _accept(request):
    job = _jobs.get(request.match_info["rid"])
    if not job or job["accepted"].is_set():
        return web.json_response({"ok": False}, status=409)
    job["accepted"].set()
    return web.json_response({"ok": True})


@routes.post("/gaussian_viewer/result/{rid}")
async def _result(request):
    job = _jobs.get(request.match_info["rid"])
    if not job or job["done"].is_set():
        return web.json_response({"ok": False}, status=409)
    if request.content_type == "application/json":
        job["error"] = (await request.json()).get("error") or "unknown error"
    else:
        w, h = int(request.query["w"]), int(request.query["h"])
        body = await request.read()
        if len(body) != w * h * 4:
            job["error"] = f"expected {w * h * 4} bytes, got {len(body)}"
        else:
            job["rgba"] = np.frombuffer(body, np.uint8).reshape(h, w, 4).copy()
    job["done"].set()
    return web.json_response({"ok": True})


NODE_CLASS_MAPPINGS = {
    "GaussianViewer": GaussianViewerNode,
    "ExtrinsicsToPose": ExtrinsicsToPoseNode,
    "FillSplatHoles": FillSplatHolesNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GaussianViewer": "GaussianViewer",
    "ExtrinsicsToPose": "Extrinsics to Pose",
    "FillSplatHoles": "Fill Splat Holes",
}
