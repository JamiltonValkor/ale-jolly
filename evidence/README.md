# Evidence

Recordings from the real robot (Jolly on a Raspberry Pi 5, and its software on a Mac) and from the real cloud deployment, made during the hackathon. Everything here is labeled with how it was produced:

- **Recorded from the real robot**: what the robot's processes really published or drew.
- **Generated with Muse Image**: pictures made by `muse-image-1.0`. **They are not camera photos.** The robot reads them through its `carpeta:` camera source, and the rest of the pipeline (SAM 3.1, numbering, the face screen, the upload) runs for real on them.
- **Injected**: text or synthetic voice fed in to drive a test; marked where it applies.

There are no real camera photos in this set: every shelf the robot counted is a Muse Image scene.

## Contents

| Path | What it is | Day and run | Label |
|---|---|---|---|
| [`robot-real/2026-11-02-oficial/`](robot-real/2026-11-02-oficial/) | Official end-to-end run of Stock with Jolly: steps, verdicts (including the failures), the counts SAM drew on the face and the web cards the owner approved | 2 Nov 2026, 18:27–22:37 Bogotá, Raspberry Pi 5 against the cloud on dev | Recorded from the real robot. Owner turns injected as text; shelf scenes generated with Muse Image |
| [`../jolly-sim/replay/traza-2026-11-02-p2.jsonl`](../jolly-sim/replay/traza-2026-11-02-p2.jsonl) | 93 s of the robot's bus from that run (step P2: count 22, notice, cause). Plays on your computer with `./jolly-sim/start.sh --replay` | 2 Nov 2026, official run, P2 | Recorded from the real robot, cut and redacted |
| [`ojo-mac-2026-11-01/`](ojo-mac-2026-11-01/) | First full pass of `ojo` on a Mac: Muse Image scene → SAM 3.1 → numbered photo and face screen, with the bus recording (`bus-e2e.jsonl`) | 1 Nov 2026, Mac, fake backend (`ale_falso`), real Muse and SAM | `cruda-16-generada-muse.jpg` generated with Muse Image; the rest are real outputs |
| [`voz-avisos-2026-11-01/`](voz-avisos-2026-11-01/) | A notice from Stock colliding with an owner's question: the notice waits for the turn to end and the answer is heard without the wake word (`colision-real-bus.jsonl`) | 1 Nov 2026, Mac, real Muse Voice Transcribe and Cartesia, fake backend | Owner voice injected with macOS `say`, not a person |
| [`imagenes-generadas-muse/`](imagenes-generadas-muse/) | 30 shelf scenes and the accuracy of SAM 3.1 on them, run 3 times each (`exactitud.md`, `manifiesto.json` with the count by eye written before calling SAM) | 2 Nov 2026, Mac | Generated with Muse Image |
| [`barrido-secretos.sh`](barrido-secretos.sh) | The secret and personal-data sweep run before every commit | | |

### `ojo-mac-2026-11-01/`

- `cruda-16-generada-muse.jpg`: the scene, generated with Muse Image. Counted by eye: 16 (two rows of 8). SAM with `jar`: 16.
- `numerada-16.jpg`, `pantalla-16.png`: real outputs of `ojo`, the photo sent to the web and the face screen.
- `bus-e2e.jsonl`: the bus during that pass. The temporary path in `ruta_pantalla` was replaced by the file name.

### `voz-avisos-2026-11-01/`

`colision-real-bus.jsonl`, without sound and without the volume and partial transcripts. What to look for: the owner asks «cuántas ventas llevo hoy?»; the notice «¿Te llegaron 22 o 24?» comes 1.6 s after Jolly finishes answering, never inside the turn; then «Llegaron veintidós» is accepted without saying «Jolly». Times are monotonic seconds.

## What was removed or never published

Following decision D8 of the plan:

- Credentials and backups of the Pi (an `.env` with real keys and the `.tgz` backups) are not here. D8 also calls for rotating those keys (Meta, Cartesia and the device credential).
- Room speech: what people in the room said near the robot is redacted in the traces (`[habla de la sala redactada]`), and the replay leaves out stretches where Jolly answered it.
- Emails, internal IPs, Telegram ids and fingerprints, paths on the Pi, run, session and request ids, and the owner's name and user id.
- Internal operations notes (cloud deployment requests, Pi installation, security matrices): they describe private infrastructure.
- One generated scene (`S1-recibo`): Muse drew a real brand in the background.
- The full bus and face logs (about 460 MB per run), which also carry room speech.

## Secret sweep

```bash
evidence/barrido-secretos.sh
```

It checks `jolly-sim/` and `evidence/` for device tokens (`ale_dev_`), `sk-`, Google, GitHub and Slack keys, JWTs, private keys, emails, internal IPs, paths under the Pi home folder, UUIDs in data files other than the demo's public ids, and any `.env`, `.tgz` or credential file. It never prints what it found, only the file and the rule. With `JOLLY_ENV_REALES=file1:file2` it also looks for the literal values of those `.env` files.
