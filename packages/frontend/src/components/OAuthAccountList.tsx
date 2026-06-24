import { createSignal, For, Show, type Accessor, type Component } from 'solid-js';
import type { RoutingProvider } from '../services/api.js';

const MAX_LABEL_LENGTH = 50;

interface Props {
  accounts: Accessor<RoutingProvider[]>;
  providerName: string;
  subscriptionLabel?: string;
  busy: Accessor<boolean>;
  onRename: (account: RoutingProvider, newLabel: string) => void | Promise<void>;
  onRefresh: (label: string) => void;
  onDelete: (label: string) => void | Promise<void>;
}

const OAuthAccountList: Component<Props> = (props) => {
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');

  const startRename = (account: RoutingProvider) => {
    setRenamingId(account.id);
    setRenameValue(account.label);
  };

  const commitRename = async (account: RoutingProvider) => {
    const newLabel = renameValue().trim();
    if (!newLabel || newLabel === account.label) {
      setRenamingId(null);
      return;
    }
    await props.onRename(account, newLabel);
    setRenamingId(null);
  };

  return (
    <div class="provider-detail__field">
      <label class="provider-detail__label">Accounts</label>
      <ul
        role="list"
        aria-label={`OAuth accounts for ${props.providerName}`}
        style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;"
      >
        <For each={props.accounts()}>
          {(account) => (
            <li style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--muted) / 0.3);">
              <Show
                when={renamingId() === account.id}
                fallback={
                  <>
                    <div style="flex: 1; min-width: 0;">
                      <div style="font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {account.label}
                      </div>
                      <div style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                        Connected via {props.subscriptionLabel ?? 'subscription'}
                      </div>
                    </div>
                    <button
                      class="btn btn--outline btn--sm"
                      style="flex-shrink: 0;"
                      disabled={props.busy()}
                      onClick={() => startRename(account)}
                    >
                      Rename
                    </button>
                    <button
                      class="btn btn--outline btn--sm"
                      style="flex-shrink: 0;"
                      disabled={props.busy()}
                      onClick={() => props.onRefresh(account.label)}
                      aria-label={`Refresh OAuth token for ${account.label}`}
                    >
                      Refresh
                    </button>
                    <button
                      class="provider-detail__disconnect-icon"
                      disabled={props.busy()}
                      onClick={() => props.onDelete(account.label)}
                      aria-label={`Delete account ${account.label}`}
                      title="Delete account"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </>
                }
              >
                <input
                  class="provider-detail__input"
                  type="text"
                  maxlength={MAX_LABEL_LENGTH}
                  aria-label={`Rename ${account.label}`}
                  value={renameValue()}
                  onInput={(e) => setRenameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(account);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
                <button
                  class="btn btn--primary btn--sm"
                  disabled={props.busy()}
                  onClick={() => void commitRename(account)}
                >
                  Save
                </button>
                <button
                  class="btn btn--outline btn--sm"
                  disabled={props.busy()}
                  onClick={() => setRenamingId(null)}
                >
                  Cancel
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

export default OAuthAccountList;
