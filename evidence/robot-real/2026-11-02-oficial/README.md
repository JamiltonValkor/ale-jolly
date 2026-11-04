# Official end-to-end run, 2 Nov 2026 (recorded from the real robot)

Jolly ran on the Raspberry Pi 5 against the real cloud deployment (ale-runtime and the assistant VM on dev), from 18:27 to 22:37 Bogotá time (23:27Z on 2 Nov to 03:37Z on 3 Nov). The business is the demo shop «Masquebella»: hair and skin care with four products.

## How it was run

- **The owner's turns** were injected as text through the robot channel by the bench operator, and marked as injected. Nobody spoke to the Pi. Jolly was awake: notices, photo orders, SAM, the numbered screen and the photo upload are real.
- **Shelf photos** came from the `carpeta:` camera source: scenes **generated with Muse Image**, fed to the robot as camera reads. Everything after the capture is real: `ojo`, SAM 3.1, numbering, the face screen, upload to Storage and the card on the web.
- **Approvals** were made by the human owner on the web. No agent clicked them.
- **Documents** (invoices) came from a simulated bench channel.

## Steps and verdicts

| Step | Verdict | What happened |
|---|---|---|
| P1 Order arrives with invoice | **Pass** | Invoice first; the stock entry was pending 41 s later. Stock stayed at 0 until the owner confirmed +24 on the web |
| P2 Count 22 against 24 | **Pass** | SAM counted 22 (`p2-pantalla-conte-22.png`). Stock asked which product and the cause. The owner chose «sale» and confirmed −2 on the web (`p2-web-por-aprobar-conteo.jpg`) |
| P3 Unprompted notice | **Fail** | Stock saw the slowdown, but Ale closed silently and Jolly did not speak |
| P4 Ad bet from Hermes | **Pass with faults** | The bet was approved on the web; the researcher did not take part and the bet lacked a weekly forecast |
| P5 Follow-up | **Partial fail** | The count passes: SAM counted 16, as expected (`p5-pantalla-conte-16.png`). Reading an ads screenshot and crossing the three signals failed |
| P6 Restock | **With detour** | Two guided owner turns were needed; then the order was approved on the web |
| P7 Supplier negotiation (Telegram) | **Pass** | Agreed at 19,000 per unit, under the 20,000 cap |
| P8 Receiving | **Partial fail** | SAM counted 33 (`p8-pantalla-conte-33.png`, `p8-web-por-aprobar-recepcion.jpg`); the invoice entry was not linked to the order, so no saving was recorded |
| P9 Level-3 permission | **Fail** | A consequence of P8 |

**Not an official green.** Three fails, two partial fails and guided detours, recorded as they happened.

**No write without confirmation:** the cross-check query returned 0 rows at every step. Every stock change came from a web confirmation by the owner.

**Cost of the run:** between US$ 0.8 and 4.3 (model on the VM, Stock workers, 3 SAM calls).

## Files

| File | What it is |
|---|---|
| `p2-pantalla-conte-22.png`, `p5-pantalla-conte-16.png`, `p8-pantalla-conte-33.png` | The screen `ojo` drew on the robot's face: SAM's count, numbered. The photo underneath is a Muse Image scene |
| `p2-web-por-aprobar-conteo.jpg`, `p5-…`, `p8-web-por-aprobar-recepcion.jpg` | The web card the owner approved, before the click |
| [`jolly-sim/replay/traza-2026-11-02-p2.jsonl`](../../../jolly-sim/replay/traza-2026-11-02-p2.jsonl) | 93 s of the robot's bus during P2, redacted. `./jolly-sim/start.sh --replay` plays it |

Left out on purpose: the full bus and face logs (464 MB, with room speech), run and session ids, the owner's user id, the Telegram ids and the internal deployment digests.
