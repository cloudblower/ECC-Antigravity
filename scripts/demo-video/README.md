# ECC for Antigravity Demo Video Toolkit

Reusable, zero-npm-dependency 1080p demo video generator for **ECC for Antigravity**.

## Architecture

### Toolkit Files

- [`player.html`](./player.html): Self-contained 1920x1080 (16:9 desktop) HTML/CSS/SVG animation canvas with all UI icons inlined as SVG, driven deterministically via `window.renderAt(t)`.
- [`player-mobile.html`](./player-mobile.html): Vertical 9:16 (`1080x1920`) variant with inlined SVGs for mobile feeds.
- [`player-portrait.html`](./player-portrait.html): Portrait 4:5 (`1080x1350`) variant with inlined SVGs tailored for both desktop and mobile feeds.
- [`render.js`](./render.js): Launches headless Google Chrome over Chrome DevTools Protocol (CDP), steps `window.renderAt(t)` frame-by-frame at 30fps, pipes PNG frames to FFmpeg, and muxes `docs/assets/voiceover.wav` with subtle UI sound effects.
- [`voiceover-script.md`](./voiceover-script.md): Full verbatim narration script, cue timings, audio specs, and code-accuracy notes.
- [`assets/`](./assets/): Official Antigravity logo (`antigravity-logo.png`), reference Lucide icon sources (`icon-*.svg`; players inline their SVGs directly rather than loading external SVG files at runtime), and synthesized UI sound effects (`sfx-*.wav`).

### Scene Architecture (`0.00s – 109.50s`)

- **Act 0 (`0.00s – 13.50s`)**: Hero Intro — Antigravity logo, governance shield, and 4 capability pills (`PreToolUse Security`, `GateGuard Destructive Gate`, `Fact-Force Impact Analysis`, `Continuous Learning`).
- **Act 1 (`13.50s – 31.90s`)**: PreToolUse Security Guard — intercepts `git commit --no-verify` (`exit 2`), agent self-corrects.
- **Act 2 (`31.90s – 50.00s`)**: GateGuard Destructive Command Gate — halts `rm -rf src/legacy_modules` until 3 concrete facts (affected files, 1-line rollback procedure, verbatim user instruction) are verified.
- **Act 3 (`50.00s – 69.20s`)**: Fact-Force Code Edit Gate — halts first-touch `edit("src/auth.js")` until impact analysis (importing dependencies, shared schema/contract impact, and test coverage) is asserted.
- **Act 4 (`69.20s – 95.80s`)**: Continuous Learning v2.1 Daemon — background observer synthesizes `~/.ecc/instincts/jwt-refresh-rotation.yaml` (`confidence: 0.94`, `project-local`).
- **Act 5 (`95.80s – 102.50s`)**: PreInvocation Compounding — auto-mounts verified instincts at Turn 0 of the next session.
- **Act 6 (`102.50s – 109.50s`)**: Classic Outro — governance & evolving intelligence summary with `github.com/cloudblower/ecc-antigravity`.
- **Lower-Third Transcript**: Translucent floating pill synchronized word-for-word to `docs/assets/voiceover.wav`.

## Prerequisites

- **Node.js** >= 18
- **Google Chrome** or **Chromium** (`google-chrome` / `chromium` in `PATH`)
- **FFmpeg** & **FFprobe** (`ffmpeg` / `ffprobe` in `PATH`)

## Quick Start

From the repository root:

```bash
# 16:9 desktop (1920x1080, 30fps, H.264 + AAC) -> docs/assets/antigravity-hooks-demo.mp4
node scripts/demo-video/render.js

# 4:5 portrait (1080x1350) -> docs/assets/antigravity-hooks-demo-portrait.mp4
node scripts/demo-video/render.js --portrait

# 9:16 vertical mobile (1080x1920) -> docs/assets/antigravity-hooks-demo-mobile.mp4
node scripts/demo-video/render.js --mobile
```

### Useful Options

```bash
# Render a single verification frame at t = 25.5s
node scripts/demo-video/render.js --preview-frame 25.5 --out /tmp/preview-25.5.png

# Custom output or audio path
node scripts/demo-video/render.js --audio docs/assets/voiceover.wav --out docs/assets/antigravity-hooks-demo.mp4

# Render without subtle UI sound effects (voiceover only)
node scripts/demo-video/render.js --no-sfx

# Show CLI usage and options
node scripts/demo-video/render.js --help
```

## Regenerating the Voiceover

See [`voiceover-script.md`](./voiceover-script.md) for the full verbatim narration script, Google AI Studio TTS audio specifications (`24 kHz` mono PCM WAV), code-accuracy notes, and step-by-step re-recording and re-sync instructions.
