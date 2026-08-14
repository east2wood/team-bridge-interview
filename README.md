# TeamBridge Assist

A Windows desktop assistant for meetings, interviews, and calls. It captures what your machine hears, transcribes it live, and puts an AI assistant next to the conversation — answering questions, taking notes, and summarizing when it's over.

> **Status:** early alpha. The MVP path works end to end — global hotkey → WASAPI loopback capture → Silero VAD → Faster-Whisper → live overlay → SQLite → clipboard. Behaviour is specified as executable Gherkin in [`features/`](features/README.md); the roadmap below marks what is built.

---

## What it does

| Capability | What it means in practice |
|---|---|
| **Windows audio capture** | Records system output (what the other people say) *and* your microphone, as two separate streams. |
| **Live transcription** | Streaming speech-to-text with speaker separation (`them` / `me`), rendered as the meeting happens. |
| **AI meeting assistant** | An always-available panel that answers questions about the live conversation — "what did they just ask?", "draft a reply to that objection". |
| **Interview support** | A low-latency mode tuned for being asked questions: detects a question in the incoming audio and surfaces a suggested answer within a couple of seconds. |
| **Notes** | Manual + AI-captured notes, timestamped against the transcript so every note links back to the moment it came from. |
| **Summaries** | Post-call summary: decisions, action items with owners, open questions, and a full transcript export. |
| **Clipboard helper** | Global hotkey to send clipboard contents to the assistant, and to paste an assistant answer wherever your cursor is. |

