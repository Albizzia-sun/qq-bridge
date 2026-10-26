"""Local fixed-voice IndexTTS-2.5 adapter; POST /tts accepts only text."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import traceback
import wave


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class FixedVoice:
    def __init__(self, model, reference, parameters, reset_seed, temporary_root, health):
        self.model = model
        self.reference = reference
        self.parameters = parameters
        self.reset_seed = reset_seed
        self.temporary_root = temporary_root
        self.health = health

    def synthesize(self, text):
        # HTTPServer handles one request at a time, including the RNG reset.
        self.reset_seed(self.parameters["seed"])
        with tempfile.TemporaryDirectory(prefix="indextts-request-", dir=self.temporary_root) as directory:
            output = Path(directory) / "speech.wav"
            result = self.model.infer(
                spk_audio_prompt=self.reference, text=text, output_path=str(output),
                **self.parameters["inference"],
            )
            # Upstream catches some IndexError cases and returns None.
            if result is None:
                raise RuntimeError("IndexTTS returned no completed audio")
            data = output.read_bytes()
            with wave.open(io.BytesIO(data), "rb") as audio:
                if audio.getnframes() <= 0 or audio.getframerate() <= 0:
                    raise RuntimeError("IndexTTS produced empty audio")
            return data


def load_voice(*, project, checkpoints, inputs_path, parameters_path, temporary_root,
               model_factory=None, reset_seed=None):
    inputs_path, parameters_path = Path(inputs_path), Path(parameters_path)
    inputs = json.loads(inputs_path.read_text(encoding="utf-8-sig"))
    parameters = json.loads(parameters_path.read_text(encoding="utf-8-sig"))
    if inputs["seed"] != parameters["seed"]:
        raise ValueError("Input and inference seeds differ")
    reference = str(inputs["referenceAudio"])
    health = {
        "ready": True, "model": "IndexTTS-2.5", "parameters": parameters,
        "inputsSha256": digest(inputs_path),
        "parametersSha256": digest(parameters_path),
        "referenceSha256": digest(reference),
    }
    if model_factory is None:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        project = Path(project).resolve()
        os.chdir(project)
        sys.path.insert(0, str(project))
        import numpy as np
        import torch
        from indextts.infer_v2_5 import IndexTTS2

        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("The fixed IndexTTS configuration requires CUDA with BF16 support")
        torch.backends.cudnn.benchmark = False
        model_factory = IndexTTS2

        def reset_seed(seed):
            # Same three calls as the accepted comparison; torch.manual_seed
            # seeds CPU and CUDA generators.
            random.seed(seed)
            np.random.seed(seed)
            torch.manual_seed(seed)

    if reset_seed is None:
        raise ValueError("A seed reset function is required with a custom model factory")
    reset_seed(parameters["seed"])
    model = model_factory(
        cfg_path=str(Path(checkpoints) / "config.yaml"),
        model_dir=str(checkpoints), **parameters["constructor"],
    )
    Path(temporary_root).mkdir(parents=True, exist_ok=True)
    return FixedVoice(model, reference, parameters, reset_seed, temporary_root, health)


def create_server(voice, address=("127.0.0.1", 9880)):
    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, data, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def json_response(self, status, payload):
            self.respond(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                         "application/json; charset=utf-8")

        def do_GET(self):
            if self.path != "/health":
                self.json_response(404, {"error": "Unknown route"})
                return
            self.json_response(200, voice.health)

        def do_POST(self):
            if self.path != "/tts":
                self.json_response(404, {"error": "Unknown route"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("A JSON body containing text is required")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or set(payload) != {"text"}:
                    raise ValueError("Only the text request field is accepted")
                if not isinstance(payload["text"], str) or not payload["text"].strip():
                    raise ValueError("text must be a non-empty string")
            except (ValueError, UnicodeError) as error:
                self.json_response(400, {"error": str(error)})
                return
            try:
                data = voice.synthesize(payload["text"])
            except Exception as error:
                traceback.print_exc()
                self.json_response(500, {"error": type(error).__name__ + ": " + str(error)})
                return
            self.respond(200, data, "audio/wav")

    return HTTPServer(address, Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment-root", type=Path, required=True)
    parser.add_argument("--inputs-file", type=Path, required=True)
    parser.add_argument("--parameters-file", type=Path, required=True)
    args = parser.parse_args()
    print("Loading fixed IndexTTS-2.5 voice", flush=True)
    voice = load_voice(
        project=args.deployment_root / "source",
        checkpoints=args.deployment_root / "checkpoints",
        inputs_path=args.inputs_file,
        parameters_path=args.parameters_file,
        temporary_root=args.deployment_root / "cache" / "temp",
    )
    with create_server(voice) as server:
        print("IndexTTS-2.5 ready at http://127.0.0.1:9880", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
