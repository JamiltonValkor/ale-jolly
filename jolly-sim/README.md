# jolly-sim: Jolly on your computer

Jolly is Ale's body: a small robot with a face, ears, a voice and an eye that counts what is on a shelf. On the hackathon bench it runs on a Raspberry Pi 5. Here the same code runs on your Mac or Linux laptop:

- **Face**: a window instead of the robot's screen.
- **Ears**: your microphone, transcribed by **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`).
- **Eye**: example shelf photos (or your webcam), counted by **SAM 3.1** (`sam-3.1`), called from the robot.
- **Voice**: Cartesia `sonic-3` if you have a key; otherwise `say` on macOS, or espeak on Linux.
- **Brain**: Ale in the backend, on **Muse Spark**. Jolly only sends text, through the robot channel of ale-runtime.

There are no arms here. Everything else is the robot's code, copied unchanged into `robot/`.

## Quick start

You need macOS or Linux, and `uv` or Python 3.12. `start.sh` creates the Python environment and installs the pinned requirements the first time (a minute or two). On Windows, the replay (`./start.sh --replay`) runs from Git Bash with Python 3.12 from python.org (`py -3.12`) or `uv`; without espeak it plays silently, with the face and the subtitles.

**Without a backend or key: watch a replay of the real robot.**

```bash
./jolly-sim/start.sh --replay
```

A window opens with Jolly's face under a red band, **«REPLAY · traza real del 2-nov-2026»**. It plays 93 seconds recorded on the Raspberry Pi during the official end-to-end run: Jolly is asked to count a shelf, SAM counts 22 jars and the numbered photo shows on the face; then Ale's notices («Diferencia de 2, esperábamos 24…») are spoken by your computer's voice. It loops until Ctrl+C.

**Live, with the local backend running** (`./local/demo.sh up`, see the repo README):

```bash
export META_API_KEY=...            # your key from dev.meta.ai; or put it in local/.env
./jolly-sim/start.sh
```

1. The window shows a pairing code such as `K7QM-3XPA`.
2. Open http://localhost:3000, go to **Vincular mi compañero** (pair my companion) and type the code.
3. In a few seconds Jolly says it is paired. The credential stays in `robot/voz-hermes/.env`, so the next start skips this step.
   Against the local backend, `sembrar.py` then seeds Masquebella's Stock inventory once through the robot's channel (`bench_seed`) and prints `✓ Stock listo`.
4. Talk to it starting with its name: **«Jolly, …»**, in Spanish or English. After each answer you have 20 seconds to keep going without the name.

To see the eye work, ask about stock, for example «Jolly, ¿cuántos frascos hay en la repisa?». Ale decides whether to count; when it does, Jolly takes the photo, SAM counts it, the numbered photo shows on the face for 15 s, and both photos are uploaded (to the simulated Storage of `cloud-sim`). The count then appears as a card in the web's Stock tab, waiting for your approval.

## Check your computer first

```bash
./jolly-sim/start.sh doctor
```

It checks, in this order: Python 3.12 and packages, the bus ports, the output voice, PortAudio and the microphone (it records half a second), ffmpeg and the camera (it takes one picture), the key (a handshake with Muse Voice Transcribe, no audio sent) and ale-runtime. It never prints your key. A shorter version, without network or recording, runs on every start.

| What | macOS | Linux (Debian/Ubuntu) |
|---|---|---|
| Python 3.12 | `uv` downloads it ([install uv](https://docs.astral.sh/uv/)) or `brew install python@3.12` | `uv`, or `sudo apt install python3.12-venv` |
| PortAudio | included in the `sounddevice` wheel | `sudo apt install libportaudio2` |
| ffmpeg (webcam only) | `brew install ffmpeg` | `sudo apt install ffmpeg` |
| Voice without Cartesia | `say`, built in | `sudo apt install espeak-ng` (or `speech-dispatcher` for `spd-say`) |
| Permissions | Allow the terminal to use the **microphone** (and the **camera** for a webcam) in System Settings → Privacy & Security | Your user must be able to open the audio and video devices |

## Options

| Command | What it does |
|---|---|
| `./start.sh` | Live: face, voice and eye against `ALE_RUNTIME_URL` (default `http://localhost:8060`) |
| `./start.sh --replay` | Replay of a real trace, no backend, key or microphone. `JOLLY_TRAZA=/path/trace.jsonl` plays another one |
| `./start.sh doctor` | The checks above |
| `./start.sh --camara avfoundation:0` | Your Mac's webcam (`ffmpeg -f avfoundation -list_devices true -i ""` lists them) |
| `./start.sh --camara v4l2:/dev/video0` | A webcam on Linux |
| `./start.sh --camara carpeta:/path/manifiesto.json` | Your own photos, with a manifest like `fotos-ejemplo/manifiesto.json` |
| `./start.sh --desvincular` | Forgets the pairing: the face shows a new code |
| `./start.sh --sembrar` | Seeds the demo Stock inventory against the local backend; if Jolly is not paired, pairs it in the terminal first (no face, microphone or voice, so it works on Windows) |
| `./start.sh --grabar` | Also records the bus to `jolly-sim/grabaciones/` |

