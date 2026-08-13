"""Speech engine: Silero VAD segmentation + Faster-Whisper transcription.

Runs as a child process of the Electron app and speaks line-delimited JSON on
stdio. It owns the model and the audio buffer; the app owns the session and
the queue.

Protocol
--------
in   {"type": "audio",  "channel": "system", "pcm": "<base64 int16 mono 16k>"}
     {"type": "flush"}                      transcribe buffered speech now
     {"type": "reset"}                      drop buffered audio untranscribed
out  {"type": "ready",   "model": ..., "device": ..., "compute_type": ...}
     {"type": "partial", "channel": ..., "text": ...}
     {"type": "segment", "channel": ..., "text": ..., "start_ms": ..,
                         "end_ms": .., "confidence": .., "language": ..}
     {"type": "flushed"} | {"type": "log", ...} | {"type": "error", ...}

Why VAD lives here rather than in TypeScript: Silero ships with
faster-whisper as an ONNX model, so running it in this process costs no extra
dependency and keeps audio in exactly one place.
"""

from __future__ import annotations

import argparse
import base64
import json
import queue
import sys
import threading
import time
from dataclasses import dataclass, field

import numpy as np

SAMPLE_RATE = 16000

# Segmentation policy. These are the knobs worth tuning against real calls.
SILENCE_HANGOVER_MS = 700      # silence before an utterance is considered over
MIN_SPEECH_MS = 250            # shorter than this is a click, not speech
MAX_SPEECH_S = 20              # hard cut; also bounds worst-case VAD cost
SPEECH_PAD_MS = 200            # keep a little air either side of speech
VAD_THRESHOLD = 0.5
PARTIAL_INTERVAL_S = 2.0       # how often to re-transcribe in-progress speech
MAX_PARTIAL_S = 12.0           # partials look back at most this far
MAX_BUFFER_S = 120             # backstop against unbounded growth

# How much new audio to accumulate before re-running VAD.
#
# This is the difference between working and not. get_speech_timestamps scans
# the whole buffer, so running it per 20 ms frame is O(n²) in utterance length:
# with continuous speech the buffer grows toward MAX_SPEECH_S and VAD re-scans
# all of it 50 times a second, until the worker falls permanently behind and
# commits nothing. Scanning ~2.5 times a second is ~20x less work and still
# detects an end-of-utterance well inside the hangover window.
VAD_INTERVAL_MS = 400


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg: str, level: str = "debug") -> None:
    emit({"type": "log", "level": level, "msg": msg})


@dataclass
class ChannelBuffer:
    """Rolling audio for one channel, plus where it sits on the session timeline."""

    name: str
    audio: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    consumed_samples: int = 0      # samples dropped from the front so far
    unscanned_samples: int = 0     # appended since VAD last ran
    last_partial_at: float = 0.0
    last_partial_text: str = ""

    def append(self, pcm: np.ndarray) -> None:
        self.audio = np.concatenate((self.audio, pcm)) if self.audio.size else pcm
        self.unscanned_samples += pcm.size

    def drop_front(self, n: int) -> None:
        n = min(n, self.audio.size)
        self.audio = self.audio[n:]
        self.consumed_samples += n

    def offset_ms(self, sample_index: int) -> int:
        return int((self.consumed_samples + sample_index) * 1000 / SAMPLE_RATE)


def _enable_bundled_cuda_libs() -> None:
    """
    Make pip-installed NVIDIA runtime libraries loadable on Windows.

    `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` drop their DLLs inside
    site-packages rather than on PATH, and Windows will not search there, so
    CTranslate2 fails at the first matrix multiply with a missing-DLL error
    even though the package is installed.

    Both mechanisms are needed. `os.add_dll_directory` only affects loads that
    opt into the user search path; CTranslate2 resolves the CUDA libraries with
    a plain LoadLibrary, which consults PATH and ignores added directories —
    so PATH is the one that actually fixes it here.
    """
    if sys.platform != "win32":
        return
    try:
        import site

        roots = [*site.getsitepackages(), site.getusersitepackages()]
    except Exception:  # noqa: BLE001
        return

    import os
    from pathlib import Path

    added: list[str] = []
    for root in roots:
        nvidia = Path(root) / "nvidia"
        if not nvidia.is_dir():
            continue
        for bin_dir in sorted(nvidia.glob("*/bin")):
            if not any(bin_dir.glob("*.dll")):
                continue
            path = str(bin_dir)
            try:
                os.add_dll_directory(path)
            except OSError:
                pass
            added.append(path)

    if added:
        os.environ["PATH"] = os.pathsep.join([*added, os.environ.get("PATH", "")])
        log(f"enabled {len(added)} bundled CUDA library directories")


