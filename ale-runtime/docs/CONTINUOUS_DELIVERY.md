# Managed owner delivery

Managed scheduled jobs use `deliver="saleads_home:current"`. The official Hermes
plugin registers an outbound-only `saleads_home` platform with its supported
`register_platform` API. Enable `platforms.saleads_home.enabled`; do not set a
virtual home-channel environment variable. Existing jobs and native `/sethome`
settings are not implicitly changed by installing the extension.

At send time the adapter resolves the owner's current native homes, excluding
itself, and delegates to Hermes' native adapter/standalone sender. It does not
replace built-in adapters, receive messages, call a model, or select targets
from model arguments. Both live and standalone managed delivery use the same
receipt engine. The selected target set has a stable fingerprint.

Only an actual native cron execution whose job is server-bound to an owner,
business, canonical session, and configured user language may use the selector.
The final text must match that execution's generation receipt. Text uses the same
whitespace normalization as the visible-result collector. A language change
during generation cannot relabel the old response as having the new language or
send it outward under that label.

Before a native sender is called, an attempt record is persisted. The record
binds the execution/job, source-text hash, owner/business/session, language
revision, and target fingerprints. A restart, lost acknowledgement, concurrent
replay, or unknown result does not authorize another send of that attempt.
Positive provider receipts are persisted after the native sender returns full
success with a message ID or a structured provider response. A boolean success
alone, a boolean message ID, and a partial chunk send are not confirmation.

One fully confirmed current owner home makes the canonical notice delivered.
Other configured homes retain their separate failures/uncertain outcomes. This
avoids a second SaleADS notification after the owner already received the full
result on one selected home. The rule does not claim that the owner has read
the message, or that every configured home succeeded.

The read-only exporter joins the exact native execution, generation receipt,
and managed delivery receipt. It can recover a crash after a per-target ACK was
saved but before aggregate bookkeeping completed. It never changes Hermes
tables or launches inference to move generated text.

Without a home, or after a confirmed pre-send failure, SaleADS is the fallback.
An uncertain acknowledgement is reconciled under the same attempt for a finite
120-second window. A later positive receipt can confirm that attempt without
resending. When no provider confirmation exists before the fallback deadline,
external duplication remains possible; no exactly-once external guarantee is
made. The SaleADS notice itself retains one canonical identity.

Receipt files and generated result projections remain private runtime data.
They are not agent memories, owner statements, or proof of commercial success.
Tests with synthetic adapters establish mechanism compatibility; acceptance
still requires the authorized owner's actual configured home and localhost flow.
