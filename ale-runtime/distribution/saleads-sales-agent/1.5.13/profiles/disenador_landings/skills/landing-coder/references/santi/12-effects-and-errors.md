# Effects, buttons, responsive behavior and common errors

English adaptation of **Santiago Tapias**, existing SaleADS reference
`skills/v2/santi/12-efectos-y-errores.md`. Preserve the source's craft principles:
purposeful light/depth, occasional glass, responsive buttons, restrained motion,
solid behavior across screens and visible content when an effect fails.

**Every effect has a job:** guide attention to the action, separate layers or
signal that a control is interactive. Unmotivated effects add noise; many
simultaneous effects can make an otherwise individual page look generic.

The original `assets/base-tecnica.html` and helper scripts are not assumed to
exist here. Use the existing SaleADS platform contract, CSS and documented
`data-sa-*` motion attributes. **Do not author JavaScript, import a CDN, add
React or run an invented review script.** The existing trusted publisher owns
runtime/embeds. Read [SaleADS motion](../saleads-motion.md) for actual attributes.

## 1. Light

Light draws attention toward the real person/product, price or action, using a
brand-appropriate accent rather than making everything glow.

| Effect | Purpose | Source technique, adapted to CSS |
| --- | --- | --- |
| Back halo | Separate a subject from its background | Radial gradient behind it, accent around 30–45% |
| Rim light | Suggest directional illumination around a genuine cutout | Shape-following drop-shadow rather than a rectangular shadow |
| CTA glow | Emphasize the primary action | Broad diffuse shadow in the action color |
| Text glow | Emphasize one meaningful word on a dark surface | Restrained text shadow on that word only |
| Neon edge | Differentiate a selected/highlighted component | Thin colored outline plus soft glow |
| Stage light | Support an appropriate event/launch concept | Very faint conic gradient, about 0.15 opacity or less |
| Vignette | Give the center breathing room on a dark scene | Transparent center fading to a subtle dark edge |

```css
.light-field { position: relative; isolation: isolate; }
.light-field::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: -15% -10%;
  pointer-events: none;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--accent) 40%, transparent),
    transparent 72%
  );
}
```

- Prefer radial gradients to blurring enormous decorative elements; both can
  create atmosphere, but a huge blur can burden a mobile GPU.
- On light surfaces, subtle tinted shadows and tonal contrast often communicate
  better than nearly invisible glow.
- Usually one or two light sources per screen; if everything glows, no focal
  point remains. Adapt to the brand rather than imposing a dark/glass theme.

## 2. Blur and glass

Glass can separate readable content from a photograph without completely
covering it: a genuine name label, a card above a photo or a mobile action bar.
It is an option with a purpose, not a mandatory material for every business.

```css
.glass-panel {
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass-panel {
    background: color-mix(in srgb, var(--surface) 45%, transparent);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    backdrop-filter: blur(14px) saturate(140%);
  }
}
```

- Preserve a legible fallback background and Safari's `-webkit-` variant.
- Measure text contrast over the lightest relevant part of the photograph,
  not only against an imaginary uniform panel.
- Small blur on distant decorative elements and sharp foreground elements can
  establish depth. Use only permitted existing photos/assets or CSS decoration.
- A low-opacity/blurred real portrait can create a background treatment, but
  the important content and the subject's identity must remain honest.
- Avoid glass on glass and glass on every card; unexplained repetition looks
  like a template rather than an art-directed choice.

## 3. Buttons

A button should look actionable, respond to interaction and make the next step
clear. In this pilot an action is normally the configured anchor marker that
SaleADS resolves on publication.

- States: normal; mouse hover with a slight lift and shadow; pressed with
  a small return/scale; visible keyboard focus; disabled only for an actual
  unavailable/submitting action. The coder does not invent an asynchronous form.
- Mobile height at least **48px**; label on one line. If it does not fit, shorten
  the copy rather than shrinking it to unreadable text.
