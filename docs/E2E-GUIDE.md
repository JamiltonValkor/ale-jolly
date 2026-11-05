# End-to-end guide: try Ale + Jolly in about 20 minutes (plus the first build)

This guide walks through the whole product on your own computer, in the same order as the demo video. It works for a person or for an AI coding agent: every step says what to do, what you should see, and how to check it from a terminal.

What is real and what is simulated is explained in [`SLIM-VERSION.md`](SLIM-VERSION.md). In short: the product code (`ale-runtime/`, the web app) and every Meta model call are real. The cloud VM, SaleADS and the robot hardware are local stand-ins, labeled «simulado» where they show up.

## Before you start

- Docker Desktop (or Docker Engine with Compose v2) running, and `openssl`.
- A **Meta API key**. It is the only credential needed.
- Optional, for Jolly live: Python 3.12 or `uv`, and a microphone, on macOS, Linux or Windows. A Cartesia key is optional too; without it Jolly speaks with your computer's own voice (`say` on macOS, the built-in Windows voice, espeak on Linux).
- Free ports: 3000 (or set `FRONT_PORT`), 8060, 8443, 8071 and 5055.
- **Windows:** run the commands in **Git Bash** (comes with Git for Windows) with Docker Desktop. Clone with `-c core.longpaths=true` as shown below. Jolly (`jolly-sim/`) runs in Git Bash too, with Python 3.12 from python.org (`py -3.12`) or `uv`. Stock's inventory does not need Jolly live: see step 8.

The web app is in Spanish, as for the real users. Button names below are quoted as they appear on screen.

## Part 1. Start everything

### 1. Bring up the stack

```bash
git clone -c core.longpaths=true <this repo> ale-jolly
cd ale-jolly/local
./demo.sh doctor
./demo.sh up
```

`up` asks for your Meta key once and stores it only in `local/.env`. The first run builds the images and takes several minutes.

**You should see:** `Listo: abre http://localhost:3000`.
**Check:** `docker compose -p ale-jolly ps` shows every service running (`migrate` and `cloud-sim-vm` exit with code 0 by design).

**Check your Meta key** against every model the product uses:

```bash
./demo.sh meta-check
```

