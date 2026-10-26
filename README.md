<p align="center">
  <img src="docs/hero.jpg" alt="A cabinet table on a herringbone brick floor, in four panels. Left to right: the input photo; SHARP's render from a moved camera, with a grey block and smears where the photo saw nothing; the same view repaired by this LoRA, with the floor filled in and a small wooden stool beside the table; and the true Blender render of that view." width="100%">
</p>
<p align="center"><sub>Test scene t2, which was not used for any training or selection decision.</sub></p>

# Splat-repair LoRA

A LoRA for [Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) that repairs a far view rendered from a single-photo 3D Gaussian splat reconstruction ([SHARP](https://github.com/apple/ml-sharp)).

It fills holes and smears in the parts of the view the photo never saw, using the original photo as a reference.

Made by Abdulaziz Aljman for a COMP90044 Research Methods project at the University of Melbourne (October 2026).

## Why

SHARP turns one photo into a 3D Gaussian splat. Move the camera away from where the photo was taken and the parts the photo never saw come out as holes and smears. An image-edit model can paint them back in: [dx8152's Qwen-Image-Edit-2511-Gaussian-Splash](https://huggingface.co/dx8152/Qwen-Image-Edit-2511-Gaussian-Splash) LoRA showed that, and it was the starting point for this project. This LoRA does the same job on Qwen-Image-2.1, trained on SHARP's actual renders paired with the true view from Blender.

## Use

**[Download the LoRA](https://github.com/aaljman/splat-repair-lora/releases/download/v1.0/splat_repair_human_qwen21_e23.safetensors)** (`splat_repair_human_qwen21_e23.safetensors`, rank 8, alpha 8, 42 MB) from the [v1.0 release](https://github.com/aaljman/splat-repair-lora/releases/tag/v1.0) and put it in ComfyUI's `models/loras/`. It is also in the repo itself, so "Download ZIP" or a clone gets it too.

Two more LoRAs, trained the same way on other caption styles, are in the repo for comparison: see [Caption styles](#caption-styles). The one above is the one to use.

Each repair takes two images and a prompt:

| Input | What it is |
| --- | --- |
| **Image 1** | SHARP's render at the new camera |
| **Image 2** | the original photo |
| **Prompt** | a short, plain description of what the hidden or broken parts should look like (see `examples/`) |

The prompt for the scene at the top, from `examples/t2_prompt.txt`:

> The right end of the cabinet table and the floor behind it got smeared. There's a little rustic wooden stool with an orange-brown top just past the table's right end, and the herringbone brick floor and pale blue walls carry on around it and on the left side of the room.

### ComfyUI

`workflow_api.json` is the API-format graph used for every result below. Load the two images and write the prompt.

| Setting | Value |
| --- | --- |
| Steps | 25 |
| CFG | 1.0 |
| Sampler / scheduler | euler / simple |
| LoRA strength | 1.0 |

It expects the Qwen-Image-2.1 nodes (`TextEncodeQwenImage21`, `QwenImage21Cache`) and the int8 model files named in the graph; swap in your own model files as needed.

## Compared with the previous LoRA

The baseline is the configuration used before this project: Qwen-Image-Edit-2511 with **[dx8152/Qwen-Image-Edit-2511-Gaussian-Splash](https://huggingface.co/dx8152/Qwen-Image-Edit-2511-Gaussian-Splash)** (Apache-2.0), 4-step Lightning sampling and that LoRA's default prompt. That LoRA was the starting point for this idea: it showed that an image-edit model can repair SHARP renders. All credit for it goes to dx8152.

Each sheet, left to right: ground truth from Blender | SHARP's render | previous configuration | this LoRA. Test scenes t1-t5 were not used for any training or selection decision.

<p align="center"><img src="compare/t1.jpg" alt="Test scene t1: ground truth, SHARP render, previous configuration, this LoRA." width="100%"></p>

<p align="center"><img src="compare/t2.jpg" alt="Test scene t2: ground truth, SHARP render, previous configuration, this LoRA." width="100%"></p>

<p align="center"><img src="compare/t3.jpg" alt="Test scene t3: ground truth, SHARP render, previous configuration, this LoRA." width="100%"></p>

<p align="center"><img src="compare/t4.jpg" alt="Test scene t4: ground truth, SHARP render, previous configuration, this LoRA." width="100%"></p>

<p align="center"><img src="compare/t5.jpg" alt="Test scene t5: ground truth, SHARP render, previous configuration, this LoRA." width="100%"></p>

Validation scenes (these were used to pick the epoch and caption style, so their scores are optimistic): [x001](compare/x001.jpg), [y05](compare/y05.jpg), [y18](compare/y18.jpg), [y31](compare/y31.jpg).

## Scores

PSNR in dB against the true Blender view, whole frame / only the pixels the photo never saw. Higher is better.

| Scene | SHARP render | Previous (2511 + Gaussian-Splash) | Qwen-Image-2.1, no LoRA, detailed prompt | Qwen-Image-2.1, no LoRA, same prompt | This LoRA |
| --- | ---: | ---: | ---: | ---: | ---: |
| t1 | 22.8 / 23.3 | 19.1 / 19.5 | 20.1 / 20.1 | 20.2 / 20.2 | 24.0 / 25.0 |
| t2 | 19.9 / 18.8 | 19.3 / 19.6 | 16.1 / 18.3 | 16.9 / 18.9 | 21.1 / 22.0 |
| t3 | 18.1 / 17.9 | 16.8 / 17.6 | 13.7 / 14.3 | 17.7 / 18.3 | 17.7 / 19.1 |
| t4 | 18.1 / 19.7 | 16.3 / 20.3 | 15.3 / 12.9 | 15.9 / 16.8 | 16.8 / 20.7 |
| t5 | 20.0 / 18.6 | 18.1 / 17.8 | 16.6 / 17.0 | 14.7 / 15.3 | 19.4 / 18.6 |
| **mean, test** | **19.78 / 19.65** | **17.90 / 18.95** | **16.36 / 16.52** | **17.06 / 17.92** | **19.80 / 21.08** |
| mean, validation | 19.26 / 17.52 | 16.43 / 15.28 | 15.87 / 15.52 | 15.84 / 14.97 | 19.68 / 18.76 |

Read these honestly:

- One training seed and one sampling seed per scene, on 5 test scenes. In the unseen region this LoRA is +1.43 dB over SHARP's render (4 of 5 scenes), but the 95% interval (-0.03 to +2.89 dB) includes zero. Over the whole frame it is level with SHARP's render, and SSIM is lower on every scene.
- Against the previous configuration it has higher PSNR on all 9 scenes. That comparison changes the base model, the LoRA, the step count and the prompt all at once, so it compares two setups, not two LoRAs. The previous configuration was also fed a hole-filled version of the SHARP render.
- With the same human prompt and no LoRA, the base model scores 17.06 / 17.92 dB on the test scenes. This LoRA is higher on all 5 test scenes, by 2.74 dB over the whole frame and 3.16 dB in the unseen region (95% interval 1.35 to 4.98), and SSIM is also higher on all 5 (0.546 vs 0.450). That is the cleanest measure of what the LoRA itself adds; it is still one seed on 5 scenes.
- All scenes are synthetic (Blender + Poly Haven). Real photos have not been tested.

These scores use one sampling seed. Over three seeds (next section) the picture is the same: +1.44 dB over SHARP's render in the unseen region (95% interval -0.11 to +2.98), level over the whole frame, and SSIM lower on all 15 scene-seed pairs; +3.33 dB over the base model with the same prompt in the unseen region (95% interval +1.06 to +5.60).

## Caption styles

Three LoRAs were trained on the same 38 pairs with the same settings. Only the training caption changed, so the prompt each one expects is different. The human-caption LoRA above is the one to use; the other two are here so the comparison can be checked.

| LoRA | Trained with | Prompt it with | Epoch | File |
| --- | --- | --- | ---: | --- |
| **Human caption** | a short, plain description of what is broken or hidden and what should be there | the same kind of description, e.g. `examples/t2_prompt.txt` | 23 of 40 | [`splat_repair_human_qwen21_e23.safetensors`](https://github.com/aaljman/splat-repair-lora/releases/download/v1.0/splat_repair_human_qwen21_e23.safetensors) |
| Detail caption | a long, object-by-object description of the whole scene: the camera move, every object, the lighting, and which areas were hidden or out of frame | the same kind of description, e.g. `examples/t2_prompt.detail.txt` (about 250 words) | 25 (run stopped at 37) | [`splat_repair_detail_qwen21_e25.safetensors`](splat_repair_detail_qwen21_e25.safetensors) |
| Constant caption | the words `fix this` on every pair | exactly `fix this` | 6 of 16 | [`splat_repair_min_qwen21_e06.safetensors`](splat_repair_min_qwen21_e06.safetensors) |

All three are rank 8, alpha 8, 42 MB, and use the same ComfyUI graph and settings; swap the `lora_name` in `workflow_api.json`. The constant-caption file keeps the trainer's `fix this` trigger in its header, because that really is its prompt; the other two have it removed.

Each sheet, left to right: ground truth from Blender | SHARP's render | constant caption | detail caption | human caption. Sampling seed 1 on the test scenes.

<p align="center"><img src="compare/captions_t1.jpg" alt="Test scene t1: ground truth, SHARP render, constant-caption LoRA, detail-caption LoRA, human-caption LoRA." width="100%"></p>

<p align="center"><img src="compare/captions_t2.jpg" alt="Test scene t2: ground truth, SHARP render, constant-caption LoRA, detail-caption LoRA, human-caption LoRA." width="100%"></p>

<p align="center"><img src="compare/captions_t3.jpg" alt="Test scene t3: ground truth, SHARP render, constant-caption LoRA, detail-caption LoRA, human-caption LoRA." width="100%"></p>

<p align="center"><img src="compare/captions_t4.jpg" alt="Test scene t4: ground truth, SHARP render, constant-caption LoRA, detail-caption LoRA, human-caption LoRA." width="100%"></p>

<p align="center"><img src="compare/captions_t5.jpg" alt="Test scene t5: ground truth, SHARP render, constant-caption LoRA, detail-caption LoRA, human-caption LoRA." width="100%"></p>

### Scores over three seeds

Each LoRA was sampled with three seeds per scene; each cell averages the seeds per scene, then the scenes. PSNR in dB, whole frame / only the pixels the photo never saw; SSIM higher is better; LPIPS (VGG) and DISTS lower is better.

| Method | Test PSNR | Test SSIM | Test LPIPS | Test DISTS | Validation PSNR | Validation LPIPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SHARP render (input) | 19.78 / 19.65 | 0.588 | 0.482 | 0.177 | 19.26 / 17.52 | 0.475 |
| Qwen-Image-2.1, no LoRA, human prompt | 17.09 / 17.76 | 0.472 | 0.510 | 0.181 | 16.23 / 14.94 | 0.512 |
| Constant caption, e6 | 19.09 / 20.26 | 0.522 | 0.432 | 0.131 | 18.66 / 17.72 | 0.402 |
| Detail caption, e25 | **19.74** / 20.10 | 0.529 | 0.426 | 0.119 | 19.03 / 18.18 | 0.400 |
| **Human caption, e23** | 19.63 / **21.09** | **0.545** | **0.397** | **0.118** | **19.53** / **18.66** | **0.382** |

Paired on the test scenes. "Wins" counts scene-seed pairs (5 scenes x 3 seeds); the 95% interval is taken over the 5 scenes, each averaged over its seeds.

| Human caption vs | Metric | Wins | Mean difference | 95% interval |
| --- | --- | ---: | ---: | ---: |
| Detail caption | PSNR, unseen | 12/15 | +0.99 dB | -0.24 to +2.22 |
| Detail caption | PSNR, whole frame | 9/15 | -0.11 dB | -2.71 to +2.48 |
| Detail caption | LPIPS | 12/15 | -0.029 | -0.085 to +0.026 |
| Constant caption | PSNR, unseen | 10/15 | +0.83 dB | -0.20 to +1.85 |
| Constant caption | PSNR, whole frame | 12/15 | +0.54 dB | -0.11 to +1.18 |
| Constant caption | LPIPS | 14/15 | -0.035 | -0.059 to -0.011 |
| Constant caption | DISTS | 14/15 | -0.014 | -0.021 to -0.007 |

Read these honestly:

- Of the three, the human caption is best or level on every measure, on both the test and the validation scenes. Against the detail caption, every interval includes zero, and the two are level over the whole frame (the detail caption is 0.11 dB ahead there). Against the constant caption, only the perceptual distances (LPIPS, DISTS) are clearly better.
- The detail and constant captions are level with each other: within 0.2 dB in the unseen region and 0.65 dB over the whole frame, with intervals well across zero.
- One training run per caption style, and 5 test scenes. The seed-to-seed standard deviation of a scene's PSNR is about 0.4 to 1.2 dB, about the size of the gaps between the styles.
- The epochs were picked on the validation scenes, so the validation columns are optimistic. The runs were not the same length: constant 16 epochs (e6 picked), detail extended to 40 but stopped at 37 (e25 picked), human 40 (e23 picked).
- The detail caption is a lot to ask of a user: it describes the camera move and every object, hidden ones included, so writing one takes knowing the scene well. The test captions were written the same way as the training captions; a user's own would likely be less accurate.

## Training

1. **Base.** Qwen-Image-2.1 (unified generation and editing model).
2. **Data.** 38 pairs from Blender scenes built from CC0 [Poly Haven](https://polyhaven.com) assets. Input = SHARP's actual render at a moved camera plus the photo; target = the true Blender render at that camera.
3. **Captions.** Human-style descriptions of what needs fixing. This beat a detailed object-by-object caption and a constant "fix this" caption on the validation scenes, and over three sampling seeds it is best or level on every measure on the test scenes too, though by margins within seed noise (see [Caption styles](#caption-styles)).
4. **Trainer.** [Fizgig](https://github.com/shootthesound/Fizgig), Fast preset, AdamW 8-bit, rank 8. Epoch 23 of 40 was chosen on the validation scenes.

## Dataset

`dataset/` holds all 47 scenes (about 223 MB):

| Folder | Contents |
| --- | --- |
| `photo/` | the input photo at camera A |
| `splat/` | SHARP's render at the moved camera B (the repair input) |
| `target/` | the true Blender render at B |
| `unseen/` | mask of the pixels at B the photo never saw |
| `fake/` | a simulated render (photo warped with true depth), kept for comparison; it is too clean to replace SHARP's output |
| `meta/` | per-scene settings, camera move and SHARP scores |
| `captions/` | `<id>.human.txt`, `<id>.detail.txt` and the constant caption |

Splits: test `t1`-`t5`; validation `x001`, `y05`, `y18`, `y31`; every other scene is training. Scene specifications were drafted by language-model agents and have not been hand-checked. The SHARP renders are covered by Apple's research licence, so the dataset is for research use only.

## Credits

- **Previous configuration and inspiration:** **dx8152**, [Qwen-Image-Edit-2511-Gaussian-Splash](https://huggingface.co/dx8152/Qwen-Image-Edit-2511-Gaussian-Splash); 4-step sampling from [lightx2v Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning).
- **SHARP** by Apple ([apple/ml-sharp](https://github.com/apple/ml-sharp); Mescheder et al., ICLR 2026). Training inputs were produced with it, under its own research licence.
- **Scene assets:** [Poly Haven](https://polyhaven.com), CC0.
- **Trainer:** [Fizgig](https://github.com/shootthesound/Fizgig) by shootthesound.

## Licence

This LoRA is derived from **Qwen-Image-2.1**, which is released under the [Qwen Research License Agreement](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE). Use of this LoRA is subject to those terms (research use). The dataset is for research use only, because the SHARP renders in it are covered by Apple's research licence.
