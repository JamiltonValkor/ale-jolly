"""Managed observer plugin using official Hermes lifecycle hooks only."""
import logging

from .context import ROOT, pack, resolve
from .notifications import capture
from .delivery import register as register_delivery
from .turn_frames import TurnFrames
from .goal_delivery import bind_wake, deliver as deliver_goal_result
from .run_receipts import ReceiptError, capture as capture_api_run_acceptance

logger = logging.getLogger(__name__)


def register(ctx, *, root=ROOT):
    generation = TurnFrames()
    def pre(*, session_id='', turn_id='', user_message='', platform='', **_kwargs):
        identity = ctx.current_cron_execution()
        value = resolve(session_id=session_id, cron_identity=identity, root=root)
        if identity is None and platform == 'api_server':
            try:
                capture_api_run_acceptance(value, user_message, native_session_id=session_id,
                    root=root, home=root.parent.parent)
            except (OSError, ReceiptError):
                # Observer failures never emit request text, credentials, or source exceptions.
                logger.warning('SaleADS API-run acceptance receipt could not be persisted')
        wake = bind_wake(value, session_id=session_id, user_message=user_message, platform=platform,
            cron_identity=identity, root=root, resolver=resolve)
        generation.record(turn_id, (session_id, getattr(identity, 'execution_id', None), value, wake))
        return pack(value)

    def post(*, session_id='', turn_id='', assistant_response='', **_kwargs):
        original = generation.take(turn_id)
        identity = ctx.current_cron_execution()
        if identity is None:
            if original and original[3] is not None:
                return deliver_goal_result(original[3], assistant_response, root=root, current_resolver=resolve)
            return
        # Native compaction may rotate session_id within this same execution.
        # The frozen server binding and immutable native execution ID remain exact.
        value = original[2] if original and original[1] == identity.execution_id else None
        try:
            capture(value, identity, assistant_response, root=root)
        except OSError:
            # Logs only a fixed diagnostic; never print text, context, user IDs, or credentials.
            logger.warning('SaleADS native result receipt could not be persisted')

    ctx.register_hook('pre_llm_call', pre)
    ctx.register_hook('post_llm_call', post)
    register_delivery(ctx, root=root)