**Design constraint that shapes everything:** this is an assistant for *live* conversation. Anything that takes longer than ~2 seconds to appear on screen is a background feature, not a live one. The architecture separates the two explicitly (see [Latency budget](#latency-budget)).

---

## Architecture

Electron, three processes, hard boundaries between them.

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React + TypeScript)                                  │
│  · transcript view · assistant panel · notes · settings        │
│  · Web Audio capture of loopback + mic (MediaStream)           │
│  no filesystem, no network, no API keys — contextIsolation on  │
└──────────────────────────┬────────────────────────────────────┘
                           │ typed IPC (preload contextBridge)
┌──────────────────────────┴────────────────────────────────────┐
│ Main (Node)                                                    │
│  · window/tray/global shortcuts   · SQLite session store       │
│  · STT provider adapter           · Claude client (streaming)  │
│  · secret storage (safeStorage)   · clipboard bridge           │
└──────────────────────────┬────────────────────────────────────┘
                           │
                  ┌────────┴────────┐
                  │  Python worker  │  Silero VAD + Faster-Whisper
                  │  (child proc)   │  — CPU/GPU heavy, isolated
                  └─────────────────┘
```

Why this split:

- **Audio capture lives in the renderer** because `getDisplayMedia` / `getUserMedia` are renderer-only APIs. The renderer downsamples to 16 kHz mono PCM and ships frames over IPC; it never touches the network.
- **Every credential lives in main**, encrypted with Electron's `safeStorage` (DPAPI-backed on Windows). The renderer can request an AI completion; it can never see the API key.
- **Transcription runs in a Python child process** so a CUDA fault, a model stall, or a segfault takes down a restartable child rather than the app and the recording with it. It speaks line-delimited JSON on stdio; the app owns the session and the queue, the worker owns the model and the audio buffer.

### Audio capture on Windows

Two independent streams, mixed only for display:

```ts
// main: allow loopback audio for our own capture requests
session.defaultSession.setDisplayMediaRequestHandler(
  (request, callback) => {
    callback({ video: undefined, audio: 'loopback' })  // WASAPI loopback
  },
  { useSystemPicker: false },
)
```

- **System audio** — `navigator.mediaDevices.getDisplayMedia({ audio: true })` with the handler above. On Windows this yields a WASAPI loopback capture of the default render device: everything the machine plays, regardless of which app plays it. No per-app hooks, no virtual cable install.
- **Microphone** — plain `getUserMedia({ audio: { echoCancellation: false } })`. Echo cancellation is *off* deliberately: the loopback stream is already separate, so AEC would only degrade your own voice.

Speaker attribution is therefore structural, not inferred — `them` is whatever came off loopback, `me` is whatever came off the mic. This is far more reliable than diarizing a mixed stream, and it's the main reason for the two-stream design.

**Known limits:** loopback follows the default render device, so switching output devices mid-call requires re-acquiring the stream (handled by a device-change listener). Audio routed to a non-default device is not captured.

### Transcription

Local only, and offline by construction: **Silero VAD** for segmentation, **Faster-Whisper** (`turbo` or `large-v3`) for recognition, both inside one Python worker.

VAD lives with the model rather than in TypeScript because Silero ships as an ONNX model inside `faster-whisper` — running it there costs no extra dependency, no torch, and keeps audio in exactly one place. Nothing reaches Whisper that VAD has not marked as speech, so silence costs no GPU time and produces no hallucinated transcript.

Segmentation policy (tunable in [`whisper_worker.py`](services/transcription/worker/whisper_worker.py)):

| Knob | Default | Why |
|---|---|---|
| Silence hangover | 700 ms | Shorter splits mid-sentence at natural pauses |
| Min speech | 250 ms | Below this it's a click, not a word |
| Max speech | 20 s | Whisper degrades on longer input; also bounds worst-case VAD cost |
| Speech padding | 200 ms | Stops VAD clipping the first and last phoneme |
| VAD interval | 400 ms | How much new audio to collect before re-scanning — see below |
| Partial look-back | 12 s | Bounds the cost of re-transcribing an in-progress utterance |

**The VAD interval is load-bearing, not a micro-optimisation.** `get_speech_timestamps` scans the whole buffer, so running it per 20 ms frame is O(n²) in utterance length: with continuous speech the buffer grows toward the max-speech cap and VAD re-scans all of it 50 times a second. Measured on a GTX 1050 Ti, that made the worker fall permanently behind — 53 s of speech produced **zero** committed segments and never drained. Scanning ~2.5 times a second instead is ~20× less work and still detects end-of-utterance well inside the hangover window.

Measured after the fix, same hardware and audio, fed at exactly 1× real time:

| | Before | After |
|---|---|---|
| Segments committed | 0 | 12 |
| Lag behind live | unbounded | 2–3 s, constant |
| Drain after stop | never finished | 1.5 s |

The worker emits two kinds of result. **Partials** are provisional text for speech still being spoken — re-transcribed every 2 s at `beam_size=1`, displayed, never persisted. **Segments** are committed at `beam_size=5`, written to SQLite as they commit. Only segments reach storage or the AI layer; partials churn too much to be worth either.

GPU is used when CUDA is available and falls back to CPU `int8` automatically — but never silently: the fallback is surfaced to the user, because a 10× slowdown that nobody mentioned reads as a bug.

### AI layer (optional, not yet built)

Transcription is local and mandatory; AI reasoning is remote and optional. **Nothing in the recording path may depend on a provider being reachable** — with no key configured, record → transcribe → save → copy all still work, and no network request is made. That invariant is asserted in [`features/ai/ai-provider.feature`](features/ai/ai-provider.feature).

Providers are interchangeable behind one interface, configured in settings: DeepSeek by default, OpenAI or Anthropic equally valid. Whichever produced a summary is recorded alongside it, so switching later doesn't invalidate stored output.

Two rules the implementation will enforce when this lands:

1. **Streaming on every user-facing call.** A four-second wait for a complete response is unusable mid-conversation.
2. **Prompt caching carries the transcript.** The context is one append-only document — stable system prompt, then the transcript with the cache breakpoint moving forward as segments commit, then the volatile question last. Nothing volatile may sit above the breakpoint or the whole prefix re-bills.

API keys are encrypted with the OS credential store, never written to the preferences file, and never exposed to the renderer.

### Storage

`better-sqlite3`, one DB file per install under `app.getPath('userData')`.

```
sessions(id, title, started_at, ended_at, source_app)
segments(id, session_id, channel, t_start_ms, t_end_ms, text)
notes(id, session_id, t_ms, body, origin)          -- origin: 'user' | 'ai'
summaries(id, session_id, kind, body, model, created_at)
messages(id, session_id, role, content, created_at) -- assistant conversation
```

Audio is **not** retained by default — PCM frames are transcribed and discarded. Opt-in recording writes Opus to disk alongside the session.

### Latency budget

The number that governs the whole design, for interview mode:

| Stage | Target |
|---|---|
| Loopback capture → PCM frame | ~50 ms |
| STT partial (cloud) | ~300 ms |
| Segment upload → TeamBridge | ~100 ms |
| First assistant token (Opus 5, `effort: low`, cached prefix) | ~700 ms |
| **Total to first useful word on screen** | **~1.3 s** |

Anything that would blow this budget — full-context reasoning, summaries, search — belongs to the background path and is allowed to take as long as it needs.

---

## Roadmap

Ordered by dependency, not by ambition. Each phase is independently useful.

### Phase 1 — Capture *(built)*
- [x] Electron + Vite + TypeScript shell; `contextIsolation: true`, `nodeIntegration: false`
- [x] Loopback capture via `setDisplayMediaRequestHandler` + `audio: 'loopback'`
- [x] Mic capture, independent stream, off by default
- [x] Downsample to 16 kHz mono Int16 in an `AudioWorklet`; 20 ms frames → IPC
- [x] Level meter in the overlay header
- [ ] Device-change handling (re-acquire loopback when the default output changes)
- [ ] Optional on-disk recording (Opus)

### Phase 2 — Live transcription *(built)*
- [x] Python worker: Silero VAD + Faster-Whisper, line-delimited JSON on stdio
- [x] GPU with automatic, visible CPU fallback
- [x] Crash recovery: restart with backoff, stop after 3 and surface the traceback
- [x] Partial and committed segments, with partials superseded on commit
- [x] Live transcript in the overlay, auto-scroll with scroll-lock
- [x] Persist segments to SQLite as they commit
- [ ] Model download progress UI (currently a silent first-run wait)

### Phase 3 — AI meeting assistant
- [ ] Main-process Claude client; `safeStorage`-encrypted key
- [ ] Streaming responses to the renderer over IPC
- [ ] Prompt assembly with cache breakpoints on the transcript prefix
- [ ] Assistant panel: ask about the live conversation, answers stream in
- [ ] Cache-hit telemetry surfaced in settings (`cache_read_input_tokens`)

### Phase 4 — Interview support
- [x] Answer as an explicit capture boundary, in place of question detection
- [ ] Low-latency suggestion path: `effort: 'low'`, transcript prefix pre-warmed
- [ ] Compact always-on-top overlay mode
- [ ] Per-session context: paste in a job description, resume, or product brief

### Phase 4.5 — Shipped alongside the MVP
- [x] Global hotkey (toggle), tray menu, single-instance lock
- [x] Session lifecycle with crash repair on next launch
- [x] Consent notice before any device is opened
- [x] Copy transcript, auto-copy on finish
- [x] SQLite schema with FTS5 index kept in sync by triggers
- [ ] Push-to-talk — needs a native keyboard hook; selecting it currently falls back to toggle
- [ ] History and search UI (the data and queries exist; nothing renders them yet)

### Phase 5 — Notes
- [ ] Manual notes, timestamped against the transcript, click-to-seek
- [ ] AI-captured notes (decisions and action items detected as they're spoken)
- [ ] Hotkey to note the last 30 seconds without leaving the call
- [ ] Markdown export

### Phase 6 — Summaries
- [ ] End-of-session summary: decisions, action items + owners, open questions
- [ ] Incremental mid-call summary for long meetings (folds older transcript, keeps context bounded)
- [ ] Export: Markdown, plain text, clipboard

### Phase 7 — Clipboard helper
- [ ] Global hotkey: send clipboard to the assistant with a chosen action
- [ ] Global hotkey: paste the last assistant answer at the cursor
- [ ] Clipboard history scoped to the session
- [ ] Rewrite / summarize / translate actions on selected text

### Later
- [ ] Meeting-app detection (Teams, Zoom, Meet) to auto-title and auto-start
- [ ] Speaker naming within the `them` channel
- [ ] Search across all past sessions
- [ ] Custom prompt templates per meeting type

---

## Stack

| Layer | Choice | Note |
|---|---|---|
| Shell | Electron 33 | The only cross-process runtime that gives loopback audio + a real web UI on Windows |
| Language | TypeScript, strict | `noUncheckedIndexedAccess` on |
| UI | React + Zustand | |
| Build | electron-vite, electron-builder | NSIS installer |
| Audio | WASAPI loopback via `setDisplayMediaRequestHandler` | No native addon, no virtual cable |
| Resampling | `AudioContext({ sampleRate: 16000 })` + `AudioWorklet` | Chromium resamples; no hand-rolled resampler to get wrong |
| VAD | Silero (ONNX, bundled with faster-whisper) | In the Python worker; no torch |
| STT | Faster-Whisper (`turbo` / `large-v3`) | CUDA `float16`, CPU `int8` fallback |
| Python | 3.11+ | Child process, line-delimited JSON on stdio |
| DB | `better-sqlite3` + FTS5 | Synchronous, main-process only, WAL |
| Logging | Pino | |
| Secrets | `safeStorage` | DPAPI-backed on Windows |

**`native/` is deliberately empty.** Electron's display-media handler provides WASAPI loopback and `globalShortcut` provides the hotkey, so the MVP needs no C++ and no node-gyp toolchain. A native layer earns its place when we want per-application capture, exclusive-mode diagnostics, or true push-to-talk (see below).

---

## Getting started

**Requirements:** Windows 10 1903+ (loopback capture), Node 20+, Python 3.11+.

```bash
npm install            # also rebuilds better-sqlite3 for Electron and draws the icons
npm run python:setup   # venv + faster-whisper (picked up automatically in dev)
npm run dev            # Electron + Vite with HMR
```

Then press **Ctrl+Shift+Space** to start and stop recording. The overlay appears bottom-right; the app otherwise lives in the tray.

The Whisper model downloads on first use and is cached by `faster-whisper`. The default is `turbo` (~1.6 GB), so the first recording stalls until it lands. Pick a smaller one from **tray → Model** to start immediately — `tiny` is ~75 MB and good enough to confirm the pipeline works. Model changes are disabled while recording and take effect as soon as the session ends.

Other commands:

```bash
npm run typecheck    # both tsconfig projects
npm run build        # production bundles into out/
npm run dist         # NSIS installer into release/
```

**GPU.** CUDA is used automatically when it works, otherwise CPU. The compute type is chosen from what the card reports it supports — `float16` where available, `float32` on pre-Volta cards (compute capability < 7.0, e.g. GTX 10xx) which cannot do half precision at all.

CTranslate2 also needs the CUDA 12 maths libraries at runtime, and a GPU without them **loads the model successfully and then fails on the first transcription**. The worker therefore runs a real inference before reporting ready, so that failure becomes a startup fallback rather than an engine that looks healthy and silently drops every segment. To enable the GPU:

```bash
.venv/Scripts/python.exe -m pip install -r services/transcription/worker/requirements-cuda.txt
```

Roughly 600 MB; the worker adds these packages' DLL directories to the search path itself, since Windows will not look inside `site-packages`. Any fallback to CPU is reported in the overlay and the tray, never left to be discovered as slowness — which matters because `turbo` and `large-v3` are far slower than real time on CPU. On CPU, use `small` or `tiny`.

---

## Privacy

Meeting audio is among the most sensitive data a desktop app can touch. The defaults reflect that:

- **Nothing is recorded to disk unless you turn recording on.** Audio frames are transcribed in memory and dropped.
- **Local transcription is the default**, so with the local provider selected, no audio ever leaves the machine.
- **Only transcript text is sent to the AI provider**, never audio — and only when you invoke the assistant or a summary.
- **A visible capture indicator** is on whenever a stream is live. There is no hidden-capture mode, and there won't be one.
- **You are responsible for consent.** Recording or transcribing a conversation without the other participants' knowledge is illegal in many jurisdictions (two-party-consent states in the US, and most of the EU under GDPR). The app will prompt about this on first run; that prompt is not legal advice, and it doesn't transfer the obligation.

---

## License

TBD.
