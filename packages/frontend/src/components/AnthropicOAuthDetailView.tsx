import {
  createEffect,
  createSignal,
  onMount,
  Show,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import {
  startAnthropicOAuth,
  submitAnthropicOAuth,
  revokeAnthropicOAuth,
  getAnthropicOAuthPending,
  renameProviderKey,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import OAuthAccountList from './OAuthAccountList.jsx';

interface Props {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  connected: Accessor<boolean>;
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  onBack: () => void;
  onUpdate: () => void;
  onClose: () => void;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  activeKeys?: Accessor<RoutingProvider[]>;
}

/**
 * Anthropic subscription connect view. Sign in with Claude opens an OAuth
 * popup; the user pastes the resulting `<code>#<state>` payload back into
 * the input. Tokens are stored as refreshable JSON blobs and rotated by
 * the proxy automatically on every request.
 */
const AnthropicOAuthDetailView: Component<Props> = (props) => {
  const [state, setState] = createSignal<string | null>(null);
  const [input, setInput] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [addingAccount, setAddingAccount] = createSignal(false);
  const [refreshingLabel, setRefreshingLabel] = createSignal<string | null>(null);

  const activeKeyCount = () => (props.activeKeys?.() ?? []).length;
  const hasOAuthAccounts = () => activeKeyCount() > 0;
  const showConnectFlow = () => !props.connected() || addingAccount();
  const showConnectedFlow = () => props.connected() && !addingAccount();

  // When "Add another key" is clicked in the header, launch a new OAuth popup.
  createEffect(() => {
    if (props.addKeyOpen?.() && props.connected() && !props.busy()) {
      setAddingAccount(true);
      props.setAddKeyOpen?.(false);
      void handleSignIn();
    }
  });

  // Restore any pending OAuth flow so the paste field still works after the
  // modal was closed mid-dance.
  onMount(async () => {
    if (props.connected()) return;
    try {
      const { state: pending } = await getAnthropicOAuthPending(props.agentName);
      if (pending) setState(pending);
    } catch {
      // Missing pending state just means the user hasn't started a flow yet.
    }
  });

  const handleSignIn = async (label?: string) => {
    props.setBusy(true);
    setError(null);
    try {
      const { url, state: authState } = label
        ? await startAnthropicOAuth(props.agentName, label)
        : await startAnthropicOAuth(props.agentName);
      setState(authState);
      const opened = window.open(url, 'manifest-anthropic-oauth', 'noopener,noreferrer');
      if (!opened) {
        toast.error(
          'Popup was blocked by your browser. Allow popups for this site, then try again.',
        );
        setState(null);
        if (props.connected()) setAddingAccount(false);
        setRefreshingLabel(null);
      }
    } catch {
      if (props.connected()) setAddingAccount(false);
      setRefreshingLabel(null);
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleSubmit = async () => {
    const raw = input().trim().replace(/\s/g, '');
    if (!raw) return;

    if (!raw.includes('#')) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }
    const pastedState = raw.slice(raw.indexOf('#') + 1);
    if (!pastedState) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }

    props.setBusy(true);
    setError(null);
    try {
      const authState = state() ?? pastedState;
      await submitAnthropicOAuth(props.agentName, raw, authState);
      toast.success(
        refreshingLabel()
          ? `${props.provDef.name} subscription refreshed`
          : `${props.provDef.name} subscription connected`,
      );
      setAddingAccount(false);
      setRefreshingLabel(null);
      setInput('');
      setState(null);
      props.onUpdate();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to exchange code. The code may have expired — sign in again to retry.',
      );
    } finally {
      props.setBusy(false);
    }
  };

  const cancelAddAccount = () => {
    setAddingAccount(false);
    setInput('');
    setError(null);
    setState(null);
    setRefreshingLabel(null);
  };

  const handleRefreshKey = (label: string) => {
    setAddingAccount(true);
    setRefreshingLabel(label);
    void handleSignIn(label);
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleDeleteKey = async (label: string) => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName, label);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleRenameKey = async (k: RoutingProvider, newLabel: string) => {
    props.setBusy(true);
    try {
      await renameProviderKey(
        props.agentName,
        props.provId,
        k.label,
        newLabel,
        props.selectedAuthType(),
      );
      toast.success(`Renamed to "${newLabel}"`);
      props.onUpdate();
    } catch {
      // toast handled upstream
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <>
      <Show when={showConnectFlow()}>
        <div class="anthropic-detail__primary">
          <p class="provider-detail__hint">
            Sign in with your Claude Pro or Max account — Manifest will route through your
            subscription with auto-refreshing tokens.
          </p>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy()}
            onClick={() => handleSignIn()}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Sign in with Claude
            </Show>
          </button>
        </div>

        <div class="anthropic-detail__alt">
          <div class="anthropic-detail__alt-divider">
            <span>Paste the authorization code</span>
          </div>
          <p class="anthropic-detail__alt-hint">
            After signing in, Anthropic's redirect page shows a code. Copy the full string and paste
            it below.
          </p>
          <input
            class="provider-detail__input provider-detail__input--masked"
            classList={{ 'provider-detail__input--error': !!error() }}
            type="text"
            autocomplete="off"
            placeholder="Authorization code"
            aria-label="Anthropic authorization code"
            value={input()}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
          />
          <Show when={error()}>
            <div class="provider-detail__error">{error()}</div>
          </Show>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy() || !input().trim()}
            onClick={handleSubmit}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Connect
            </Show>
          </button>
        </div>
        <Show when={addingAccount()}>
          <button
            class="btn btn--outline provider-detail__action"
            disabled={props.busy()}
            onClick={cancelAddAccount}
          >
            Cancel
          </button>
        </Show>
      </Show>
      <Show when={showConnectedFlow()}>
        {/* OAuth account list */}
        <Show when={hasOAuthAccounts()}>
          <OAuthAccountList
            accounts={props.activeKeys!}
            providerName={props.provDef.name}
            subscriptionLabel={props.provDef.subscriptionLabel}
            busy={props.busy}
            onRename={handleRenameKey}
            onRefresh={handleRefreshKey}
            onDelete={handleDeleteKey}
          />
          <button
            class="btn btn--outline provider-detail__action provider-detail__disconnect"
            disabled={props.busy()}
            onClick={handleDisconnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              {activeKeyCount() > 1 ? 'Disconnect all' : 'Disconnect'}
            </Show>
          </button>
        </Show>
        {/* Fallback for legacy connected records that have not loaded key metadata. */}
        <Show when={!hasOAuthAccounts()}>
          <div class="provider-detail__field">
            <span class="provider-detail__no-key">
              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
            </span>
          </div>
          <button
            class="btn btn--outline provider-detail__action provider-detail__disconnect"
            disabled={props.busy()}
            onClick={handleDisconnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Disconnect
            </Show>
          </button>
        </Show>
      </Show>
    </>
  );
};

export default AnthropicOAuthDetailView;
