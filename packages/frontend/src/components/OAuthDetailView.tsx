import {
  createEffect,
  onCleanup,
  createSignal,
  Show,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import {
  getPopupOauthApi,
  renameProviderKey,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { monitorOAuthPopup } from '../services/oauth-popup.js';
import OAuthAccountList from './OAuthAccountList.jsx';

function parseOAuthCallbackInput(raw: string, fallbackState: string | null) {
  let code: string | null = null;
  let state: string | null = fallbackState;
  const parts = raw.split(/\s+/).filter(Boolean);

  for (const part of parts) {
    try {
      const url = new URL(part);
      code = code ?? url.searchParams.get('code');
      state = state ?? url.searchParams.get('state');
    } catch {
      if (!code && /^[A-Za-z0-9._~-]{20,}$/.test(part)) {
        code = part;
      }
    }
  }

  return { code, state };
}

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
  onPollProviders?: () => void | Promise<void>;
  onClose: () => void;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  activeKeys?: Accessor<RoutingProvider[]>;
}

const OAuthDetailView: Component<Props> = (props) => {
  const [pasteFlowActive, setPasteFlowActive] = createSignal(false);
  const [flowKeyCount, setFlowKeyCount] = createSignal<number | null>(null);
  const [successHandled, setSuccessHandled] = createSignal(false);
  const [pasteUrl, setPasteUrl] = createSignal('');
  const [pasteError, setPasteError] = createSignal<string | null>(null);
  const [oauthState, setOauthState] = createSignal<string | null>(null);
  const [addingAccount, setAddingAccount] = createSignal(false);
  const [refreshingLabel, setRefreshingLabel] = createSignal<string | null>(null);

  // Dispose the OAuth popup monitor if the view unmounts mid-flow, otherwise its
  // 300ms URL poll keeps running after the component is gone.
  let disposeOAuthMonitor: (() => void) | null = null;
  onCleanup(() => disposeOAuthMonitor?.());

  const isMultiKey = () => (props.activeKeys?.() ?? []).length > 1;
  const isXaiProvider = () => props.provId === 'xai';
  const isOpenAiProvider = () => props.provId === 'openai';
  const callbackPlaceholder = () =>
    isXaiProvider()
      ? 'Paste the xAI authorization code or callback URL'
      : 'http://localhost:1455/auth/callback?code=...';
  const showConnectFlow = () => !props.connected() || addingAccount() || pasteFlowActive();
  const showConnectedFlow = () => props.connected() && !addingAccount() && !pasteFlowActive();
  const activeKeyCount = () => (props.activeKeys?.() ?? []).length;
  const flowHasConnected = () => {
    const baseline = flowKeyCount();
    if (baseline === null) return false;
    return baseline > 0 ? activeKeyCount() > baseline : props.connected();
  };

  const finishOAuthSuccess = () => {
    if (successHandled()) return;
    setSuccessHandled(true);
    setPasteFlowActive(false);
    setFlowKeyCount(null);
    setPasteUrl('');
    setPasteError(null);
    setOauthState(null);
    setAddingAccount(false);
    toast.success(
      refreshingLabel()
        ? `${props.provDef.name} subscription refreshed`
        : `${props.provDef.name} subscription connected`,
    );
    setRefreshingLabel(null);
    props.onUpdate();
  };

  // When "Add another key" is clicked in the header, launch a new OAuth popup.
  createEffect(() => {
    if (props.addKeyOpen?.() && props.connected() && !props.busy()) {
      setAddingAccount(true);
      props.setAddKeyOpen?.(false);
      void handleOAuthLogin();
    }
  });

  const oauthApi = () => getPopupOauthApi(props.provId);

  createEffect(() => {
    if (!pasteFlowActive()) return;
    const poll = props.onPollProviders ?? props.onUpdate;
    const interval = window.setInterval(() => {
      poll();
    }, 2000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    if (pasteFlowActive() && flowHasConnected()) finishOAuthSuccess();
  });

  const handleOAuthLogin = async (label?: string) => {
    props.setBusy(true);
    setPasteUrl('');
    setPasteError(null);
    try {
      const { url } = label
        ? await oauthApi().getUrl(props.agentName, label)
        : await oauthApi().getUrl(props.agentName);
      try {
        setOauthState(new URL(url).searchParams.get('state'));
      } catch {
        setOauthState(null);
      }
      const popup = window.open(url, 'manifest-oauth', 'width=500,height=700');
      if (!popup) {
        toast.error(
          'Popup was blocked by your browser. Allow popups for this site, then try again.',
        );
        if (props.connected()) setAddingAccount(false);
        setRefreshingLabel(null);
        setOauthState(null);
        props.setBusy(false);
        return;
      }

      setPasteFlowActive(true);
      setFlowKeyCount(activeKeyCount());
      setSuccessHandled(false);
      props.setBusy(false);

      // Dispose any in-flight monitor from a previous start before replacing it,
      // so repeated logins don't orphan the earlier poll/listener handle.
      disposeOAuthMonitor?.();
      disposeOAuthMonitor = monitorOAuthPopup(
        popup,
        {
          onSuccess: finishOAuthSuccess,
          onFailure: () => {
            // Popup closed without auto-redirect — user needs to paste the URL
          },
        },
        `/oauth/${props.provId}/done`,
      );
    } catch {
      if (props.connected()) setAddingAccount(false);
      setRefreshingLabel(null);
      props.setBusy(false);
    }
  };

  const handleRefreshKey = (label: string) => {
    setAddingAccount(false);
    setRefreshingLabel(label);
    void handleOAuthLogin(label);
  };

  const handlePasteSubmit = async () => {
    const raw = pasteUrl().trim();
    if (!raw) return;

    try {
      const { code, state } = parseOAuthCallbackInput(raw, oauthState());
      if (!code || !state) {
        setPasteError(
          props.provId === 'xai'
            ? 'Paste the authorization code shown by xAI, or paste the full callback URL after approval.'
            : 'URL is missing the authorization code. Make sure you copied the full URL.',
        );
        return;
      }

      props.setBusy(true);
      setPasteError(null);
      await oauthApi().submitCallback(code, state);
      finishOAuthSuccess();
    } catch {
      setPasteError('Failed to exchange token. The URL may have expired — try logging in again.');
    } finally {
      props.setBusy(false);
    }
  };

  const cancelAddAccount = () => {
    setAddingAccount(false);
    setPasteFlowActive(false);
    setFlowKeyCount(null);
    setSuccessHandled(false);
    setPasteUrl('');
    setPasteError(null);
    setOauthState(null);
    setRefreshingLabel(null);
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await oauthApi().revoke(props.agentName);
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
      const result = await oauthApi().revoke(props.agentName, label);
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
        <Show
          when={pasteFlowActive()}
          fallback={
            <>
              <p class="provider-detail__hint">
                Log in with your {props.provDef.name} account to connect your subscription.
              </p>
              <button
                class="btn btn--primary provider-detail__action"
                disabled={props.busy()}
                onClick={() => handleOAuthLogin()}
              >
                <Show when={!props.busy()} fallback={<span class="spinner" />}>
                  Log in with {props.provDef.name}
                </Show>
              </button>
            </>
          }
        >
          <Show
            when={isXaiProvider()}
            fallback={
              <>
                <p class="provider-detail__hint">
                  A login window has opened. If it does not close automatically after sign-in, paste
                  the callback URL below.
                </p>
                <Show when={isOpenAiProvider()}>
                  <p class="provider-detail__hint" style="margin-top: 8px;">
                    Copy the full URL from the{' '}
                    <span style="color: hsl(var(--foreground)); font-weight: 500;">
                      popup's address bar
                    </span>{' '}
                    and paste it below:
                  </p>
                  <video
                    src="/images/oauth-callback-example.mp4"
                    poster="/images/oauth-callback-example.png"
                    preload="auto"
                    autoplay
                    loop
                    muted
                    playsinline
                    style="width: 100%; border-radius: var(--radius); border: 1px solid hsl(var(--border)); margin-top: 12px;"
                  />
                </Show>
              </>
            }
          >
            <p class="provider-detail__hint">
              A login window has opened. After approving access, paste the authorization code xAI
              shows. If your browser lands on a callback URL, paste that URL instead.
            </p>
          </Show>
          <div class="provider-detail__field" style="margin-top: 12px;">
            <input
              type="text"
              class="provider-detail__input"
              classList={{ 'provider-detail__input--error': !!pasteError() }}
              autocomplete="off"
              placeholder={callbackPlaceholder()}
              value={pasteUrl()}
              onInput={(e) => {
                setPasteUrl(e.currentTarget.value);
                setPasteError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handlePasteSubmit();
              }}
            />
            <Show when={pasteError()}>
              <div class="provider-detail__error">{pasteError()}</div>
            </Show>
            <button
              class="btn btn--primary btn--sm provider-detail__action"
              style="margin-top: 8px;"
              disabled={props.busy() || !pasteUrl().trim()}
              onClick={handlePasteSubmit}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Connect
              </Show>
            </button>
          </div>
        </Show>
        <Show when={addingAccount() || refreshingLabel()}>
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
        {/* Multi-key list */}
        <Show when={isMultiKey()}>
          <OAuthAccountList
            accounts={props.activeKeys!}
            providerName={props.provDef.name}
            subscriptionLabel={props.provDef.subscriptionLabel}
            busy={props.busy}
            onRename={handleRenameKey}
            onRefresh={handleRefreshKey}
            onDelete={handleDeleteKey}
          />
          <div class="provider-detail__footer">
            <button
              class="btn btn--outline provider-detail__disconnect"
              disabled={props.busy()}
              onClick={handleDisconnect}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Disconnect all
              </Show>
            </button>
            <div style="flex: 1;" />
            <button class="btn btn--primary btn--sm" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </Show>
        {/* Single key — original view */}
        <Show when={!isMultiKey()}>
          <div class="provider-detail__field">
            <span class="provider-detail__no-key">
              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
            </span>
          </div>
          <div class="provider-detail__footer">
            <button
              class="btn btn--outline provider-detail__disconnect"
              disabled={props.busy()}
              onClick={handleDisconnect}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Disconnect
              </Show>
            </button>
            <div style="flex: 1;" />
            <button class="btn btn--primary btn--sm" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </Show>
      </Show>
    </>
  );
};

export default OAuthDetailView;