- A small arrow/icon can shift roughly 3px on hover when it helps signify progress.
- A traveling highlight can emphasize the main action; do not apply repeated
  autonomous glitter to every control.
- Mobile has no hover: meaningful information/action must remain available,
  and a tapped control should not remain visually stuck in a raised state.
- WhatsApp green is optional when it fits the palette; otherwise use the
  primary action color with an approved recognizable icon.

```css
.action {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .55em;
  min-height: 52px;
  padding: 0 1.6em;
  border: 0;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--on-accent, #fff);
  font: 700 16px/1 var(--sa-font-body, system-ui);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 12px 26px -12px color-mix(in srgb, var(--accent) 75%, transparent);
  transition: transform .18s ease, box-shadow .18s ease;
}
.action:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 34px -12px color-mix(in srgb, var(--accent) 85%, transparent);
}
.action:active { transform: translateY(0) scale(.98); }
.action:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
.action .arrow { transition: transform .18s ease; }
.action:hover .arrow { transform: translateX(3px); }
.action--shine::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(110deg, transparent 35%, rgb(255 255 255 / .35) 50%, transparent 65%);
  transform: translateX(-120%);
}
.action--shine:hover::after { transform: translateX(120%); transition: transform .7s ease; }
@media (hover: none) { .action:hover { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .action, .action .arrow, .action--shine::after { transition: none; transform: none; }
}
```

These are recipes, not a requirement to copy all effects together. Keep the
actual CTA markup, `data-edit` IDs and validator constraints from platform.md.

## 4. Entrances and exits

The source uses restrained entrances when blocks enter the viewport, with a
short stagger in a hero, and optional exits as a block leaves. The important
failure mode is **content hidden forever because a script did not run**.

Preserve these rules:

- The default, no-JavaScript document shows all meaningful content. Any hidden
  preparation state belongs only to a trusted running animation engine.
- Once revealed, a block stays visible; scrolling back must not hide it again.
- Exits must not make content permanently invisible. The source suggests a
  restrained opacity floor around 0.4 while a block exits; unsupported engines
  should simply show the static page.
- Favor transform/opacity, roughly 200–700ms where appropriate, with one coherent
  easing. Avoid `transition: all`, animated widths/heights/margins and long hero delays.
- Honor `prefers-reduced-motion`; meaningful content never depends on motion.
- Use a focal hero detail and selected elements, not an entrance on every paragraph.

**SaleADS adaptation:** the original IntersectionObserver/class-toggle JavaScript
is intentionally not copied as executable guidance. The platform already owns
that lifecycle. Use the documented `data-sa-load`, `data-sa-reveal`, `data-sa-split`
and other permitted attributes, with CSS that is readable before enhancement.
Do not add `html.anima`, a new observer, another library or a hidden default state
that assumes a script outside the published contract will rescue it.

First-paint clarity from the existing construction instructions remains active:
hero title, real offer and action should be immediately readable; keep any hero
CSS entrance brief and avoid postponing comprehension for choreography.

A CSS-only exit is optional if supported by the actual validator/browser and
if a static fallback is complete. For example:

```css
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .subtle-exit {
      animation: subtle-exit linear;
      animation-timeline: view();
      animation-range: exit 0% exit 100%;
    }
    @keyframes subtle-exit { to { opacity: .4; transform: scale(.97); } }
  }
}
```

Screenshots of a final state do not prove animation. If a capture contains an
empty block, investigate it as a defect, not a decorative choice. If the actual
browser motion could not be tested, record that limitation.

## 5. Responsive behavior

Start at **390px**, and inspect **360, 390, 768, 1024 and 1440px** where real
browser/capture tools permit. Current default SaleADS captures cover 390/1440;
other widths remain a target to verify, not a claim about an installed script.

- Fluid headlines: a scale such as `clamp(34px, 7vw, 64px)` with balanced wrapping
  is a useful starting point; keep mobile body text about 16–18px and check the brand.
