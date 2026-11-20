# ECC for Antigravity — Demo Video Voiceover Script

Reference script, timing breakdown, code-accuracy notes, and re-recording workflow for [`docs/assets/voiceover.wav`](../../docs/assets/voiceover.wav).

## Generation Settings

- **Provider**: Google AI Studio TTS
- **Tone / Delivery**: Professional, clear tech-documentary narration
- **Output Path**: `docs/assets/voiceover.wav`
- **Audio Specs** (verified via `ffprobe`):
  - **Container / Codec**: WAV, `pcm_s16le` (PCM signed 16-bit little-endian, 16 bits/sample)
  - **Sample Rate**: `24000 Hz` (24 kHz)
  - **Channels**: `1` (mono)
  - **Audio Duration**: `107.960000s` (~107.96s)
  - **File Size**: `5,182,124` bytes (`384003` bps format bit rate)
  - **Rendered Video Duration**: `109.50s` (`107.96s` voiceover + `1.54s` outro fade `OUTRO_BUFFER_SEC` in [`render.js`](./render.js))

Verify specs locally with:

```bash
ffprobe -v error -show_format -show_streams docs/assets/voiceover.wav
```

## Narration Per Act

All narration lines below are taken verbatim from the `SUBTITLES` array in [`player.html`](./player.html) and cross-checked against [`player-mobile.html`](./player-mobile.html) and [`player-portrait.html`](./player-portrait.html) (all 23 cue entries and `TOTAL_DURATION = 109.50` match with zero differences).

### Intro (`0.00s–13.50s`)

- `0.05s–4.02s`: "Autonomous AI coding agents are transforming software development."
- `4.38s–6.05s`: "But who guards your repository?"
- `6.94s–8.85s`: "Meet ECC for Antigravity,"
- `9.20s–12.92s`: "the enterprise governance and continuous learning runtime for AI agents."

### Act 1 — Safety Guard: `git commit --no-verify` (`13.50s–31.90s`)

- `13.95s–17.15s`: "When coding agents move fast, security cannot be optional."
- `17.68s–22.08s`: "Here, an agent attempts to bypass Git hooks with commit --no-verify."
- `22.90s–25.95s`: "ECC's PreToolUse security guard intercepts the command instantly,"
- `26.10s–31.25s`: "blocking hook bypasses and enforcing security baselines before execution."

### Act 2 — GateGuard: `rm -rf` (`31.90s–50.00s`)

- `32.50s–37.42s`: "Next, during workspace cleanup, the agent invokes a destructive rm -rf command."
- `38.03s–39.92s`: "GateGuard immediately halts execution."
- `40.43s–41.60s`: "Instead of asking a weak 'Are you sure?',"
- `41.72s–49.48s`: "it forces the agent to declare all affected files, state a concrete rollback procedure, and cite your verbatim instruction."

### Act 3 — Fact-Force Edit Gate (`50.00s–69.20s`)

- `50.60s–55.06s`: "Before modifying production code, the Fact-Force gate prevents uninvestigated edits."
- `55.88s–59.16s`: "When the agent attempts to modify src/auth.js,"
- `59.52s–62.92s`: "the hook blocks the change until the agent proves its impact analysis:"
- `63.43s–68.70s`: "listing importing dependencies, verifying shared schemas, and identifying existing test coverage."

### Act 4 — Continuous Learning Daemon (`69.20s–95.80s`)

- `69.75s–74.08s`: "Finally, the real superpower of ECC: autonomous continuous learning."
- `74.86s–79.80s`: "Running silently in the background, a daemon observes every tool call, correction, and success."
- `80.36s–85.23s`: "Once a task completes, it extracts atomic architectural instincts with confidence scoring,"
- `85.68s–89.18s`: "automatically evolving verified patterns into persistent project rules."
- `90.12s–95.12s`: "Every session compounds repository knowledge, ensuring your agents never repeat the same mistake twice."

### Outro (`95.80s–109.50s`: Act 5 PreInvocation `95.80s–102.50s` + Act 6 Branding `102.50s–109.50s`)

- `96.38s–102.08s`: "The next time you open a session, your agent is already smarter, safer, and tailored to your codebase."
- `102.95s–107.75s`: "ECC for Antigravity: governance at the edge, and intelligence that evolves with you."

## Accuracy Notes Per Act

### Intro (`0.00s–13.50s`) Accuracy

