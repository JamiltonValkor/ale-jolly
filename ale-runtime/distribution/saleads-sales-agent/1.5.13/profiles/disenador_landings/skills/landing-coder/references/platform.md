# Existing SaleADS platform contract

Two publishable files: index.html and styles.css. HTML is complete HTML5 with doctype, lang from task locale,
UTF-8, viewport and title, and exactly <link rel="stylesheet" href="styles.css">.
Every editable text node carries a unique stable data-edit kebab-case ID.
CTA: <a href="#" data-cta="whatsapp" data-edit="..."> or data-cta="agenda" as actually configured.
VSL shell: <div data-vsl></div> only when that approved format applies.
Testimonials: data-testimonial with an actual approved source ID only; do not invent/authorize one yourself.

SaleADS injects runtime, pixel, trusted CTA URL, video/agenda embeds and legal footer on publication.
You do not write script, iframe, form, object/embed, base, event handlers or arbitrary external resources.
No CDN, Google Fonts, @import, javascript URLs, remote CSS or arbitrary image URLs.
Fonts/icons come from the existing catalogs. Font variables: --sa-font-heading/body/accent;
SaleADS deterministically prepares the sa-fonts block. Use exact allowed photos/logo URLs or prepared /_sa/a assets.

Supported declarative animation examples from the existing engine:
data-sa-split, data-sa-pin/data-sa-step, data-sa-horizontal/data-sa-track, data-sa-reveal-image,
data-sa-scrub, data-sa-load, data-sa-reveal, data-sa-mark, data-sa-parallax, data-sa-magnetic.
Use only documented existing effects. A real counter requires a real number from context.
Do not hide content until a library runs; honor prefers-reduced-motion.

The actual validator returned by SaleADS remains authoritative. Its blocks must be corrected, warnings
remain available to the owner's web review. Do not substitute an aesthetic score for validator approval.
