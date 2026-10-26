# Splat-repair LoRA for Qwen-Image-2.1

A LoRA for [Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) that repairs a far view rendered from a single-photo 3D Gaussian splat reconstruction ([SHARP](https://github.com/apple/ml-sharp)). It fills holes and smears in the parts of the view the photo never saw, using the original photo as a reference.

Made by Abdulaziz Aljman for a COMP90044 Research Methods project at the University of Melbourne (October 2026).

- **Image 1:** SHARP's render at the new camera
- **Image 2:** the original photo
- **Prompt:** a short, plain description of what the hidden or broken parts should look like (see `examples/`)

File: `splat_repair_human_qwen21_e23.safetensors` (rank 8, alpha 8, 42 MB).

## Comparison with the previous LoRA

The baseline is the configuration used before this project: Qwen-Image-Edit-2511 with **[dx8152/Qwen-Image-Edit-2511-Gaussian-Splash](https://huggingface.co/dx8152/Qwen-Image-Edit-2511-Gaussian-Splash)** (Apache-2.0), 4-step Lightning sampling and that LoRA's default prompt. That LoRA was the starting point for this idea: it showed that an image-edit model can repair SHARP renders. All credit for it goes to dx8152.

Each sheet: ground truth from Blender | SHARP's render | previous configuration | this LoRA. Test scenes t1-t5 were not used for any training or selection decision.

![t1](compare/t1.jpg)
![t2](compare/t2.jpg)
![t3](compare/t3.jpg)
![t4](compare/t4.jpg)
![t5](compare/t5.jpg)

Validation scenes (these were used to pick the epoch and caption style, so their scores are optimistic): [x001](compare/x001.jpg), [y05](compare/y05.jpg), [y18](compare/y18.jpg), [y31](compare/y31.jpg).

### Scores

PSNR in dB against the true Blender view, whole frame / only the pixels the photo never saw. Higher is better.

| Scene | SHARP render | Previous (2511 + Gaussian-Splash) | Qwen-Image-2.1, no LoRA | This LoRA |
|---|---:|---:|---:|---:|
| t1 | 22.8 / 23.3 | 19.1 / 19.5 | 20.1 / 20.1 | 24.0 / 25.0 |
| t2 | 19.9 / 18.8 | 19.3 / 19.6 | 16.1 / 18.3 | 21.1 / 22.0 |
| t3 | 18.1 / 17.9 | 16.8 / 17.6 | 13.7 / 14.3 | 17.7 / 19.1 |
| t4 | 18.1 / 19.7 | 16.3 / 20.3 | 15.3 / 12.9 | 16.8 / 20.7 |
| t5 | 20.0 / 18.6 | 18.1 / 17.8 | 16.6 / 17.0 | 19.4 / 18.6 |
| **mean, test** | **19.78 / 19.65** | **17.90 / 18.95** | **16.36 / 16.52** | **19.80 / 21.08** |
| mean, validation | 19.26 / 17.52 | 16.43 / 15.28 | 15.87 / 15.52 | 19.68 / 18.76 |

Read these honestly:

- One training seed and one sampling seed per scene, on 5 test scenes. In the unseen region this LoRA is +1.43 dB over SHARP's render (4 of 5 scenes), but the 95% interval (-0.03 to +2.89 dB) includes zero. Over the whole frame it is level with SHARP's render, and SSIM is lower on every scene.
- Against the previous configuration it has higher PSNR on all 9 scenes. That comparison changes the base model, the LoRA, the step count and the prompt all at once, so it compares two setups, not two LoRAs. The previous configuration was also fed a hole-filled version of the SHARP render.
- The "no LoRA" column used a detailed prompt, not the human-style one, so it is not a clean test of the LoRA by itself.
- All scenes are synthetic (Blender + Poly Haven). Real photos have not been tested.

## Training

- Base: Qwen-Image-2.1 (unified generation and editing model)
- Data: 38 pairs from Blender scenes built from CC0 [Poly Haven](https://polyhaven.com) assets. Input = SHARP's actual render at a moved camera plus the photo; target = the true Blender render at that camera.
- Captions: human-style descriptions of what needs fixing. This beat a detailed object-by-object caption and a constant "fix this" caption on the validation scenes (one seed each, so this ranking is preliminary).
- Trainer: [Fizgig](https://github.com/shootthesound/Fizgig), Fast preset, AdamW 8-bit, rank 8. Epoch 23 of 40 was chosen on the validation scenes.

## Use in ComfyUI

`workflow_api.json` is the API-format graph used for every result above: 25 steps, CFG 1.0, euler/simple, LoRA strength 1.0. Put the LoRA in `models/loras/`, load the two images and write the prompt. It expects the Qwen-Image-2.1 nodes (`TextEncodeQwenImage21`, `QwenImage21Cache`) and the int8 model files named in the graph; swap in your own model files as needed.

## Licence and attribution

- This LoRA is derived from **Qwen-Image-2.1**, which is released under the [Qwen Research License Agreement](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE). Use of this LoRA is subject to those terms (research use).
- Training inputs were produced with Apple's **SHARP** ([apple/ml-sharp](https://github.com/apple/ml-sharp); Mescheder et al., ICLR 2026), under its own research licence.
- Scene assets: **Poly Haven**, CC0.
- Previous configuration and inspiration: **dx8152**, [Qwen-Image-Edit-2511-Gaussian-Splash](https://huggingface.co/dx8152/Qwen-Image-Edit-2511-Gaussian-Splash); 4-step sampling from [lightx2v Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning).
- Trainer: **Fizgig** by shootthesound.

## Dataset

`dataset/` holds all 47 scenes (Git LFS, about 223 MB):

- `photo/`: the input photo at camera A
- `splat/`: SHARP's render at the moved camera B (the repair input)
- `target/`: the true Blender render at B
- `unseen/`: mask of the pixels at B the photo never saw
- `fake/`: a simulated render (photo warped with true depth), kept for comparison; it is too clean to replace SHARP's output
- `meta/`: per-scene settings, camera move and SHARP scores
- `captions/`: `<id>.human.txt`, `<id>.detail.txt` and the constant caption

Splits: test `t1`-`t5`; validation `x001`, `y05`, `y18`, `y31`; every other scene is training. Scene specifications were drafted by language-model agents and have not been hand-checked. The SHARP renders are covered by Apple's research licence, so the dataset is for research use only.