- Flexible grids: `repeat(auto-fit, minmax(min(100%, 280px), 1fr))` prevents a card
  minimum from forcing horizontal scroll.
- Use `min-width: 0` on grid/flex children with long text or imagery.
- Layered compositions need a proportionally controlled wrapper. Container units
  such as `cqw`/`cqh` can help when the actual browsers support them; do not invent
  additional assets to make the composition work.
- Inspect intermediate widths: a layout good at 390 and 1440 can collide at 1024.
  Correct the exact media range rather than raising a breakpoint blindly.
- Use existing authorized image variants with `srcset`/`sizes` only when their
  URLs actually exist. Always declare dimensions/aspect ratio; no invented derivatives.
- Use `min-height: 100dvh` when a full-screen section is justified; mobile browser
  chrome makes plain `100vh` unreliable.
- Fixed bottom bars need safe-area padding and enough body/section space. They
  must not cover the final CTA or footer.
- The original form-font guidance (16px+ to avoid mobile zoom) belongs to any
  separately provided form, not permission to create one in this pilot.

## 6. Common defects and targeted repairs

| Defect | Typical cause | Repair |
| --- | --- | --- |
| Horizontal overflow | Fixed widths, `100vw`, off-canvas decoration, negative margins, long strings, minimum-width cards | Use local `overflow-x: clip` for intentional decoration, flexible widths/minimums, text wrapping and max-width for media; repair the actual offender |
| Invisible content | Waiting for a nonexistent/failed script | Default-visible document and only trusted progressive enhancement |
| Layout jumps | Images without dimensions, unstable font loading | Set dimensions/aspect ratio and use the existing font preparation with appropriate swap behavior |
| Action goes nowhere | Placeholder URL or missing target | Preserve intentional `data-cta` draft markers; validate actual injected published destination; fix ordinary dead links |
| Text lacks photo contrast | Background brightness varies | Purposeful gradient/panel and measure contrast against the lightest relevant area |
| Fixed bar covers content | No reserved bottom space | Add space matching bar/safe area and avoid obscuring final action/footer |
| Hover-only information | Essential state depends on mouse | Make it visible/actionable on touch without hover |
| Accidental layer collisions | Unbounded z-index values | A few named layers and component isolation |
| Zoom disabled | maximum-scale/user-scalable restriction | Never block zoom |
| Awkward broken labels | Long CTA or badge text | Shorten wording and use appropriate nowrap; do not shrink essential text |

The source's review scripts can identify an overflow selector or invisible
content when installed. In this pilot use equivalent actual evidence and do
not report a script run that did not occur.

## 7. Verify links and controls

The source reviews links after trusted runtime enhancement, with tracking
blocked for testing, and checks reachability without opening an external
checkout or triggering its pixel. Retain the intent using available tooling:

- No ordinary empty URL, meaningless `#` or missing section anchor.
- Exception: required SaleADS `href="#" data-cta` markers remain until publication.
- Published WhatsApp numbers use a real country code/digits and a readable
  configured message; sample numbers must not become business contact data.
- Supported `tel:`/`mailto:` links are well-formed.
- External destinations respond successfully under actual authorized checks;
  follow redirects safely and do not confuse a reachable URL with the correct offer.
- No unprovided form or endpoint is created just to satisfy this checklist.
- Product, price, group/agenda destination and CTA wording agree semantically.

Do not submit data, send a WhatsApp message, buy a product or generate conversion
noise merely to prove a button exists. A manual/authorized platform check is
distinct from a visual screenshot or text-level URL inspection.

## 8. Before handoff

- [ ] Light, glass and decoration each have a purpose.
- [ ] Primary action is immediately recognizable and has all appropriate states.
- [ ] Failed scripts/reduced-motion do not hide meaningful content.
- [ ] No horizontal overflow at the widths actually inspected; report others.
- [ ] No action label wraps awkwardly or sits underneath a fixed bar.
- [ ] Real link/destination checks have no unresolved error, or the gap is declared.
