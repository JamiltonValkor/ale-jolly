# Existing SaleADS motion engine

English adaptation of existing SaleADS `skills/v2/motor-movimiento.md`.
SaleADS' trusted publisher supplies Motion/Lenis behavior; the coder uses its
existing declarative attributes and CSS. **Do not write JavaScript, import a
library/CDN or claim that a preview screenshot proves the engine executed.**
Base curve: `--sa-ease: cubic-bezier(.22,1,.36,1)`.

Without JavaScript or with `prefers-reduced-motion`, all meaningful content
remains complete and visible. Never introduce a hidden default state waiting
for an unprovided script. Verify the actual published runtime separately from
the static preview when that test is available.

The existing method asks for a deliberate motion focal point with two/four
supporting details rather than identical reveal-on-scroll everywhere. Choose
according to the concept and available supported engine, not all effects on
every page. Keep the argument/CTA immediately legible and honor reduced-motion.

## Focal effects

| Existing attribute | Behavior described by the current engine | Appropriate use |
| --- | --- | --- |
| `data-sa-split` (default `words`, optional `chars`) plus `data-sa-split-effect="mask\|blur\|rise"` | Staged text entrance by words/characters | Hero headline, a short sourced statement or a real figure, not long paragraphs |
| `data-sa-pin`, `data-sa-step`, `data-sa-pin-stage`, `data-sa-step-media` | Desktop image stage stays fixed as real steps advance; mobile stacks normally | Actual how-it-works process or a contextual sequence, usually three/five real steps |
| `data-sa-horizontal` plus `data-sa-track` | Desktop horizontal progression; mobile CSS scrolling/snap | Genuine gallery/benefit sequence with enough meaningful existing material |
| `data-sa-reveal-image` on image wrapper | Curtain-like image reveal with subtle scale | An existing large product/context photo below the hero |
| `data-sa-scrub="y:-120;scale:1.08"` (also x, rotate, opacity, blur) | Scroll-linked transform/effect | A restrained photo/large decorative type movement that does not obscure reading |

These are literal existing attribute names, not new schema aliases. Add the
required semantic markup and layout CSS; an attribute alone does not prove the
composition works. Use only behavior actually supported by the deployed engine.

## Supporting effects

| Existing attribute | Behavior | Use |
| --- | --- | --- |
| `data-sa-counter` | Animate toward the genuine number already in text | Only a documented figure; not a fabricated customer count or deadline |
| `data-sa-magnetic="0.2…0.4"` | Small mouse-responsive attraction | Primary action where it supports the concept; no mobile dependency |
| `data-sa-tilt="6…12"` | Hover tilt; glare variables `--sa-glare-x/y` | Product/offer component with useful depth |
| `data-sa-aura` | Pointer-following light via `--sa-aura-color` | An appropriate dark hero or offer background |
| `data-sa-smooth` on html | Lenis smooth scrolling | Optional editorial/premium treatment; not mandatory |
| `data-sa-load="rise\|mask\|scale\|fade"` | CSS first-load entrance; order through `--sa-i` or `data-sa-stagger` | Small supporting hero details; never delay reading of headline/CTA |
| `data-sa-reveal="rise\|mask\|scale\|fade"` plus `data-sa-stagger` | Viewport entrance/stagger | A few cards/list details; this is not the entire art direction |
| `data-sa-mark` | Paint a highlight behind selected important words | Two/four meaningful phrases, not entire paragraphs |
| `data-sa-parallax="0.05…0.4"` | Subtle depth layer movement | A brand shape/light/photo treatment with a clear purpose |

Own CSS `@keyframes`/transitions may support a genuine concept: a restrained
marquee, CTA shine, gradient atmosphere or decorative border. Avoid constant
competing motion, expensive whole-page blur or a hidden hero. Include a complete
reduced-motion/static fallback. No JS implementation belongs in the authored files.

## Recipes using the existing contract

Visible English copy here is illustrative; use actual business-locale copy,
authorized photo URLs and stable `data-edit` IDs in the real artifact.

### Split headline and a magnetic configured CTA

```html
<section class="hero" data-sa-aura>
  <h1 data-sa-split data-edit="hero-headline">
    The approved promise with <mark data-sa-mark>its relevant emphasis</mark>
  </h1>
  <p data-sa-load="fade" style="--sa-i:4" data-edit="hero-support">Supported explanation.</p>
  <a href="#" data-cta="whatsapp" data-sa-magnetic="0.3" data-edit="hero-action">Ask about this service</a>
</section>
```

Use `data-cta="agenda"` instead only when that is the actual configured closing.
The hash href is the required draft marker; SaleADS supplies its real published URL.

### Fixed process: steps and existing photos

```html
<section class="process" data-sa-pin>
  <div class="steps">
    <article data-sa-step><h2 data-edit="step-one">First real step</h2></article>
    <article data-sa-step><h2 data-edit="step-two">Second real step</h2></article>
    <article data-sa-step><h2 data-edit="step-three">Third real step</h2></article>
  </div>
  <div class="stage" data-sa-pin-stage>
    <!-- Use actual authorized URLs, useful alt and real dimensions for every existing photo. -->
  </div>
</section>
```

Attach `data-sa-step-media` to actual corresponding images when the photo map
supports the sequence. Desktop can use two grid columns, meaningful step
height and a positioned stage with a controlled aspect ratio. Existing images
use cover/contained treatment intentionally. Mobile shows each real image with
its step, or a complete static alternative; no invented photo is required.

### Horizontal gallery

```html
<section data-sa-horizontal>
  <div class="window">
    <div class="track" data-sa-track><!-- Actual meaningful gallery items. --></div>
  </div>
</section>
```

The track can use `display:flex; gap:24px; overflow-x:auto;
scroll-snap-type:x mandatory`, with items around `flex:0 0 min(80vw,440px)` when
appropriate. These are starting values, not a substitute for checking 390px,
1440px and intermediate layouts. Do not ship placeholder comments/content as
if a complete gallery had been created.

Static captures alone cannot establish smoothness, event handlers or the
absence of an overlapping fixed bar. Report the actual check and its limits.
