# Ale + Jolly

An AI marketing team with a body, built on Meta models. **Ale** is a marketing partner for small businesses: it reads the business, researches the market, proposes and measures campaigns, and learns with every conversation, with a team of agents behind it. **Jolly** is Ale's body: a small robot with a face, ears, a voice and an eye that counts products on a shelf.

**Want to try it right away?** Go to [Run it](#run-it). You only need Docker and a Meta API key.

## Why this repo is a slim version

The full, productive solution is **[`ale-runtime/`](ale-runtime/)**. It runs on our own environments: SaleADS (`dev.saleads.ai`), a one-click deploy that creates a cloud VM with Hermes for each user, and Jolly, the physical robot on a Raspberry Pi 5. The demo video was recorded there.

![Ale + Jolly running in our dev environment](docs/img/production-dev-saleads.webp)

A judge can't reproduce that stack: it needs SaleADS accounts, a cloud project and the physical robot. We asked the organizers. Their answer: a reduced version that runs locally, with every simulated part clearly labeled, meets the requirement, and recorded traces from the real robot are accepted as evidence.

![Organizers' answer: local setup and simulated robot](docs/img/organizers-answer-local-setup.jpg)
![Organizers' answer: what the submitted repo must contain](docs/img/organizers-answer-repo.jpg)
![Organizers' answer: Meta models at runtime, TTS exception](docs/img/organizers-answer-tts.jpg)

So this repo runs the real `ale-runtime` source, the real web app and real Meta model calls on your computer. Only what a judge can't have is replaced by local stand-ins: the cloud (`cloud-sim/`), SaleADS (`saleads-sim/`) and the robot's body (`jolly-sim/`). What is real, what is simulated and what we changed for it: [`docs/SLIM-VERSION.md`](docs/SLIM-VERSION.md).

## Meta models

Every model call at runtime is to Meta, with your own key:

| Model | What it does |
|---|---|
| **Muse Spark** (`muse-spark-1.3-contributor`) | Ale and its team of agents, including the memory curator that fills the business brain |
| **Muse Spark with web search** | The researcher agent's market research, with sources |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Jolly's ears, in real time |
| **SAM 3.1** (`sam-3.1`) | Jolly's eye: counts the products on the shelf |
| **Muse Image** (`muse-image-1.0`) | The example shelf photos Jolly's eye uses when there is no camera |

Jolly's voice is the one exception allowed by the organizers: Cartesia if you add a key, otherwise your computer's own voice.

## Run it

Step by step, with what you should see at each step. Every step also works for an AI coding agent: open this repo and ask it to follow [`AGENTS.md`](AGENTS.md). The full tour of the product is in [`docs/E2E-GUIDE.md`](docs/E2E-GUIDE.md).

### Before you start

- **Docker Desktop** (or Docker Engine with Compose v2), running.
- A **Meta API key** from [dev.meta.ai](https://dev.meta.ai). It is the only credential needed.
- **Windows:** run every command in **Git Bash** (it comes with Git for Windows), never in PowerShell or CMD.
- Free ports: 3000, 8060, 8443, 8071 and 5055. If 3000 is taken, put `FRONT_PORT=3100` before `./demo.sh up` and open that port instead.
- Only for Jolly, the robot: Python 3.12 or [`uv`](https://docs.astral.sh/uv/) (Windows: Python 3.12 from python.org, `py -3.12`), and a microphone.

### 1. Clone and start (about 10 minutes the first time)

```bash
git clone -c core.longpaths=true https://github.com/JamiltonValkor/ale-jolly.git
cd ale-jolly/local
./demo.sh up
```

`up` asks for your Meta key once, saves it only in `local/.env` and builds everything.
**You should see:** `Listo: abre http://localhost:3000`.

Optional, to check your key against the five Meta models: `./demo.sh meta-check`. **You should see:** five ✅ and SAM counting 22 jars.

### 2. Activate the assistant (about 7 minutes the first time)

Open `http://localhost:3000` and click «Activar mi asistente». The first time, the local "VM" downloads Hermes. Keep the page open.
**You should see:** the assistant's home, marked «Activo».

### 3. Talk to Ale

Open **Conversar**. Ale writes a greeting first: **wait until it finishes** (the «pensando» indicator goes away), then write, for example «¿Cómo va mi negocio?», and press send.
**You should see:** Ale answering with the demo shop's products and numbers.

### 4. Start Jolly and pair it (optional, needs a microphone)

Open a **second terminal** at the repo root and leave it open the whole time:

```bash
./jolly-sim/start.sh
```

A window with Jolly's face shows a code such as `K7QM-3XPA`. In the web, on **Hoy**: «Compañero físico» → «Sincronizar» → «Escribir el código», and type it.
**You should see:** `✓ Jolly vinculado` and `✓ Stock listo` in the terminal; the **Stock** tab now has products.

No microphone? `./jolly-sim/start.sh --replay` plays a recording of the real robot, with no backend or key.

### 5. Count the shelf

Say: «Jolly, ¿cuántos frascos hay en la repisa?». If you're asked which product, say «Bio Mascarilla 500 g».
**You should see:** Jolly answers out loud. A minute or two later, in **Stock** → «Por aprobar», a count card with the shelf photo and SAM's 22 jars waits for your approval.

### 6. See what Ale learned (20–30 minutes after activation)

Open **Cerebro** once the team's first research is done, and ask Ale in **Conversar** «¿Qué has aprendido de mi negocio?».

### Stop or start over

```bash
./demo.sh down     # stop everything, keeping the data
./demo.sh reset    # delete everything and start from zero
```

### If something goes wrong

| What you see | What to do |
|---|---|
| `doctor` shows ✗ «falta META_API_KEY» on a fresh clone | Expected: `./demo.sh up` asks for it |
| A port is busy | `FRONT_PORT=3100 ./demo.sh up`, then open `http://localhost:3100` |
| Activation stays on «Encendiendo su inteligencia» or the logs show `managed_watcher_upgrade_required` | The first VM is still downloading. Wait; it retries on its own |
| Your chat message doesn't go out | Ale is still writing: wait for «pensando» to go away |
| The count card stays blocked or never shows up | In **Conversar** write «reintenta el conteo con una foto nueva» (Jolly's terminal must be open) |
| Stock says «robot apagado» | Jolly's terminal was closed. Start `./jolly-sim/start.sh` again and ask again |
| Cerebro is empty | Normal for the first 20–30 minutes |
| Anything else | `./demo.sh logs ale-runtime`, then `./demo.sh reset && ./demo.sh up`. More in [`docs/E2E-GUIDE.md`](docs/E2E-GUIDE.md) |

## Reading order

1. This README: what it is and why it is a slim version.
2. [`docs/SLIM-VERSION.md`](docs/SLIM-VERSION.md): real vs simulated, the robot and its pairing.
3. [`docs/E2E-GUIDE.md`](docs/E2E-GUIDE.md): try the whole product step by step.
4. [`ale-runtime/README.md`](ale-runtime/README.md): the productive solution and how it deploys.

## Layout

| Folder | What lives there |
|---|---|
| `ale-runtime/` | **The productive solution**: Ale's control service, the business brain, the agents' skills, the VM's startup script and the robot's code |
| `front/` | The Meta Assistant web app (Hoy, Conversar, Cerebro, Límites, Actividad, Stock, team office, robot pairing) |
| `local/` | `docker-compose.yml`, `.env.example` and `demo.sh` (`doctor`, `up`, `meta-check`, `down`, `reset`, `logs`) |
| `cloud-sim/` | Local stand-in for the cloud: the Compute API the one-click deploy calls, so each assistant gets a local Hermes container instead of a cloud VM |
| `saleads-sim/` | Local stand-in for SaleADS: its MCP tools and sign-in, with demo data, no SaleADS account needed |
| `jolly-sim/` | Jolly on your computer (face, voice, eye), plus replays of traces from the real robot |
| `mini-muse/` | Jolly's 3D-printable body, to print and assemble it |
| `evidence/` | Recorded traces, photos and logs from the real robot and the real cloud deployment |

## Known limitations of the local version

- A count that Stock blocked because Jolly was closed doesn't resume by itself when Jolly comes back: ask Jolly again.
- Locally, Stock's vision check can't open the shelf photo (the model runs at Meta and can't reach your computer); SAM's count and the card are not affected.
- The first ideas in **Cerebro** show up 20–30 minutes after activation, once the researcher's first study is done.
- Stock's expected and counted numbers for the demo shop don't always add up, because the seeded history and the shelf photo are separate simulations. Approving a count still works.
- Publishing a landing and the full goal → campaign cycle depend on SaleADS services that `saleads-sim` only imitates in part.
