import {
  createSignal,
  createResource,
  For,
  Show,
  createMemo,
  createEffect,
  type Component,
} from 'solid-js';
import { getModelPrices } from '../services/api.js';
import { resolveProviderId } from '../services/routing-utils.js';
import { PROVIDERS } from '../services/providers.js';
import { providerIcon } from './ProviderIcon.js';

interface ModelPricesData {
  models: { model_name: string; provider: string }[];
  lastSyncedAt: string | null;
}

export interface ModelSelectDropdownItem {
  value: string;
  label: string;
  provider: string;
  providerId?: string;
  sublabel?: string;
}

interface ModelSelectDropdownProps {
  selectedValue: string | null;
  onSelect: (cliValue: string, displayLabel: string) => void;
  items?: ModelSelectDropdownItem[];
  loading?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  selectedLabel?: string | null;
  requireSearch?: boolean;
  showSublabel?: boolean;
  compact?: boolean;
  promptLabel?: string;
  showGroupHeaders?: boolean;
}

function computeCliValue(modelName: string, provider: string): string {
  const providerId = provider.toLowerCase();
  return modelName.startsWith(`${providerId}/`) ? modelName : `${providerId}/${modelName}`;
}

/** Resolve a display label for a model name from the PROVIDERS definitions. */
function labelForModel(name: string): string {
  for (const prov of PROVIDERS) {
    for (const m of prov.models) {
      if (m.value === name) return m.label;
    }
  }
  const slash = name.indexOf('/');
  if (slash !== -1) {
    const bare = name.substring(slash + 1);
    for (const prov of PROVIDERS) {
      for (const m of prov.models) {
        if (m.value === bare) return m.label;
      }
    }
    return bare;
  }
  return name;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const ModelSelectDropdown: Component<ModelSelectDropdownProps> = (props) => {
  const [data] = createResource(
    () => (props.items ? null : 'prices'),
    () => getModelPrices() as Promise<ModelPricesData>,
  );
  const [search, setSearch] = createSignal('');
  const [open, setOpen] = createSignal(!(props.selectedValue || props.selectedLabel));
  const [userOpened, setUserOpened] = createSignal(false);

  createEffect(() => {
    if (!userOpened() && (props.selectedValue || props.selectedLabel) && search().trim() === '') {
      setOpen(false);
    }
  });

  const sourceItems = createMemo<ModelSelectDropdownItem[]>(() => {
    if (props.items) return props.items;
    const d = data();
    if (!d?.models) return [];
    return d.models.flatMap((m) => {
      const provId = resolveProviderId(m.provider);
      if (!provId) return [];
      return [
        {
          value: computeCliValue(m.model_name, m.provider),
          label: labelForModel(m.model_name),
          provider: PROVIDERS.find((p) => p.id === provId)?.name ?? m.provider,
          providerId: provId,
          sublabel: m.model_name,
        },
      ];
    });
  });

  const groupedModels = () => {
    const q = search().toLowerCase().trim();
    const normalizedQuery = normalizeSearchText(q);
    if (props.requireSearch && !q) return [];
    type GroupModel = { value: string; label: string; sublabel?: string };
    const groupMap = new Map<string, { provId: string; name: string; models: GroupModel[] }>();

    for (const item of sourceItems()) {
      const provId = item.providerId ?? resolveProviderId(item.provider) ?? item.provider;
      if (!groupMap.has(provId)) {
        groupMap.set(provId, { provId, name: item.provider, models: [] });
      }
      groupMap.get(provId)!.models.push({
        value: item.value,
        label: item.label,
        sublabel: props.showSublabel === false ? undefined : item.sublabel,
      });
    }

    const groups: { provId: string; name: string; models: GroupModel[] }[] = [];
    for (const group of groupMap.values()) {
      if (q) {
        const nameMatch = group.name.toLowerCase().includes(q);
        const filtered = nameMatch
          ? group.models
          : group.models.filter((m) => {
              const searchable = `${m.label} ${m.value} ${m.sublabel ?? ''}`;
              return (
                searchable.toLowerCase().includes(q) ||
                normalizeSearchText(searchable).includes(normalizedQuery)
              );
            });
        if (filtered.length > 0) groups.push({ ...group, models: filtered });
      } else if (group.models.length > 0) {
        groups.push(group);
      }
    }
    return groups;
  };

  const handleSelect = (cliValue: string, label: string) => {
    props.onSelect(cliValue, label);
    setUserOpened(false);
    setOpen(false);
    setSearch('');
  };

  const handleReopen = () => {
    setUserOpened(true);
    setOpen(true);
    setSearch('');
  };

  return (
    <div
      classList={{
        'routing-modal__inline-picker': true,
        'routing-modal__inline-picker--compact': !!props.compact,
        'routing-modal__inline-picker--no-headers': props.showGroupHeaders === false,
      }}
    >
      <Show when={!open() && (props.selectedValue || props.selectedLabel)}>
        <button
          class="routing-modal__selected-display"
          onClick={handleReopen}
          type="button"
          aria-label="Change model selection"
        >
          <span class="routing-modal__selected-label">
            {props.selectedLabel ?? labelForModel(props.selectedValue!.split('/').pop()!)}
          </span>
          <span class="routing-modal__selected-hint">Click to change</span>
        </button>
      </Show>

      <Show when={open()}>
        <div class="routing-modal__search-wrap" style="padding: 0;">
          <svg
            class="routing-modal__search-icon"
            style="left: 14px;"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={(el) => requestAnimationFrame(() => el.focus())}
            class="routing-modal__search"
            type="text"
            placeholder={props.placeholder ?? 'Search models or providers...'}
            aria-label="Search models"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </div>

        <Show when={(props.loading || data.loading) && (!props.requireSearch || search().trim())}>
          <div class="routing-modal__empty">Loading models...</div>
        </Show>

        <Show when={!props.loading && !data.loading && (props.items || data())}>
          <Show
            when={!props.requireSearch || search().trim()}
            fallback={
              <Show when={props.promptLabel}>
                <div class="routing-modal__empty routing-modal__empty--prompt">
                  {props.promptLabel}
                </div>
              </Show>
            }
          >
            <div class="routing-modal__list">
              <For each={groupedModels()}>
                {(group) => (
                  <div class="routing-modal__group">
                    <Show when={props.showGroupHeaders !== false}>
                      <div class="routing-modal__group-header">
                        <span class="routing-modal__group-icon">
                          {providerIcon(group.provId, 16)}
                        </span>
                        <span class="routing-modal__group-name">{group.name}</span>
                      </div>
                    </Show>
                    <For each={group.models}>
                      {(model) => (
                        <button
                          class="routing-modal__model"
                          onClick={() => handleSelect(model.value, model.label)}
                          type="button"
                        >
                          <span class="routing-modal__model-label">{model.label}</span>
                          <Show when={props.showSublabel !== false}>
                            <span class="routing-modal__model-id">
                              {model.sublabel ?? model.value}
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Show when={groupedModels().length === 0}>
                <div class="routing-modal__empty">
                  {props.emptyLabel ?? 'No models match your search.'}
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default ModelSelectDropdown;
export { computeCliValue, labelForModel };
