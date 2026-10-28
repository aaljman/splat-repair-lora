# SPDX-License-Identifier: MIT
# Copyright (c) 2026 aaljman

"""Interactive Gaussian-splat viewer node for ComfyUI that outputs the chosen view."""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
