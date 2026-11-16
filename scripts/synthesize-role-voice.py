"""Generate a local PCM WAV using a Qwen3-TTS Base model and a role reference."""

import argparse
import base64
from contextlib import redirect_stdout
import json
from queue import Queue
import sys
from threading import Event, Thread
from pathlib import Path
import wave

import mlx.core as mx
import numpy as np
from mlx_audio.tts.utils import load_model


ROLES = {"xiaxia", "lubai", "guyu", "beila"}


def generate_pcm(model, text, reference, *, stream=False):
    transcript_file = reference.with_suffix(".txt")
    transcript = transcript_file.read_text(encoding="utf-8").strip() if transcript_file.is_file() else None
    mx.random.seed(42)
    for part in model.generate(
        text, lang_code="chinese", ref_audio=str(reference), ref_text=transcript or None,
        max_tokens=min(2048, 32 * len(text) + 96), stream=stream, streaming_interval=0.32,
    ):
        samples = np.asarray(part.audio, dtype=np.float32).reshape(-1)
        if samples.size:
            yield (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def worker(model_path, references):
    protocol = sys.stdout
    requests = Queue()
    cancelled = {}
    stdin_closed = Event()

    def send(**message):
        print(json.dumps(message, ensure_ascii=False), file=protocol, flush=True)

    def receive():
        try:
            for line in sys.stdin:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if isinstance(message.get("cancel"), int):
                    event = cancelled.get(message["cancel"])
                    if event:
                        event.set()
                elif isinstance(message.get("id"), int):
                    event = Event()
                    cancelled[message["id"]] = event
                    requests.put((message, event))
        finally:
            stdin_closed.set()
            requests.put(None)

    Thread(target=receive, daemon=True).start()
    with redirect_stdout(sys.stderr):
        model = load_model(str(model_path))
        send(type="ready", sampleRate=model.sample_rate)
        while not stdin_closed.is_set():
            item = requests.get()
            if item is None:
                return
            message, cancel = item
            job = message["id"]
            try:
                text, profile = message.get("text"), message.get("profileId")
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500 or profile not in ROLES:
                    raise ValueError("Invalid text or profile")
                if not cancel.is_set() and not stdin_closed.is_set():
                    stream = generate_pcm(model, text.strip(), references / f"{profile}.wav", stream=True)
                    try:
                        for pcm in stream:
                            if cancel.is_set() or stdin_closed.is_set():
                                break
                            send(id=job, type="audio", pcm=base64.b64encode(pcm).decode("ascii"))
                    finally:
                        stream.close()
                send(id=job, type="end")
            except Exception as error:
                print(error, file=sys.stderr, flush=True)
                send(id=job, type="error")
            finally:
                cancelled.pop(job, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--references", type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--text-file", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.worker:
        if args.references is None:
            parser.error("--worker requires --references")
        worker(args.model, args.references)
        return
    if not all((args.reference, args.text_file, args.output)):
        parser.error("--reference, --text-file and --output are required")
    text = args.text_file.read_text(encoding="utf-8").strip()
    if not 1 <= len(text) <= 500:
        parser.error("text must contain 1–500 characters")
    model = load_model(str(args.model))
    with wave.open(str(args.output), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(model.sample_rate)
        for pcm in generate_pcm(model, text, args.reference):
            output.writeframes(pcm)


if __name__ == "__main__":
    main()
