# Thirteen axes: a direction that survives implementation

Adapted from the archive's `SKILL.md`, `references/ejes.md` and `references/conceptos.md`. The original has 13 axes when concept is included. These are design choices, not a new strategy model. Read the selected options in detail; do not add every effect.

Use a compact worksheet: **axis → choice → reason → desktop/mobile implementation → evidence or constraint**. Prefer meaningful differences in concept, hero and grid over a palette swap. Brand consistency and a requested revision can justify repeated choices. Novelty never outranks a usable, factual page.

## 1. Narrative concept

Choose one supported route from `narrative-and-copy.md`: a small first action; coordinated craft; documented process; control/choice; transparent cost; a customer's actual journey; relevant contrast; a day/use occasion; a meaningful number; product-to-resulting-artifact; reassurance; or learn-by-observing. The route must fit this offer and its canonical bet. It is not permission to invent a testimonial, result, timeline or staff member.

## 2. Hero composition

The first mobile screen should establish what this is, whom it serves and the next action without waiting for motion.

| Option | Construction and mobile adaptation | Common failure |
| --- | --- | --- |
| Action-led | Make the configured primary action prominent beside a specific headline and real asset. On mobile use one reading column. | Copying the source's text composer, AI selector or registration flow when those do not exist. |
| Evidence-led split | Headline on one side, a real photo/process artifact on the other. Stack with the claim before its evidence on mobile. | An invented chat, fake dashboard or illegible decoration posing as proof. |
| Typographic statement | A short, distinctive headline supplies the composition; a real product view enters below. Aim for two or three desktop lines and deliberate mobile breaks. | Six lines caused by a narrow container, or tiny body/CTA beneath huge type. |
| Product stage | Use an actual product/photo as the visual center; arrange copy around it with a clear reading path. Stack on mobile and preserve label visibility. | Replacing a customer's product with the source's glowing orb, fabricated 3D packaging or cropped-out product identity. |
| Relevant contrast | Show two substantiated choices, stages or constraints with a clean split. Use vertical order on mobile. | Unsupported physical before/after claims, denigrating another brand, or making a comparison sound causal. |
| Asset collage | Compose two to four relevant existing images/details around a clear text area; simplify to one or two on mobile. | Overlaps covering the headline or repeated photos pretending to be distinct products. |
| Asymmetric editorial | Align headline, side note and product to a real column grid; one deliberate overlap may connect them. Linearize on mobile. | Random offsets that lose alignment or a note carrying an essential condition in unreadable type. |
| Process rows | Use an actual, supported sequence with concise captions. Keep a short static list on mobile. | Fabricated timestamps, fake live activity or an unpausable ticker. |
| Question and answer | A genuine visitor objection frames a factual answer. Present it typographically, without implying a recorded customer conversation. | Turning every section into chat or inventing a named customer. |
| Minimal | One strong line, an identifiable product/brand cue and one action; the next chapter supplies depth. | Empty atmosphere that never explains the offer. |

## 3. Surface theme

Choose brand-appropriate light, dark, a purposeful light-to-dark/dark-to-light transition, or a few clean chapter bands. Use the customer's palette, not the source's mandatory black/paper pair. Check each surface separately; a theme change must not hide terms, flatten photos or make a secondary chapter look like another business.

## 4. Light and visual accent

Choose no special light, a restrained brand accent, a single edge highlight, a subtle background aura, one text emphasis, or tactile texture when the existing platform can support it. A single focal treatment is stronger than glow everywhere. Keep colored effects away from long copy and the photo's factual appearance. The SaleADS iridescent mark is source-brand-specific and is not a customer design default.

## 5. Grid

- **Reading spine:** a comfortable central text column, with selected product/evidence moments allowed to widen.
- **Editorial grid:** titles, supporting notes and assets align to explicit columns; notes never interrupt the reading order.
- **Varied tiles:** each tile communicates one real idea; fit the cells without holes. Avoid a uniform icon/title/paragraph grid as the entire story.
- **Split sequence:** a stable left title and right evidence blocks; disable sticky positioning on narrow screens.
- **Chapters:** one substantial idea per section, with varied density inside. Do not force empty full-screen sections or mandatory scroll snapping.
- **Horizontal evidence strip:** use only when it makes a real set easier to inspect. Keep the rest vertical, provide a visible cue and a usable mobile path; never hijack required reading.

