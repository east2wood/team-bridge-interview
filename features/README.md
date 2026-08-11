# Feature Specifications

Executable specifications for TeamBridge Assist, written in Gherkin. These are the behavioural contract: if a scenario here passes, the feature works. If you change behaviour, change the scenario in the same commit.

## Layout

Feature files mirror the service layout, one directory per bounded area:

| Directory | Covers | Implemented by |
|---|---|---|
| `hotkeys/` | Global shortcut registration and modes | `native/global_hotkey.cpp`, `services/settings` |
| `session/` | Recording lifecycle, first-run consent, crash safety | `main/session_manager` |
| `audio/` | WASAPI loopback, microphone, buffering, mixing | `native/wasapi_capture.cpp`, `services/audio` |
| `voice/` | Silero VAD segmentation | `services/voice` |
| `transcription/` | Python worker lifecycle, live transcript stream | `services/transcription` |
| `overlay/` | Floating window | `renderer/overlay` |
| `history/` | Session list, search | `services/history` |
| `clipboard/` | Copy and auto-copy | `services/clipboard` |
| `settings/` | All user-configurable state | `services/settings` |
| `ai/` | Optional LLM features and provider config | `services/ai` |

## Tags

| Tag | Meaning |
|---|---|
| `@mvp` | One of the seven MVP items. These must pass before anything else ships. |
| `@windows` | Depends on Windows-specific APIs; cannot run on other platforms. |
| `@gpu` | Requires a CUDA-capable GPU; skipped on CPU-only CI with an explicit skip reason, never silently. |
| `@manual` | Requires real hardware or a human observer (device hot-swap, audio output quality). Not run in CI. |
| `@slow` | Loads a Whisper model or otherwise takes >10s. |
| `@privacy` | Asserts a privacy guarantee. Never weaken one of these to make a test pass. |

## Determinism

**Scenarios do not use real audio devices.** The capture layer sits behind an interface with a fixture driver that plays a WAV file into the pipeline at wall-clock rate (or faster, when the scenario says so). This is what makes STT assertions stable — `Given the system is playing the fixture "two-speakers-30s.wav"` feeds known audio with a known reference transcript.

Fixtures live in `features/fixtures/audio/`, each with a sibling `.expected.json` holding the reference transcript and segment boundaries. Transcript assertions compare against the reference with a word error rate threshold rather than exact string equality — Whisper output varies across model versions and hardware, and an exact-match assertion would be a permanently red test.

Three things are always faked in CI: the audio device, the system clock (for `Today` / `Yesterday` grouping), and the AI provider (a recorded-response stub). The Python Whisper worker is real in `@slow` scenarios and stubbed elsewhere.

## Ubiquitous language

Use these terms exactly; they mean different things.

| Term | Definition |
|---|---|
| **Session** | One recording, start to stop. Has an id, timestamps, source, language, duration. |
| **Segment** | One committed unit of transcript within a session, with start/end offsets and a confidence. The persisted unit. |
| **Speech segment** | A span of audio the VAD marked as speech. Input to Whisper; not persisted. One speech segment usually yields one segment, but may yield several. |
| **Partial** | Provisional transcript text for a speech segment still being processed. Displayed, never persisted. |
| **Channel** | `system` or `microphone`. Preserved through the pipeline when the mic is enabled; absent when it is not. |
| **Capture** | Pulling PCM off a device. Distinct from **recording**, which is a user-visible session that may include writing audio to disk. |

## Running

```bash
npm run test:features           # everything except @manual and @slow
npm run test:features -- --tags "@mvp"
npm run test:features -- --tags "not @gpu"
```

Step definitions live in `features/steps/`, shared world and fixture drivers in `features/support/`.
