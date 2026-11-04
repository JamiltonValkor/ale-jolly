import type {AssistantStateV1} from '../contracts/v1';
import type {AssistantStateReader} from '../state/assistant-state';
import type {CredentialRenewal} from './credential-renewal';

/**
 * Decorador del lector de estado (compone con el de OCB-008, sin tocarlo).
 * En cada `GET /assistants/me`:
 *
 * - si quedó un fallo de renovación pendiente, reintenta la resiembra en
 *   segundo plano (debounce);
 * - si el refresh guardado ya no sirve (invalid_grant), expone el estado
 *   honesto `activating / preparing_access` («Preparando tu acceso»): el front
 *   hace entonces el salto SSO silencioso con `POST /assistants/me/activation`,
 *   que devuelve la `authorize_url` con `prompt=none`. Nunca «reautoriza».
 *
 * Un asistente apagado (`stopped`) conserva su estado: se recupera al reactivar.
 */
export class RenewalAwareStateReader implements AssistantStateReader {
  constructor(private readonly inner: AssistantStateReader, private readonly renewal: CredentialRenewal) {}

  async read(userId: string): Promise<AssistantStateV1> {
    const state = await this.inner.read(userId);
    if (state.status !== 'ready' && state.status !== 'activating') return state;
    if (state.status === 'activating' && state.step === 'preparing_access') return state;
    let needsSso = false;
    try {
      ({needsSso} = await this.renewal.onStateRead(userId));
    } catch {
      return state;
    }
    return needsSso ? {...state, status: 'activating', step: 'preparing_access', slow: false} : state;
  }
}
