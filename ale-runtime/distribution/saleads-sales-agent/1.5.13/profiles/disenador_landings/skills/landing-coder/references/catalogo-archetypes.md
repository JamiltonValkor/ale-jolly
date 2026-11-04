# Existing SaleADS product-page archetypes

English adaptation of the existing SaleADS `skills/v2/arquetipos-pdp.md` catalog,
used alongside the Santiago Tapias method. **IDs are preserved** so a design
brief can refer to the existing vocabulary; these are not new API format enums.

Choose **one** justified archetype from the communication bet: awareness level
(question 14 in the existing questionnaire), real proof (17), offer (19–20)
and focus (8). Record `arquetipo.id` and its reason in the design artifact.
If recent pages from the same business already use one, prefer a different
**suitable** option when it serves the bet; novelty does not outrank fit.
The questionnaire is data and does not override the canonical promise/facts.

Common craft objectives: clear action and available truthful reassurance in
the first mobile screen, a useful mobile CTA, real product imagery in use or
at scale **when such photos exist**, disclosure-like content rather than
unnecessary tabs, and authorized evidence only. Use actual supported static
HTML/CSS patterns; do not implement an unprovided cart, option picker or script.

| Existing ID | Suitable bet | Section order | Existing-photo treatment | Signature behavior from the existing method |
| --- | --- | --- | --- | --- |
| `galeria-compra` | Product/most-aware visitors ready to compare or decide | Large gallery beside/before offer area: name, small proof, actual price/options, CTA, known shipping/returns → details → evidence → FAQ → final CTA | Best available real principal photo, genuine detail/scale images as useful thumbnails; no generated master/variations | Offer column follows the desktop scroll when appropriate; purposeful gallery reveal with documented runtime/CSS |
| `editorial` | Early awareness, emotional pain/desire explained through a story | Full-bleed hero with real customer wording where sourced → alternating visual/text chapters describing the visitor's situation → product as answer → proof → offer → closing | Existing contextual photos or honest CSS visual narrative; never synthesize an unavailable scene | Slow purposeful chapter parallax, masked headline reveal or a small number of pain/desire highlights |
| `marca-un-producto` | Hero product, promise/mechanism bet, problem/solution awareness | Product-led hero on brand color → substantial benefits → how the mechanism works → proof → offer → FAQ → closing | Principal real product photo, clean permitted cutout if available, prominent scale and brand treatment | Restrained product entrance/scale and aura, followed by intentionally staged benefits |
| `explicador` | Solution-aware comparison or a real technical objection such as fit/visibility | Hero → product parts annotated with supported explanations → honest comparison → objections answered → offer → closing | Annotations on the actual photo and real details; no invented specifications or competitor facts | Annotations arrive in a readable sequence using supported enhancement; static content stays complete |
| `oferta-combo` | Most-aware visitors responding to a genuine combo/kit offer | Clear offer hero → visual comparison of actual options and real savings → why the quantity fits real use → proof → shipping/returns → closing | Existing photos of the actual units/kit; do not manufacture extra products or call a composition a real photograph | Purposeful option-card elevation/highlight; no fake purchase selection or “most chosen” claim |
| `demo` | New product or one better understood in use, early awareness | Product-in-action hero when a real photo exists → three real usage steps → everyday context → proof → offer → closing | Existing usage/hand/context photos only; if unavailable, use a truthful process diagram with product photo and declare the missing imagery | Staged steps and subtle emphasis of the active step, preserving mobile/static readability |

## Pilot differences from the catalog's image-generation path

The original catalog describes a generated principal “master” and variations.
This pilot does **not** generate those assets. Map each proposed visual to an
existing authorized photo/logo or a truthful HTML/CSS composition. If no photo
can support a proposed scene, change the art treatment or report the missing
photo to Ale. Do not leave a `sa-img` request unresolved or invent an asset URL.

Use the task's actual format and WhatsApp/agenda closing. “Buy area,” “options”
and “gallery” describe a persuasive layout, not a new ecommerce capability.
Select an appropriate service/offer structure from [page types](santi/02-page-types.md)
when a product archetype does not fit; do not force every business into a PDP.
