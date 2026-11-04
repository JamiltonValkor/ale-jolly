# AGENTS.md — run Ale + Jolly locally (for AI coding agents)

You are helping a person run **Ale + Jolly** on their own computer. Follow these steps in order, verify each one, and only ask the person for what is listed in "Ask the person". Everything runs in Docker on this machine. No SaleADS account, no cloud account and no login are needed.

## What the person gets

- `http://localhost:3000`: the Meta Assistant web app, signed in as the demo owner of «Masquebella (demo)».
- One click on «Activar mi asistente» deploys the assistant. In production that creates a cloud VM; here it creates a local container that behaves like that VM (`cloud-sim`).
- Ale and its team run on Meta models: Muse Spark for reasoning (with web search for the researcher), Muse Voice Transcribe for speech to text, SAM 3.1 for counting products, Muse Image for the example shelf photos. `./demo.sh meta-check` makes one real call to each.
- Jolly, the robot, runs on this computer (`jolly-sim/`), using the camera and the microphone, or replays traces recorded from the real robot.

Anything simulated is labeled «simulated» or «recorded from the real robot» in the UI and in `README.md`.

## Ask the person

1. Their **Meta API key** (`META_API_KEY`). It is the only required credential. Never print it, never commit it, never paste it into an issue or a log.
2. Optional: a **Cartesia API key** for Jolly's voice. Without it, Jolly uses the operating system's voice.
3. Whether they also want **Jolly on this computer** (needs a microphone; a camera is optional).

## Steps

| # | Do | Verify |
|---|---|---|
| 0 | Clone with long paths enabled: `git clone -c core.longpaths=true <repo>`. On Windows, run every command in **Git Bash** | The clone has no `Filename too long` errors |
| 1 | Check that Docker Desktop (or Docker Engine with Compose v2) is installed and running | `docker info` and `docker compose version` succeed |
| 2 | `cd local && ./demo.sh doctor` | Every line shows ✓, except «falta META_API_KEY» on a fresh clone: `up` asks for the key. Fix any other ✗ as the message says. On Windows (Git Bash) the port check can't see busy ports. If port 3000 is busy, use `FRONT_PORT=3100` (or any free port) in the next steps |
| 3 | `./demo.sh up`. It creates local TLS certificates (`local/certs/`, never committed) and `local/.env`, asks for the Meta key once, publishes the brain image and starts everything. The first run builds images and takes several minutes | `docker compose -p ale-jolly ps` shows every service `running`/`healthy` (`cloud-sim-vm` exits 0 by design) |
| 4 | Open `http://localhost:3000` (or `FRONT_PORT`) | The Meta Assistant page loads, signed in as the demo owner |
| 5 | Click «Activar mi asistente» | Progress ends on the assistant's home, marked «Activo». The first time it takes about 7 minutes (Hermes is pulled inside the VM container). `./demo.sh logs ale-runtime` shows `ai.configured provider=meta-ai`; a container `vm-sa-assistant-…` is running |
| 6 | In **Conversar**, send a message | Ale answers (Muse Spark) |
| 7 | Optional, Jolly: `../jolly-sim/start.sh` (needs Python 3.12 or `uv`; Windows: Git Bash and `py -3.12`) | Jolly's face opens and shows a pairing code. In the web app, «Compañero físico» → «Sincronizar» → enter the code. Jolly then listens, counts products with SAM and talks |
| 8 | Optional, no hardware: `../jolly-sim/start.sh --replay` | Jolly replays a recorded trace, labeled as such |

After step 6, walk the person through the full product with [`docs/E2E-GUIDE.md`](docs/E2E-GUIDE.md): it has what to do, what to see and how to check each step.

## If something fails

| Symptom | Cause | Fix |
|---|---|---|
| `doctor`: port busy | Another app uses the port | `FRONT_PORT=<free port> ./demo.sh up` |
| `ale-runtime` restarts with `CONFIGURATION_INVALID: …` | Missing value in `local/.env` | `./demo.sh reset`, then `./demo.sh up` |
| Activation stays in «configure_ai» | Meta key missing or invalid | Fix `META_API_KEY` in `local/.env`, then `./demo.sh up` |
| First sync takes a few minutes | The first apply creates six agent profiles and restarts Hermes twice | Wait; it retries on its own every 30 s |
| Slow on Apple Silicon | Old image built for amd64 | `./demo.sh reset && ./demo.sh up` (it builds natively) |
| Jolly: no microphone or camera | OS permissions | Allow the terminal to use them in system settings (Windows: Settings → Privacy → Microphone → allow desktop apps) |

## Rules for the agent

- Do not change product code to make the demo run. Local mode is configuration plus the simulators in `cloud-sim/` and `saleads-sim/`.
- Never commit `local/.env`, `local/certs/` or any key.
- Do not call non-Meta AI models. The only allowed non-Meta service is text-to-speech for Jolly's voice: Cartesia, or the computer's own voice.
- When done, tell the person what is real (the product code, the Meta model calls) and what is simulated (cloud VM → local container, SaleADS → `saleads-sim`, robot hardware → `jolly-sim`).

## Map

| Folder | What it is |
|---|---|
| `ale-runtime/` | The productive solution: the slim version builds Ale's service, brain, skills and VM script from it |
| `local/` | `docker-compose.yml`, `Caddyfile` (local TLS), `demo.sh`, `.env.example` |
| `cloud-sim/` | Local stand-in for the cloud: Compute, metadata, Storage and Artifact Registry APIs; each assistant VM is a local container |
| `saleads-sim/` | Local stand-in for SaleADS: sign-in, MCP tools, landings, demo business data |
| `front/` | The Meta Assistant web app |
| `jolly-sim/` | Jolly on a laptop, plus replay of real-robot traces |
| `evidence/` | Recorded traces and photos from the real robot |
| `mini-muse/` | Jolly's 3D-printable body |
| `docs/` | `SLIM-VERSION.md` and `E2E-GUIDE.md` for judges; the rest are internal implementation notes in Spanish, not needed to run the demo |
