# Ale + Jolly

An AI marketing team with a body, built on Meta models. Work in progress for the Meta Hackathon 2026: this README is completed at the end.

## Run it

Easiest: open this repo with your AI coding agent (Claude Code, Codex, Cursor…) and ask it to follow [`AGENTS.md`](AGENTS.md). By hand: `cd local && ./demo.sh up`, then open `http://localhost:3000`. You only need Docker and a Meta API key.

## Layout

| Folder | What lives there |
|---|---|
| `local/` | `docker-compose.yml`, `.env.example` and `demo.sh` (doctor, up, down) |
| `cloud-sim/` | Local stand-in for the cloud: the Compute API that the one-click deploy calls, so each assistant gets a local Hermes container instead of a cloud VM |
| `saleads-sim/` | Local stand-in for SaleADS: its MCP tools and sign-in, with demo data, no SaleADS account needed |
| `front/` | The Meta Assistant web app (Hoy, Conversar, Cerebro, Límites, Actividad, Stock, team office, robot pairing) |
| `jolly-sim/` | Jolly, the robot, running on the evaluator's computer, plus replay of traces from the real robot |
| `evidence/` | Recorded traces, photos and logs from the real robot and the real cloud deployment |