One real call to each: Muse Spark (Ale and its team), Muse Spark with web search (the researcher), Muse Voice Transcribe (Jolly's ears), Muse Image (the shelf photos) and SAM 3.1 (the count). You should see five ✅, and SAM counting 22 jars in the example photo.

### 2. Open the web app

Open `http://localhost:3000`.

**You should see:** the Meta Assistant page of the demo business **«Masquebella (demo)»**, a hair-care shop that sells in COP. There is no login: you are its owner.

## Part 2. One click: deploy the assistant

### 3. Activate

Click **«Activar mi asistente»**.

**You should see:** a progress screen that ends in the assistant's home. In production this step creates a cloud VM with Hermes for this user; here `cloud-sim` creates a local container that behaves like that VM.

The first activation pulls Hermes inside the VM container: about 7 minutes. Later activations take seconds. If you see `managed_watcher_upgrade_required` in the logs meanwhile, wait: it retries on its own.

**Check:**

```bash
docker ps --filter name=vm-sa-assistant
./demo.sh logs ale-runtime | grep -E "ai.configured|orqa synced"
```

You should see a running `vm-sa-assistant-…` container, `ai.configured provider=meta-ai` (Ale runs on Muse Spark) and `orqa synced` (Ale's team of six agents is installed in the VM). The team setup restarts Hermes twice and can take 2–3 minutes; if it times out, it retries on its own every 30 s.

## Part 3. Ale, the marketing partner

The assistant's home has a bar with **Hoy · Conversar · Cerebro · Límites · Actividad · Stock**.

### 4. Hoy

**You should see:** Ale's greeting, the business metrics and «Dónde vive tu asistente», with the web and **«Compañero físico»** (the robot), still unpaired.

### 5. Conversar

Right after activation Ale writes its greeting. **Wait until it finishes** (the «pensando» indicator goes away) before writing: a message sent while it is thinking is not sent.

Open **Conversar** and write, for example:

- «¿Cómo va mi negocio?»
- «¿Qué productos vendo y cuál tiene más potencial?»

**You should see:** Ale answering with the business data. Ale reasons with **Muse Spark** and reads the business through SaleADS' MCP tools (served here by `saleads-sim`).

**Check** which tools Ale called:

```bash
curl -sk --resolve saleads.local:8443:127.0.0.1 https://saleads.local:8443/sim/calls
```

### 6. Cerebro, Límites and Actividad

- **Cerebro:** what Ale has learned about the business, stored in the business ontology (products, offers, research, the owner's notes, decisions, learnings). It starts with what Ale read from SaleADS at activation. After each conversation, the team's **curator** (also on Muse Spark) turns what was said and found into ontology entries; locally it runs every 5 minutes (every 3 hours in production), so chat in **Conversar** and reload **Cerebro** later. The first ideas show up **20–30 minutes after activation**, once the researcher's first study is done; an empty Cerebro before that is expected. Then ask Ale «¿Qué has aprendido de mi negocio?»: it answers from that memory.
- **Límites:** what Ale may do on its own and what needs the owner's approval, such as budget caps.
- **Actividad:** the changes you make to your assistant (limits, permissions, approvals). What the team is working on is in the team office (step 7).

### 7. The team office

On **Hoy**, open **«Abrir la oficina de tu equipo»**.

**You should see:** Ale's team of agents and what each one is working on.

### 8. Stock

Open **Stock**.

**You should see:** «Aún no hay productos». That is expected: the shop's inventory arrives with Jolly. As soon as you pair it (step 10), `jolly-sim` seeds Masquebella's inventory through the robot's device channel, with the same `bench_seed` the bench uses on the real robot: catalog, suppliers, costs, the initial count and eight weeks of simulated sales, all through Stock's real rules. Stock is the agent that watches inventory: it notices differences and stuck products and brings them to the owner for approval.

You come back to this tab in step 10. **Without Jolly live** (no microphone), fill it now from a second terminal at the repo root:

```bash
./jolly-sim/start.sh --sembrar
```

It prints a pairing code; on **Hoy**, go to **«Compañero físico»** → **«Sincronizar»** → «Escribir el código» and type it. The terminal prints `✓ Jolly vinculado` and then `✓ Stock listo`; reload **Stock** and continue with what step 10 describes after pairing.

## Part 4. Jolly, the robot

Jolly is Ale's body: a face, ears, a voice and an eye that counts products on a shelf. On the bench it is a 3D-printed robot with a Raspberry Pi 5 ([`../mini-muse/`](../mini-muse/)); here the same robot code runs on your computer.

### 9a. Live (microphone needed)

Open a second terminal at the repo root:

```bash
./jolly-sim/start.sh doctor
./jolly-sim/start.sh
```

**You should see:** a window with Jolly's face and a pairing code such as `K7QM-3XPA`.

On macOS, allow the terminal to use the microphone (System Settings → Privacy & Security) the first time.

### 10. Pair Jolly

In the web app, on **Hoy**, go to **«Compañero físico»** → **«Sincronizar»** → «Escribir el código» and type the code from Jolly's face.

**You should see:** Jolly says it is paired, and «Compañero físico» on **Hoy** shows «Sincronizado». The robot now has its own device credential and talks to Ale only through ale-runtime's robot channel, sending text.

A few seconds later the `jolly-sim` terminal prints `✓ Stock listo`. Open **Stock** again: the catalog shows Bio Mascarilla Capilar 500 g, Tónico Capilar 120 ml, Sérum Capilar 30 ml and Kit Emergencia y Reparación, with their expected stock (Shampoo and Aceite are in the SaleADS catalog but have no inventory). In **Conversar**, ask «¿Cómo está mi inventario?»: Ale answers with the Stock tools.

The seed runs once; `./jolly-sim/start.sh --sembrar` runs it by hand (for example if you paired Jolly before this version).

### 11. Talk to Jolly and count the shelf

Say, starting with its name:

- «Jolly, ¿cómo vamos hoy?»
- «Jolly, ¿cuántos frascos hay en la repisa?»

**You should see:**

1. Your voice is transcribed on the robot with **Muse Voice Transcribe**.
2. Ale (Muse Spark) decides whether to count.
3. The eye takes the shelf photo (by default an example shelf **generated with Muse Image**, labeled as such) and **SAM 3.1** counts it: 22 jars.
4. The numbered photo shows on Jolly's face for 15 s and Jolly says the count.
5. In the web's **Stock** tab, a card with the count and both photos waits for your approval. Approve it once both photos have loaded.

If Ale or Stock asks which product it is, answer «Bio Mascarilla 500 g»: that is what the example shelf shows. Keep Jolly's window open while Stock works: if Jolly is closed, Stock sees the robot as off («robot apagado») and the count waits; ask again once Jolly is back.

Locally, Stock's own vision check can't open the photo (the model runs at Meta and can't reach your computer). SAM's count and the card are not affected.

After each answer you have 20 seconds to keep talking without saying «Jolly».

To use your webcam instead: `./jolly-sim/start.sh --camara avfoundation:0` (macOS) or `--camara v4l2:/dev/video0` (Linux).

### 9b. No microphone: replay the real robot

```bash
./jolly-sim/start.sh --replay
```

**You should see:** Jolly's face under a red band «REPLAY · traza real del 2-nov-2026», playing 93 seconds recorded on the Raspberry Pi during the end-to-end run of 2 Nov 2026: SAM counts 22 jars, the numbered photo shows on the face, and Ale's notices are spoken. No backend or key needed.

## Part 5. Close

```bash
./jolly-sim/start.sh --desvincular   # optional: forget the pairing
cd local && ./demo.sh down           # stop everything, the assistant VM included, keeping the data
./demo.sh reset                      # or: delete everything, the assistant VM included, and start from zero
```

## Where each part comes from

| Step | Real | Simulated |
|---|---|---|
| Deploy (3) | ale-runtime's one-click flow, Hermes, the business brain | The VM is a local container (`cloud-sim`) |
| Ale (4–8) | ale-runtime, Hermes, Muse Spark, the Meta Assistant screens | SaleADS and its demo data (`saleads-sim`) |
| Jolly (9–11) | The robot's code, Muse Voice Transcribe, SAM 3.1, the robot channel | The robot body (a window on your computer); the shelf photos are generated with Muse Image |
| Replay (9b) | Recorded on the real robot on 2 Nov 2026 | Played back on your computer |

More evidence from the real robot and the real cloud deployment: [`../evidence/`](../evidence/).

## If something fails

| Symptom | What to do |
|---|---|
| `doctor` says a port is busy | `FRONT_PORT=3100 ./demo.sh up` and open that port |
| Activation stays in «configure_ai» | The Meta key is missing or wrong: fix `META_API_KEY` in `local/.env` and run `./demo.sh up` |
| Stock says «Aún no hay productos» after pairing | Run `./jolly-sim/start.sh --sembrar` and read its message |
| Stock tab or Stock answers missing | The team setup is still running: wait for `orqa synced` in `./demo.sh logs ale-runtime` |
| Jolly's eye: «subida original falló (HTTP 403)» | The eye was started by hand without `start.sh`: start Jolly with `./jolly-sim/start.sh`, which sends photo uploads to the local Storage |
| Jolly's processes stay open after Ctrl+C | macOS/Linux: `pkill -f jolly-sim`. Windows: close the Python windows, or `taskkill //F //IM python.exe` in Git Bash |
| Jolly never hears you | `./jolly-sim/start.sh doctor`; give the terminal microphone permission and restart it |
| Jolly: «ale-runtime no responde» | The stack is not up: `cd local && ./demo.sh up`, or use `--replay` |
| The pairing code expired | Jolly shows a new one after a few minutes; type the one on screen |
| Anything else | `./demo.sh reset && ./demo.sh up` starts from zero. More in [`../AGENTS.md`](../AGENTS.md) and [`../jolly-sim/README.md`](../jolly-sim/README.md) |