- **Backing sources**: [`hooks/agy-hooks.json`](../../hooks/agy-hooks.json), [`scripts/hooks/agy/pre-tool-use.js`](../hooks/agy/pre-tool-use.js), [`scripts/hooks/agy/post-tool-use.js`](../hooks/agy/post-tool-use.js), [`scripts/hooks/agy/pre-invocation.js`](../hooks/agy/pre-invocation.js), [`scripts/hooks/agy/post-invocation.js`](../hooks/agy/post-invocation.js), [`scripts/hooks/agy/stop.js`](../hooks/agy/stop.js).
- **What the code does**: Antigravity hooks invoke the adapter scripts under `scripts/hooks/agy/`, which translate Antigravity payloads into ECC hook events (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`) and enforce tool blocks or inject startup context.

### Act 1 — Safety Guard (`13.50s–31.90s`) Accuracy

- **Backing sources**: [`scripts/hooks/block-no-verify.js`](../hooks/block-no-verify.js), wired into [`scripts/hooks/bash-hook-dispatcher.js`](../hooks/bash-hook-dispatcher.js) (`pre:bash:block-no-verify`, active in `minimal`, `standard`, and `strict` profiles) and bridged via [`scripts/hooks/agy/pre-tool-use.js`](../hooks/agy/pre-tool-use.js).
- **What the code does**: Scans shell command strings (including pipelines, subshells, `eval`, short option clusters such as `-an`, unambiguous long-flag prefixes from `--no-v` to `--no-verify`, and `-c core.hooksPath=...`) and exits with code `2` on match; `pre-tool-use.js` translates exit code `2` into `{ decision: "deny", reason }`.
- **Caveat vs. demo visuals**: The demo UI shows `npm test` and a `92.4% coverage` badge after the agent self-corrects. `block-no-verify.js` itself only blocks Git hook-bypass flags; running tests or checking coverage comes from the repository's own Git hooks (or optional `strict`-profile commit checks in [`scripts/hooks/pre-bash-commit-quality.js`](../hooks/pre-bash-commit-quality.js)).

### Act 2 — GateGuard `rm -rf` (`31.90s–50.00s`) Accuracy

- **Backing sources**: [`scripts/hooks/gateguard-fact-force.js`](../hooks/gateguard-fact-force.js) (`isDestructiveBash`, `isDestructiveRm`, `destructiveBashMsg`), registered as `pre:bash:gateguard-fact-force` in [`scripts/hooks/bash-hook-dispatcher.js`](../hooks/bash-hook-dispatcher.js) (`standard`, `strict`) and [`hooks/hooks.json`](../../hooks/hooks.json).
- **What the code does**: Detects destructive shell patterns (`rm -rf`, destructive `git` commands, `dd`, `find -exec rm`, SQL `DROP TABLE`/`DELETE FROM`/`TRUNCATE`, and `GATEGUARD_BASH_EXTRA_DESTRUCTIVE`) and denies the first execution via `PreToolUse` `permissionDecision: "deny"` until the agent presents three items: (1) all files/data modified or deleted, (2) a one-line rollback procedure, and (3) the user's current instruction quoted verbatim.
- **Caveat vs. demo visuals**: GateGuard tracks first-touch command signatures in `GATEGUARD_STATE_DIR` (default `~/.gateguard`) so the second attempt after surfacing those facts is allowed. It does **not** semantically validate the correctness of the agent's rollback text or check test coverage.

### Act 3 — Fact-Force Edit Gate (`50.00s–69.20s`) Accuracy

- **Backing sources**: [`scripts/hooks/gateguard-fact-force.js`](../hooks/gateguard-fact-force.js) (`editGateMsg`, `writeGateMsg`, `pre:edit-write:gateguard-fact-force` in [`hooks/hooks.json`](../../hooks/hooks.json)).
- **What the code does**: On the first `Edit`, `Write`, or `MultiEdit` of a non-exempt file in a session, `editGateMsg()` denies the call (`PreToolUse` `permissionDecision: "deny"`) and requires four facts: (1) every file that imports/requires/calls the target file, (2) affected public functions/classes, (3) data file field names, structure, and date format (if the file reads/writes data files), and (4) the user's current instruction quoted verbatim.
- **Caveat vs. narration/visuals**: At `63.43s–68.70s` the narration (and card #3 in the UI) mentions *"identifying existing test coverage"*. **`gateguard-fact-force.js` does NOT check test coverage or require listing test files**—it asks for importers/callers, affected public API, data schemas (when applicable), and the verbatim instruction. It also uses first-touch per-file session state rather than programmatically verifying impact claims.

### Act 4 — Continuous Learning Daemon (`69.20s–95.80s`) Accuracy

- **Backing sources**: [`skills/continuous-learning-v2/SKILL.md`](../../skills/continuous-learning-v2/SKILL.md), [`scripts/hooks/observe-runner.js`](../hooks/observe-runner.js), [`skills/continuous-learning-v2/hooks/observe.sh`](../../skills/continuous-learning-v2/hooks/observe.sh), [`skills/continuous-learning-v2/agents/start-observer.sh`](../../skills/continuous-learning-v2/agents/start-observer.sh), [`skills/continuous-learning-v2/agents/observer-loop.agy.sh`](../../skills/continuous-learning-v2/agents/observer-loop.agy.sh) (and [`observer-loop.sh`](../../skills/continuous-learning-v2/agents/observer-loop.sh)), [`skills/continuous-learning-v2/scripts/instinct-cli.py`](../../skills/continuous-learning-v2/scripts/instinct-cli.py), [`skills/continuous-learning-v2/config.json`](../../skills/continuous-learning-v2/config.json).
- **What the code does**: `observe-runner.js` runs `observe.sh` on `PreToolUse` and `PostToolUse` to append tool events to project-scoped `observations.jsonl` and signals the background observer loop (`SIGUSR1` every `N` observations). When enabled, the observer analyzes batches of observations and writes atomic YAML instinct files under `instincts/personal/` with confidence weights (`0.3–0.85` / `0.3–0.9`).
- **Caveats vs. narration/visuals**:
  - Background observation analysis is opt-in: `observer.enabled` defaults to `false` in [`skills/continuous-learning-v2/config.json`](../../skills/continuous-learning-v2/config.json).
  - The demo card displays `~/.ecc/instincts/jwt-refresh-rotation.yaml`; the actual v2.1 storage path is `${XDG_DATA_HOME:-~/.local/share}/ecc-homunculus/projects/<project-hash>/instincts/personal/` (overrideable with `CLV2_HOMUNCULUS_DIR`).
  - The observer extracts atomic YAML instincts automatically once thresholds are met, whereas clustering instincts into evolved skills, commands, or agents is triggered via `instinct-cli.py evolve` (`/evolve`) rather than silently mutating repository rule files.

### Outro (`95.80s–109.50s`) Accuracy

- **Backing sources**: [`scripts/hooks/agy/pre-invocation.js`](../hooks/agy/pre-invocation.js) and [`scripts/hooks/session-start.js`](../hooks/session-start.js) (`summarizeActiveInstincts`).
- **What the code does**: On turn 0 (`invocationNum === 0`), `pre-invocation.js` executes `SessionStart` hooks and injects returned `additionalContext` as `ephemeralMessage` steps; `session-start.js` summarizes active project/global instincts and recent session context (bounded by `ECC_SESSION_START_MAX_CHARS`).
- **Caveat vs. demo visuals**: Act 5 visuals state `"0 Context Window Tokens Consumed"`; injecting startup `ephemeralMessage` / `additionalContext` still occupies model context tokens for the injected summary, though it requires zero manual user prompt setup.

## Re-Recording Steps

1. Generate the updated narration audio using Google AI Studio TTS (24 kHz mono PCM WAV) and save it to `docs/assets/voiceover.wav`.
2. Check the exact duration with `ffprobe`:

   ```bash
   ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 docs/assets/voiceover.wav
   ```

3. Update `SUBTITLES` and `TOTAL_DURATION` (`<duration> + 1.54` outro fade buffer, matching `OUTRO_BUFFER_SEC` in [`render.js`](./render.js)), along with any shifted act/reveal timestamps, in [`scripts/demo-video/player.html`](./player.html), [`scripts/demo-video/player-mobile.html`](./player-mobile.html), and [`scripts/demo-video/player-portrait.html`](./player-portrait.html).
4. Update `SFX_CUES` (`delayMs` values) in [`scripts/demo-video/render.js`](./render.js) so UI sound effects stay aligned with visual reveals and voiceover cues.
5. Re-render desktop, mobile, and portrait videos from the repository root:

   ```bash
   node scripts/demo-video/render.js
   node scripts/demo-video/render.js --mobile
   node scripts/demo-video/render.js --portrait
   ```
