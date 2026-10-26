"""HTTP and fixed-voice contracts; no ML imports or GPU required."""
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
from contextlib import redirect_stderr
from unittest.mock import patch
import tempfile
import threading
import unittest
import wave


MODULE_PATH = Path(__file__).with_name("local-indextts-server.py")
sys.dont_write_bytecode = True
server_module = None
if MODULE_PATH.exists():
    spec = importlib.util.spec_from_file_location("local_indextts_server", MODULE_PATH)
    server_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server_module)


def wav_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(22050)
        audio.writeframes(b"\x00\x00" * 128)
    return buffer.getvalue()


class FixedVoiceContracts(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(server_module, "The fixed IndexTTS HTTP service is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reference = self.root / "speaker.wav"
        self.reference.write_bytes(wav_bytes())
        self.inputs_path = self.root / "comparison-inputs.json"
        self.parameters_path = self.root / "indextts-parameters.json"
        self.inputs_path.write_text(json.dumps({"referenceAudio": str(self.reference), "seed": 42}), encoding="utf-8")
        self.parameters = {
            "seed": 42,
            "constructor": {"device": "cuda:0", "use_bf16": True, "use_qwen_emo": False},
            "inference": {"lang": "ZH", "duration_factor": 1.0, "use_random": False, "temperature": 0.8},
        }
        self.parameters_path.write_text(json.dumps(self.parameters), encoding="utf-8")
        self.events = []
        self.calls = []
        self.failure = None
        self.inference_return = True

    def load_voice(self, factory=None):
        owner = self

        class FakeModel:
            def infer(self, **kwargs):
                owner.events.append("infer")
                owner.calls.append(kwargs)
                if owner.failure:
                    raise owner.failure
                Path(kwargs["output_path"]).write_bytes(wav_bytes())
                return kwargs["output_path"] if owner.inference_return else None

        def create_model(**kwargs):
            self.events.append(("load", kwargs))
            return FakeModel()

        return server_module.load_voice(
            project=self.root / "source", checkpoints=self.root / "checkpoints",
            inputs_path=self.inputs_path, parameters_path=self.parameters_path,
            temporary_root=self.root, model_factory=factory or create_model,
            reset_seed=lambda seed: self.events.append(("seed", seed)),
        )

    def start_http(self, voice):
        server = server_module.create_server(voice, ("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close():
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(close)
        return server.server_address

    def request(self, address, method, route, payload=None):
        connection = http.client.HTTPConnection(*address, timeout=3)
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            connection.request(method, route, body=body, headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, response.getheader("Content-Type"), response.read()
        finally:
            connection.close()

    def test_cli_requires_explicit_deployment_and_voice_configuration_paths(self):
        stderr = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH)]), patch.object(
            server_module, "load_voice", side_effect=AssertionError("voice loading must not start without paths")
        ) as load, redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as result:
                server_module.main()
        self.assertEqual(result.exception.code, 2)
        load.assert_not_called()
        for option in ("--deployment-root", "--inputs-file", "--parameters-file"):
            self.assertIn(option, stderr.getvalue())

    def test_fixed_parameters_reference_and_seed_reused_without_changing_text(self):
        voice = self.load_voice()
        text = "  今天可以好好休息了。\n"
        self.assertEqual(voice.synthesize(text), wav_bytes())
        self.assertEqual(voice.synthesize(text), wav_bytes())
        self.assertEqual(self.events[0], ("seed", 42))
        self.assertEqual(self.events[1][1], {
            "cfg_path": str(self.root / "checkpoints" / "config.yaml"),
            "model_dir": str(self.root / "checkpoints"), **self.parameters["constructor"],
        })
        self.assertEqual(self.events[2:], [("seed", 42), "infer", ("seed", 42), "infer"])
        for call in self.calls:
            self.assertEqual(call["text"], text)
            self.assertEqual(call["spk_audio_prompt"], str(self.reference))
            self.assertEqual({key: call[key] for key in self.parameters["inference"]}, self.parameters["inference"])

    def test_http_returns_wav_and_ready_fingerprint_after_load(self):
        address = self.start_http(self.load_voice())
        status, content_type, body = self.request(address, "POST", "/tts", {"text": "你好。"})
        self.assertEqual((status, content_type, body), (200, "audio/wav", wav_bytes()))
        status, _, body = self.request(address, "GET", "/health")
        health = json.loads(body)
        self.assertEqual(status, 200)
        self.assertIs(health["ready"], True)
        self.assertEqual(health["model"], "IndexTTS-2.5")
        self.assertEqual(health["parameters"], self.parameters)
        self.assertEqual(health["referenceSha256"], hashlib.sha256(self.reference.read_bytes()).hexdigest())
        self.assertEqual(health["parametersSha256"], hashlib.sha256(self.parameters_path.read_bytes()).hexdigest())

    def test_http_rejects_parameter_override_before_inference(self):
        address = self.start_http(self.load_voice())
        status, _, _ = self.request(address, "POST", "/tts", {"text": "你好", "seed": 7})
        self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_synthesis_error_is_http_500_without_success_audio(self):
        self.failure = RuntimeError("fixture model failed")
        address = self.start_http(self.load_voice())
        status, content_type, body = self.request(address, "POST", "/tts", {"text": "你好"})
        self.assertEqual(status, 500)
        self.assertEqual(content_type, "application/json; charset=utf-8")
        self.assertIn("fixture model failed", json.loads(body)["error"])
        self.assertEqual(len(self.calls), 1)

    def test_model_load_failure_propagates_without_ready_voice(self):
        def fail_load(**kwargs):
            raise RuntimeError("fixture loading failed")

        with self.assertRaisesRegex(RuntimeError, "fixture loading failed"):
            self.load_voice(factory=fail_load)

    def test_model_none_result_is_http_500_even_if_a_file_was_written(self):
        self.inference_return = False
        address = self.start_http(self.load_voice())
        status, _, _ = self.request(address, "POST", "/tts", {"text": "你好"})
        self.assertEqual(status, 500)


if __name__ == "__main__":
    unittest.main()