## 6. Typographic voice

Choose fonts from the actual approved catalog. A tight expressive sans, light display with one emphasized phrase, restrained mono for genuinely technical identifiers, a limited serif accent, or weight contrast can each give character. Do not force DM Sans/JetBrains Mono from the source onto another brand. Use at most two purposeful weights in a single headline; check diacritics and optical size at the actual output widths. Mono is not a substitute for human-readable product copy.

## 7. Scale

Choose a typographic statement, a large balanced headline or a contained heading that lets the product carry the composition. Use responsive `clamp()` values consistent with the chosen font and longest locale text. The source's display ranges are inspiration, not mandatory minima. Preserve readable body text, price, conditions and action on mobile; no section heading competes accidentally with the one h1. Balance line breaks in actual captures rather than trusting character counts.

## 8. Product/evidence presentation

Use an honest product portrait, real detail sequence, an approved process diagram, existing artifact gallery, supported specification/price treatment or genuine sourced evidence. Show how the offer works before the visitor has to infer it from claims. Do not substitute SaleADS chat cards, an agent constellation, a fake phone conversation, fabricated metrics or stock photos. If an explanatory illustration is useful, make its illustrative nature explicit and do not invent factual results inside it.

## 9. Motion

Choose static, a quiet one-time reveal, a short stagger, a supported progress line, a bounded pinned sequence, or restrained decorative breathing if relevant to this brand. The source distinguishes ambient from functional motion; here both must use the **existing** supported declarative engine. A static truthful layout is preferable to an unsupported widget. See `platform-and-motion.md` for fallback and reduced-motion behavior.

## 10. Action pattern

Use one clear primary action: a direct link, a primary/secondary pair, the actual supported choice of WhatsApp/agenda, or a restrained persistent action when the publisher supports it. Label with verb and object in the owner locale. Put real price, conditions and material costs close to the decision. Hero layout controls the opening; this axis controls repetition and close. Never add a free-text form, provider selector, fake calculator or `/registro` path because the source contains one.

## 11. Signature moment

Choose **one** memorable piece that makes the canonical idea concrete: an artful real-product composition; an ingredient/detail sequence supported by the catalog; a clear usage/process strip; a transparent offer breakdown; a well-designed actual choice; or a relevant typographic/evidence transition. It must be readable without animation and usable with keyboard if interactive. Do not fabricate an autonomy simulator, live audit, undo control, conversion funnel or claims checker. A missing photo is a constraint to solve with composition, not image generation.

## 12. Density and rhythm

Choose airy, editorial alternation or compact comparison according to the visitor's task. Alternate substantial visual moments with useful detail; do not make every chapter the same height or card pattern. The source suggests roughly 120–200px between airy chapters and 72–120px for compact ones at desktop scale; adapt the spacing scale to the actual content and mobile viewport. Compact never means tiny text, and airy never means a long empty scroll.

## 13. Message emphasis

Select an emphasis already supported by the bet: informed choice, time/use convenience, transparent cost, understandable evidence, appropriate support, or simplicity. It should connect the headline, proof and close. This is a presentation emphasis, not a new audience, strategic hypothesis or product guarantee. If no supporting evidence exists, do not choose a numeric/performance-led direction merely to look persuasive.

## Compatibility and variation

Reject a direction that needs assets, facts or capabilities the task lacks. Examples: no calculator without a verified formula and supported controls; no sticky sequence whose content disappears in preview; no dense tile grid with an airy one-object-per-screen promise; no giant headline that pushes the action beyond a long mobile scroll.

For a **new concept**, compare candidate vectors and the actual same-business previous designs Ale supplied. Record the material differences and why they serve this bet. For a **feedback revision**, start from the frozen vector, not from another draw. Record changed axes only. A different color alone is not a new visual idea, and a repeated brand treatment is not a failure when it preserves a coherent family.
