# Step 7 · Review before handoff

English adaptation of **Santiago Tapias**, existing SaleADS reference
`skills/v2/santi/08-revision.md`. The page is not verified merely because its
files were written. Inspect real evidence, use the checklist and explicitly
report checks that could not be performed.

## Review tools: use what is actually available

The original standalone workflow calls Node 22+/Chrome scripts named
`revisar-pagina.mjs`, `revisar-textos.mjs`, `capturar.mjs` and
`revisar-enlaces.mjs`. This pilot does not assume those scripts are installed
or grant terminal access by mentioning their names. Ask Ale to use SaleADS'
actual validation and preview/capture capabilities through the governed CLI.
Use available file/image tools for inspection. Do not claim a nonexistent tool
ran successfully or add an independent browser/backend generator.

The original text checker inspects filler, pending markers, register and
figures that need a source. Retain that manual pass from [copywriting](03-copywriting.md)
when an equivalent checker is unavailable. A publishability checker is not a
substitute for factual, copy or visual review.

## Thorough visual QA

The source reviews first screens at **360, 390, 768, 1024 and 1440px**, the full
page at each width and a closer view of a complex hero/banner. With an approved
visual reference, compare page and reference side by side. Preserve this test
matrix as the target, not a claim that every requested capture mode exists.
The current SaleADS capture primitive uses 390/1440px and a limited number of
tiles; it freezes entrances. Additional widths, lower-page content, zoom and
actual animation may need separately available browser evidence. State gaps.

Inspect every available capture:

- Did an element move across breakpoints for a reason, or does it collide?
- Are heads, hands or the real product cropped accidentally?
- Do cutouts have visible halos or mismatched edges?
- Does text cover a face or lose contrast on a photograph?
- Does a CTA split across lines or become too small?
- Is a multi-layer composition convincing at its actual viewing size?

A reference comparison should preserve structure/feeling with the business's
own content and existing photos; do not duplicate someone else's design.

## 1. Truth and content

- [ ] Every number, identity, testimonial, review, logo, credential, price and
      date comes from the supplied brief and authorized evidence.
- [ ] Unsupported blocks are omitted or adapted using supported information;
      missing facts are reported to Ale. No fabricated filler or public
      `[TO CONFIRM]`, TODO, sample identity or unexplained pixel placeholder.
- [ ] Actual total price/currency are clear where applicable; genuine dates
      include time/time zone when relevant.
- [ ] Deadline, capacity, counter, crossed-out price and “most chosen” claims
      have a real source and approved use.
- [ ] Page and ad agree on promise, price, bonus and timing.
- [ ] A missing-data block was not disguised with generic language.

## 2. First screen and structure

- [ ] At mobile width, the headline explains what the visitor gets and who it
      is for; the subheadline, approved CTA and available small proof can be
      seen without an unnecessarily long scroll. No proof is invented to fit.
- [ ] No premature “false floor” makes the page appear finished halfway through.
- [ ] Headings alone tell the complete argument from top to bottom.
- [ ] One main goal; repeat its same CTA after relevant argument blocks.
- [ ] Risk doubts such as actual return terms, payment conditions or response
      expectations are answered near the action when supported.

## 3. Design

- [ ] The page is visually intentional: a memorable business-relevant element,
      color rhythm and a strong close, not merely a technically valid template.
- [ ] Concept comes from this business and bet; sections are not interchangeable
      with every other business's landing.
- [ ] Usually two type families, a justified optional accent, consistent edges
      and a coherent theme, using the existing approved font catalog.
- [ ] Existing real photos, honest compositions and a sharp authorized logo.
- [ ] No crowding, clipping or accidental misalignment in 390/1440px evidence.
- [ ] No content remains invisible waiting for a motion library or script.
- [ ] The requested five-width/full-page/banner-detail matrix is checked where
      the available tools support it; any unobserved part is explicitly unverified.
- [ ] A supplied reference comparison uses this business's brand/photos/copy.

## 4. Technical review

- [ ] Available browser evidence shows no console errors or failed image/font/
      trusted-runtime resources. Do not claim a console check from a screenshot.
- [ ] No horizontal overflow in the widths actually checked; identify the
      offending selector rather than hiding a broken layout indiscriminately.
- [ ] Buttons have mouse, pressed and visible keyboard-focus states; labels fit.
- [ ] Motion failures leave all meaningful content visible; reduced-motion works.
- [ ] Images have useful alt text and dimensions/aspect ratio; controls have
      accessible names; a single meaningful H1; headings remain hierarchical.
- [ ] Action destinations are valid **after publication**. The required
      `href="#"` with the configured `data-cta` (`whatsapp` or `agenda`) is an intentional SaleADS draft marker,
      not an error to replace with a made-up URL. Ordinary empty links remain errors.
- [ ] Do not add forms or fields here. Any trusted injected/existing destination
      must own its actual labels, privacy terms and behavior.
- [ ] HTML includes title, UTF-8, viewport and `lang` from the supplied locale.
      Description/social metadata use actual supported assets when applicable.
- [ ] The original source suggests a mobile PageSpeed target around 90 for a
      published page; measure only through an actually available authorized
      tool. It is a target, not a result inferred from the file size.

## 5. Links and external destinations

The source's link review checks URL formatting and reachability without opening
checkouts or firing conversion pixels. Retain that separation:

- [ ] Ordinary links and anchors are real, purposeful and internally consistent.
- [ ] The published WhatsApp destination has the configured country code/number
      and readable message; do not confuse a sample number with the business's.
- [ ] `tel:`/`mailto:` links, if actually permitted, use correct formats.
- [ ] The real destination matches the CTA's claim, not just an HTTP 200.
- [ ] An existing agenda destination opens valid availability when that check
      is authorized and available; do not fabricate a calendar integration.
- [ ] Checkout/form/thank-you behavior in the original method is conditional on
      a separately implemented system; it is not built or tested by this pilot.
- [ ] Do not submit visitor/contact data, send messages, place an order, pay or
      open a conversion confirmation with a live pixel merely to test a landing.

## 6. Measurement and identity

- [ ] SaleADS' trusted publisher owns the configured pixel, runtime, events and
      CTA/embeds. No duplicate tracking or arbitrary injected scripts from the coder.
- [ ] Tracking continuity and event timing are checked by the actual platform
      test when available; preview HTML alone proves neither.
- [ ] Identity/contact/policy content reflects the real supplied business and
      existing publisher behavior. Do not invent a guarantee or legal statement.
- [ ] Test indexing state follows the platform's actual publishing settings;
      do not claim a noindex flag has been set without evidence.
- [ ] Published files contain no secrets, personal datasets or operational credentials.

## Handoff

Return to Ale: what was built, actual file/version/digest references, which
captures/checks were observed, factual omissions, concrete remaining issues and
next action. Owner-facing summary stays brief and uses the configured locale;
no internal JSON or tool transcript. An unavailable capture remains unverified,
not an aesthetic PASS. The visual rubric is consultative, while validation and
truth constraints remain mandatory under the existing platform rules.