class Engine:
    def __init__(self, model_name: str, device: str, language: str, partials: bool):
        self.language = None if language == "auto" else language
        self.partials = partials
        self.detected_language: str | None = None
        self.buffers: dict[str, ChannelBuffer] = {}

        _enable_bundled_cuda_libs()

        from faster_whisper import WhisperModel
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        self._get_speech_timestamps = get_speech_timestamps
        self._vad_options = VadOptions(
            threshold=VAD_THRESHOLD,
            min_speech_duration_ms=MIN_SPEECH_MS,
            max_speech_duration_s=MAX_SPEECH_S,
            min_silence_duration_ms=SILENCE_HANGOVER_MS,
            speech_pad_ms=SPEECH_PAD_MS,
        )

        resolved_device, compute_type = self._resolve_device(device)
        notice: str | None = None

        try:
            self.model = self._load(WhisperModel, model_name, resolved_device, compute_type)
        except Exception as err:  # noqa: BLE001
            # A GPU that advertises CUDA can still fail: missing cuBLAS/cuDNN,
            # too little VRAM, or a compute type the card cannot really run.
            # Some of those only surface on the first matrix multiply, which is
            # why _load runs a real inference before declaring success.
            if resolved_device != "cuda":
                raise
            log(f"GPU unusable ({err}); falling back to CPU", "warn")
            notice = f"The GPU could not be used ({err}). Running on CPU, which is much slower."
            resolved_device, compute_type = "cpu", self._best_compute_type("cpu")
            self.model = self._load(WhisperModel, model_name, resolved_device, compute_type)

        if resolved_device == "cpu" and model_name in ("turbo", "large-v3", "medium"):
            extra = f"`{model_name}` on CPU is far slower than real time — consider `small` or `tiny`."
            notice = f"{notice} {extra}" if notice else extra

        emit({
            "type": "ready",
            "model": model_name,
            "device": resolved_device,
            "compute_type": compute_type,
            **({"notice": notice} if notice else {}),
        })

    def _load(self, WhisperModel, model_name: str, device: str, compute_type: str):  # noqa: N803
        """Load the model and prove it can actually run before reporting ready."""
        log(f"loading model {model_name} on {device} ({compute_type})", "info")
        model = WhisperModel(model_name, device=device, compute_type=compute_type)

        # Self-test. Loading succeeds on a GPU whose maths libraries are
        # missing; the failure appears at the first transcription. Without this
        # the app reports a healthy engine and then drops every segment.
        probe = np.zeros(SAMPLE_RATE, dtype=np.float32)
        segments, _ = model.transcribe(probe, language="en", beam_size=1, vad_filter=False)
        list(segments)
        log(f"self-test passed on {device}", "info")
        return model

    @classmethod
    def _resolve_device(cls, requested: str) -> tuple[str, str]:
        """CPU fallback is automatic but never silent — the app tells the user."""
        if requested == "cpu":
            return "cpu", cls._best_compute_type("cpu")
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", cls._best_compute_type("cuda")
        except Exception as err:  # noqa: BLE001 - any failure means no usable GPU
            log(f"CUDA unavailable ({err}); falling back to CPU", "warn")
        return "cpu", cls._best_compute_type("cpu")

    @staticmethod
    def _best_compute_type(device: str) -> str:
        """
        Ask the device what it can actually run rather than assuming.

        float16 is unsupported on pre-Volta cards (compute capability < 7.0),
        and requesting it there fails the load outright instead of degrading.

        int8_float32 is preferred over float32 as the pre-Volta fallback: those
        cards do have int8 (DP4A), it is faster than float32 there, and it uses
        roughly a quarter of the memory — which decides whether a larger model
        fits at all on a 4 GB card.
        """
        preference = (
            ("float16", "int8_float16", "bfloat16", "int8_float32", "float32", "int8")
            if device == "cuda"
            else ("int8", "int8_float32", "float32")
        )
        try:
            import ctranslate2

            supported = ctranslate2.get_supported_compute_types(device)
            for candidate in preference:
                if candidate in supported:
                    return candidate
            log(f"no preferred compute type in {sorted(supported)}; using default", "warn")
        except Exception as err:  # noqa: BLE001
            log(f"could not query compute types for {device} ({err})", "warn")
        return "float32" if device == "cuda" else "int8"

    def buffer_for(self, channel: str) -> ChannelBuffer:
        if channel not in self.buffers:
            self.buffers[channel] = ChannelBuffer(name=channel)
        return self.buffers[channel]

    def add_audio(self, channel: str, pcm_bytes: bytes) -> None:
        pcm = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        buf = self.buffer_for(channel)
        buf.append(pcm)

        # Backstop: if the consumer ever wedges, drop the oldest audio rather
        # than growing until the process is killed by the OS.
        limit = MAX_BUFFER_S * SAMPLE_RATE
        if buf.audio.size > limit:
            overflow = buf.audio.size - limit
            buf.drop_front(overflow)
            log(f"{channel}: dropped {overflow / SAMPLE_RATE:.1f}s of buffered audio", "warn")

        # Throttle: VAD scans the whole buffer, so running it per frame is
        # quadratic in utterance length. See VAD_INTERVAL_MS.
        if buf.unscanned_samples < VAD_INTERVAL_MS * SAMPLE_RATE / 1000:
            return
        buf.unscanned_samples = 0
        self.process(buf, final=False)

    def process(self, buf: ChannelBuffer, final: bool) -> None:
        """Cut completed speech regions out of the buffer and transcribe them."""
        if buf.audio.size < SAMPLE_RATE // 2 and not final:
            return

        hangover = int(SILENCE_HANGOVER_MS * SAMPLE_RATE / 1000)

        while True:
            regions = self._get_speech_timestamps(buf.audio, self._vad_options)
            if not regions:
                # Nothing but silence. Keep a hangover's worth so an utterance
                # starting at the boundary is not clipped, discard the rest.
                if buf.audio.size > hangover:
                    buf.drop_front(buf.audio.size - hangover)
                return

            first = regions[0]
            start, end = int(first["start"]), int(first["end"])
            complete = final or (buf.audio.size - end) >= hangover

            if not complete:
                self._maybe_partial(buf, start)
                return

            audio = buf.audio[start:end]
            if audio.size >= MIN_SPEECH_MS * SAMPLE_RATE / 1000:
                self._transcribe(buf, audio, start_sample=start, partial=False)
            buf.drop_front(end)
            buf.last_partial_text = ""

            if buf.audio.size == 0:
                return

    def _maybe_partial(self, buf: ChannelBuffer, start_sample: int) -> None:
        if not self.partials:
            return
        in_progress = buf.audio[start_sample:]
        if in_progress.size < PARTIAL_INTERVAL_S * SAMPLE_RATE:
            return
        now = time.monotonic()
        if now - buf.last_partial_at < PARTIAL_INTERVAL_S:
            return
        buf.last_partial_at = now

        # Bound the work: re-transcribing a growing utterance every 2s is
        # quadratic too. Partials are throwaway previews, so looking back a
        # few seconds is enough — the committed segment covers the whole span.
        max_partial = int(MAX_PARTIAL_S * SAMPLE_RATE)
        offset = max(0, in_progress.size - max_partial)
        self._transcribe(
            buf, in_progress[offset:], start_sample=start_sample + offset, partial=True
        )

    def _transcribe(
        self, buf: ChannelBuffer, audio: np.ndarray, start_sample: int, partial: bool
    ) -> None:
        # Tell the app a final segment is being worked on, so the UI can say
        # "1 segment transcribing" instead of looking idle mid-sentence.
        if not partial:
            emit({"type": "busy", "transcribing": True})
        try:
            segments, info = self.model.transcribe(
                audio,
                language=self.language or self.detected_language,
                # Partials are throwaway; spend the beam search on final text.
                beam_size=1 if partial else 5,
                vad_filter=False,  # VAD already ran; running it twice clips speech
                condition_on_previous_text=False,
            )
            segments = list(segments)
        except Exception as err:  # noqa: BLE001 - a bad chunk must not kill the worker
            emit({"type": "error", "msg": f"transcription failed: {err}"})
            return
        finally:
            if not partial:
                emit({"type": "busy", "transcribing": False})

        text = " ".join(s.text.strip() for s in segments).strip()
        if not text:
            return

        # Detect once, then reuse: re-detecting per segment lets a noisy chunk
        # flip the whole session's language mid-recording.
        if self.detected_language is None and self.language is None:
            self.detected_language = info.language

        if partial:
            if text != buf.last_partial_text:
                buf.last_partial_text = text
                emit({"type": "partial", "channel": buf.name, "text": text})
            return

        logprobs = [s.avg_logprob for s in segments if s.avg_logprob is not None]
        confidence = float(np.exp(np.mean(logprobs))) if logprobs else 0.0

        emit({
            "type": "segment",
            "channel": buf.name,
            "text": text,
            "start_ms": buf.offset_ms(start_sample),
            "end_ms": buf.offset_ms(start_sample + audio.size),
            "confidence": round(min(confidence, 1.0), 4),
            "language": self.language or self.detected_language or "unknown",
        })

    def flush(self) -> None:
        for buf in self.buffers.values():
            self.process(buf, final=True)
        emit({"type": "flushed"})

    def reset(self) -> None:
        self.buffers.clear()
        self.detected_language = None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu"])
    parser.add_argument("--language", default="auto")
    parser.add_argument("--partials", action="store_true")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

    try:
        engine = Engine(args.model, args.device, args.language, args.partials)
    except Exception as err:  # noqa: BLE001
        emit({"type": "error", "msg": f"engine failed to start: {err}", "fatal": True})
        return 1

    # stdin is read on its own thread so a slow transcription cannot stall the
    # pipe and back pressure into the app.
    inbox: queue.Queue[dict | None] = queue.Queue()

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                inbox.put(json.loads(line))
            except json.JSONDecodeError:
                log(f"ignoring unparseable input: {line[:120]}", "warn")
        inbox.put(None)  # stdin closed: the app is shutting us down

    threading.Thread(target=reader, daemon=True).start()

    while True:
        msg = inbox.get()
        if msg is None:
            return 0
        kind = msg.get("type")
        try:
            if kind == "audio":
                engine.add_audio(msg.get("channel", "system"), base64.b64decode(msg["pcm"]))
            elif kind == "flush":
                engine.flush()
            elif kind == "reset":
                engine.reset()
        except Exception as err:  # noqa: BLE001
            emit({"type": "error", "msg": f"error handling {kind}: {err}"})


if __name__ == "__main__":
    sys.exit(main())
