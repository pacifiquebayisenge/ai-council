# AI Council — local-first architecture

All inference happens on the user's computer through Ollama at `localhost:11434`. The Nuxt/Nitro backend orchestrates the agents. SQLite at `data/ai-council.db` stores sessions, messages, agent memories, open questions, and verified user context. No cloud inference API is required.

## Current pipeline

1. Receive a question or correction.
2. Load the last 30 user-authored messages from the current session (not agent responses).
3. Ask the local Ollama model to extract structured facts, stable topic keys, corrections and missing information.
4. Reject extracted facts without an exact quote from the indexed user message. Resolve conflicting facts by keeping the latest statement for the same key.
5. Persist verified context in SQLite (`council_user_context`) and provide it to the debate agents, speaker arbitration and conclusion.
6. If extraction fails, pass raw user statements and previously verified context instead of manufacturing facts.
7. Expose the saved context locally via `GET /api/council/context?sessionId=...`.

## Planned phases

- **Argument ledger:** Persist claim, evidence, objection, status (supported/disputed/retracted), and agent attribution. Reject repetition of already-resolved claims.
- **Local tools:** Deterministic calculator and optional user-controlled local document retrieval. Explicitly mark when a market price or real-time fact cannot be verified offline.
- **Independent verifier:** Before the chair concludes, check recommendations against verified user constraints and label unsupported statements.
- **Model routing:** Per-agent Ollama model selection with installed-model discovery, context-budget limits, and latency measurement.
- **3D room:** Replace procedural avatar meshes with locally bundled rigged GLB characters and animation clips; synchronize gestures with server activity events, not fabricated token-by-token thought states.

## Limitations

The fact extractor uses a local language model and may miss or mislabel information. Exact-quote validation checks provenance, not semantic truth. Only the latest 30 user messages are re-extracted; previously verified memory is retained as fallback. The current UI does not yet offer editing or deleting individual facts. This is a first implementation, not a finished reasoning engine.

## Running locally

```sh
pnpm install
pnpm dev
```

Ollama must be running with the configured model (currently `qwen3.5:9b`). No external API key is needed.

## Workspace (implemented incrementally)

- **Ideas:** Live list of agent proposals, objections and revisions, derived from the current transcript. Not yet a persistent claim/evidence ledger.
- **Memory:** Per-session verified facts are editable and deletable via `PATCH /api/council/context` and `DELETE /api/council/context`. User edits and deleted-key exclusions survive subsequent fact extraction. Cross-session memory search is not yet implemented.
- **Models:** Per-agent model overrides are validated against installed Ollama models for each request. Defaults remain `qwen3.5:9b`.
- **Research:** Local deterministic arithmetic endpoint `POST /api/council/calculate` and calculator UI. Agents do not yet invoke it autonomously. Local document retrieval is pending.
- **Voice:** Not implemented. Offline-only voice requires a locally installed TTS engine and corresponding audio-to-mouth animation; browser speech synthesis cannot guarantee local execution.
- **Health:** `GET /api/council/health` checks local Ollama, required model and SQLite.
- **Avatars:** An illustrated fallback is now present when the WebGL renderer fails. Full-body rigged 3D models and synchronized animations remain pending.

All changes require local testing with Nuxt and Ollama before being considered production-ready.