Keys and settings are read from the environment, then from `local/.env` or `.env` at the repo root:

| Variable | Use |
|---|---|
| `META_API_KEY` | Required live. Muse Voice Transcribe and SAM 3.1 |
| `CARTESIA_API_KEY` | Optional. Cartesia voice; without it, the local voice |
| `ALE_RUNTIME_URL` | Backend URL, default `http://localhost:8060` |
| `ALE_ROBOT_NAME` | Name shown when pairing, default `Jolly` |
| `ALE_CAMARA` | Same as `--camara` |

`start.sh` writes `robot/voz-hermes/.env` (mode 600, ignored by git) with only these values and the pairing credential.

## Example photos

By default the eye reads `fotos-ejemplo/`: three shelves **generated with Muse Image** (`muse-image-1.0`), not camera photos. The robot marks them `fuente: simulada`, and the web shows them as «Simulado». Each has its sha256 and the count by eye in `manifiesto.json`. The first one (22 jars, `S2-a.jpg`) is used unless `ALE_ESCENA=S5-a` (16 jars) or `ALE_ESCENA=P-07` (7 bottles) picks another.

## The replay

`replay/traza-2026-11-02-p2.jsonl` is cut from the 119 MB bus recording of the official run on 2 Nov 2026 (step P2), with `replay/recortar.py`:

- It keeps what the face listens to (`cuerpo/*`, `voz/*`, `ojo/*`) and Ale's events, and cuts quiet stretches.
- It drops the face's own output (`cara/*`) and the hearing events (`oido/*`), which carry room speech.
- What people said in the room is replaced by `[habla de la sala redactada]`, and the stretches where Jolly answered it are left out. Turn, context and request ids are renamed, and the Pi path of the numbered screen points to `replay/pantalla-foto-1.png`.

`replay/reproducir.py` publishes it on the same bus ports as the robot (5560, and 5562 for `ojo/*`) with the times moved to now, and reads each `voz/frase` aloud at the moment it sounded on the robot. The robot never recorded audio: the replay has the text and the volume curve that moves the mouth, not the original voice. `replay/cara_replay.py` is the unchanged face with the red band drawn on top.

More recordings and how they were made: [`../evidence/`](../evidence/).

## What changed from the robot's code

`robot/` is a copy of the robot folder of the Ale runtime (voice, face, eye and the eye's restart loop), with the SAM fixtures its tests use. One change, additive and in the plan's closed list: `LocutorEspeak` in `robot/voz-hermes/voz_salida.py`, the Linux fallback voice with espeak-ng, espeak or spd-say, which `voz_hermes.py` picks on Linux when there is no Cartesia key. On macOS nothing changes.

Packaging differs from the Pi: one Python environment for the three processes instead of one each, a window instead of full screen, no arms and no touch panel.

## Tests

```bash
cd jolly-sim && .venv/bin/python -m pytest -q pruebas
(cd robot/ojo && ../../.venv/bin/python -m pytest -q pruebas_ojo.py)
(cd robot/voz-hermes && ../../.venv/bin/python -m pytest -q pruebas_canal_robot.py cuerpo)
(cd robot/cara && ../../.venv/bin/python -m pytest -q pruebas_*.py)
```

Two face tests (`test_catalogo_cumple_la_regla_de_optimismo`, `test_catalogo_tiene_las_variantes_acordadas`) also fail in the original robot code; they are not caused by the copy.

## Troubleshooting

- **«Ya hay otro robot corriendo» or busy ports**: another Jolly or replay is open. Close it (Ctrl+C) and start again.
- **Jolly never hears you**: run `./start.sh doctor`. If it says the microphone returns pure silence, give your terminal microphone permission and restart it.
- **«ale-runtime no responde»**: start the backend (`./local/demo.sh up`) or use `--replay`.
- **The code never gets paired**: the code expires after a few minutes and the face shows a new one; type the one on screen.
- **No voice on Linux**: install `espeak-ng`, or set `CARTESIA_API_KEY`.
