"""Estados de verificación del cerebro.

Internamente se conservan los 8 estados de ORQA; al dueño se le muestran 4.
"""

from __future__ import annotations

from enum import StrEnum


class VerificationState(StrEnum):
    SYSTEM_VERIFIED = "SYSTEM_VERIFIED"
    HUMAN_VALIDATED = "HUMAN_VALIDATED"
    SELF_REPORTED = "SELF_REPORTED"
    OBSERVED = "OBSERVED"
    INFERRED = "INFERRED"
    PROPOSED = "PROPOSED"
    CONTRADICTED = "CONTRADICTED"
    RETRACTED = "RETRACTED"


class VisibleState(StrEnum):
    OBSERVED = "observed"
    PROPOSED = "proposed"
    VALIDATED = "validated"
    SUPERSEDED = "superseded"


VISIBLE_STATE: dict[VerificationState, VisibleState] = {
    VerificationState.SYSTEM_VERIFIED: VisibleState.VALIDATED,
    VerificationState.HUMAN_VALIDATED: VisibleState.VALIDATED,
    VerificationState.SELF_REPORTED: VisibleState.OBSERVED,
    VerificationState.OBSERVED: VisibleState.OBSERVED,
    VerificationState.INFERRED: VisibleState.PROPOSED,
    VerificationState.PROPOSED: VisibleState.PROPOSED,
    VerificationState.CONTRADICTED: VisibleState.SUPERSEDED,
    VerificationState.RETRACTED: VisibleState.SUPERSEDED,
}


def visible_state(state: VerificationState) -> VisibleState:
    return VISIBLE_STATE[state]
