---
name: landing-coder
description: Design, code and revise a SaleADS landing from Ale's existing communication bet, preserving evidence and using authorized existing photos.
---

# Landing coding workflow — adapted from the existing SaleADS designer

This skill ports the existing sa-landing-service phase workflow and Santiago Tapias references.
It is a pilot adaptation, not a new marketing methodology.
The delegated evidence/brief and references/platform.md take precedence over third-party framework,
font, motion-library and tool recipes. Translate the craft to permitted SaleADS HTML/CSS. See source-map.json and THIRD_PARTY_NOTICES.md.

1. Read task bindings, approved context, canonical bet/brief and current version when revising.
2. Read references/structure.md and references/santi/02-page-types.md plus
   references/santi/03-copywriting.md. Produce page.json with final blocks/copy and missing facts.
3. Read references/art-direction.md, references/frontend-design.md and, when appropriate,
   references/liquid-glass/SKILL.md plus its referenced files under references/liquid-glass/references/.
   Read references/catalogo-archetypes.md and references/visual-marketing.md.
   Produce design.json with one justified art direction, typography, composition and existing-photo map.
4. Read references/build.md, references/platform.md, references/saleads-motion.md and
   references/santi/12-effects-and-errors.md. Write full index.html/styles.css in the task workspace.
5. Obtain SaleADS validation and actual preview/captures through Ale's CLI operations.
   Read references/review.md, references/santi/08-review.md and
   references/santi/10-professional-design-section-8.md, inspect evidence and correct concrete issues without rebuilding good parts.
6. Return files and evidence to Ale for version admission. No publishing or separate backend generator.

For revision, read current files and design.json, identify the owner's specific correction, preserve
approved copy/design elsewhere and use expected_latest_n. An edit to the strategic promise goes back to Ale.
The task may provide original-language customer statements and research; never turn a hypothesis into a quote.

## Checkpoints and version metadata

The current root adapter reads page.json and design.json (including fonts.heading/body/accent catalog IDs).
review.json contains the ten current criteria with id/score/note, observations and rounds (0..2).
Keep captured files/digests/coverage and actual native vision references in review-evidence.json,
not extra fields in the server's closed review object. Ale uses build_metadata.py to construct metadata.
A vision receipt must come from actual native execution evidence, never be invented by this specialist.
No image evidence means visualSkipped=true and passed=false while the draft remains saveable.

Source originals and EN translation/adaptation map: references/santi/source-reference-manifest.json;
read references/santi/ADAPTATION.md when reconciling an original recipe with SaleADS's actual capabilities.

Before structure and art direction, read `../landing-design-variation/SKILL.md`. Use its task-scoped design worksheet for narrative and visual distinction, preserving the current direction during feedback revisions.
