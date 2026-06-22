import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
  type Component,
  type Setter,
} from 'solid-js';
import {
  connectProvider,
  disconnectProvider,
  getProviderModels,
  refreshProviderModels,
  addManualModel,
  updateManualModelSettings,
  removeManualModel,
  type AuthType,
  type AvailableModel,
  type ParamSchemaRef,
  type RoutingProvider,
} from '../services/api.js';
import {
  getCatalogModelParamSpecs,
  listModelParamSpecIndex,
  type ModelParamSpecId,
} from '../services/api/model-params.js';
import {
  compareProviderParamSpecs,
  providerParamIsApplicable,
  setProviderParamValue,
  type ModelParamDefinition,
  type ProviderParamSpec,
  type RequestParamDefaults,
} from 'manifest-shared';
import { formatTimeAgo } from '../services/formatters.js';
import { highlight } from '../services/syntax-highlight.js';
import { getRoutingProviderApiKeyUrl } from '../services/provider-api-key-urls.js';
import { PROVIDERS } from '../services/providers.js';
import { toast } from '../services/toast-store.js';
import AnthropicOAuthDetailView from './AnthropicOAuthDetailView.js';
import CopyButton from './CopyButton.js';
import DeviceCodeDetailView from './DeviceCodeDetailView.js';
import OAuthDetailView from './OAuthDetailView.js';
import { providerIcon } from './ProviderIcon.js';
import ProviderKeyForm, { MAX_KEYS_PER_PROVIDER } from './ProviderKeyForm.js';
import ProviderSubviewHeader, { type ProviderSubviewLayout } from './ProviderSubviewHeader.js';
import ModelSelectDropdown, { type ModelSelectDropdownItem } from './ModelSelectDropdown.js';

export interface ProviderDetailViewProps {
  provId: string;
  agentName: string;
  providers: RoutingProvider[];
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  keyInput: Accessor<string>;
  setKeyInput: Setter<string>;
  editing: Accessor<boolean>;
  setEditing: Setter<boolean>;
  validationError: Accessor<string | null>;
  setValidationError: Setter<string | null>;
  onBack: () => void;
  onUpdate: () => void;
  onPollProviders?: () => void | Promise<void>;
  onClose: () => void;
  initialAddKey?: boolean;
  layout?: ProviderSubviewLayout;
}

const ProviderDetailView: Component<ProviderDetailViewProps> = (props) => {
  const provDef = PROVIDERS.find((p) => p.id === props.provId)!;

  const getProviderByAuth = (authType: AuthType) =>
    props.providers.find((p) => p.provider === props.provId && p.auth_type === authType);

  const isConnectedApiKey = (): boolean => {
    const p = getProviderByAuth('api_key');
    return !!p && p.is_active && p.has_api_key;
  };

  const isSubscriptionConnected = (): boolean => {
    const p = getProviderByAuth('subscription');
    return !!p && p.is_active;
  };

  const isSubscriptionWithToken = (): boolean => {
    const p = getProviderByAuth('subscription');
    return !!p && p.is_active && p.has_api_key;
  };

  const isNoKeyConnected = (): boolean => {
    const p = getProviderByAuth('api_key');
    return !!p && p.is_active && !!provDef.noKeyRequired;
  };

  const getKeyPrefixDisplay = (authType: AuthType): string => {
    const p = getProviderByAuth(authType);
    if (p?.key_prefix) return `${p.key_prefix}${'•'.repeat(8)}`;
    return '••••••••••••';
  };

  const isSubMode = () => props.selectedAuthType() === 'subscription';
  const subscriptionAuthMode = () =>
    provDef.subscriptionAuthMode ?? (provDef.subscriptionKeyPlaceholder ? 'token' : undefined);
  const isPopupOAuthFlow = () => isSubMode() && subscriptionAuthMode() === 'popup_oauth';
  const isPopupPasteFlow = () => isSubMode() && subscriptionAuthMode() === 'popup_paste';
  const isDeviceCodeFlow = () => isSubMode() && subscriptionAuthMode() === 'device_code';
  const isCommandOnly = () =>
    isSubMode() &&
    !!provDef.subscriptionCommand &&
    !provDef.subscriptionKeyPlaceholder &&
    !subscriptionAuthMode();
  const connected = () =>
    isSubMode()
      ? isCommandOnly()
        ? isSubscriptionConnected()
        : subscriptionAuthMode() === 'token'
          ? isSubscriptionWithToken()
          : isSubscriptionConnected()
      : isConnectedApiKey() || isNoKeyConnected();
  const isOllama = provDef.noKeyRequired;

  const [addKeyOpen, setAddKeyOpen] = createSignal(false);

  const [manualName, setManualName] = createSignal('');
  const [manualInputPrice, setManualInputPrice] = createSignal('');
  const [manualOutputPrice, setManualOutputPrice] = createSignal('');
  const [paramSpecOptions, setParamSpecOptions] = createSignal<ModelParamSpecId[]>([]);
  const [paramSpecOptionsLoaded, setParamSpecOptionsLoaded] = createSignal(false);
  const [addingModel, setAddingModel] = createSignal(false);
  const [manualModelError, setManualModelError] = createSignal<string | null>(null);
  const [settingsModel, setSettingsModel] = createSignal<AvailableModel | null>(null);
  const [settingsSchemaValue, setSettingsSchemaValue] = createSignal('');
  const [settingsCustomSchemaJson, setSettingsCustomSchemaJson] = createSignal('[]');
  const [settingsJson, setSettingsJson] = createSignal('{}');
  const [settingsSchemaKeySignature, setSettingsSchemaKeySignature] = createSignal<string | null>(
    null,
  );
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  let modelsScrollRef: HTMLDivElement | undefined;
  let jsonHighlightRef: HTMLPreElement | undefined;

  createEffect(() => {
    if (props.initialAddKey) setAddKeyOpen(true);
  });

  const supportsMultiKey = () => props.selectedAuthType() !== 'local';

  const activeKeys = createMemo(() =>
    props.providers.filter(
      (p) =>
        p.provider === props.provId &&
        p.auth_type === props.selectedAuthType() &&
        p.is_active &&
        p.has_api_key,
    ),
  );

  const showAddKeyButton = () =>
    connected() &&
    supportsMultiKey() &&
    activeKeys().length < MAX_KEYS_PER_PROVIDER &&
    !addKeyOpen();

  const handleOllamaConnect = async () => {
    props.setBusy(true);
    try {
      await connectProvider(props.agentName, {
        provider: props.provId,
        authType: props.selectedAuthType(),
      });
      toast.success(`${provDef.name} connected`);
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const [refreshing, setRefreshing] = createSignal(false);
  const [providerModels, setProviderModels] = createSignal<AvailableModel[] | null>(null);

  const activeProviderRow = () => getProviderByAuth(props.selectedAuthType());
  const lastFetchedAgo = () => formatTimeAgo(activeProviderRow()?.models_fetched_at ?? null);

  const loadProviderModels = async () => {
    if (!connected()) {
      setProviderModels(null);
      return;
    }
    try {
      setProviderModels(
        await getProviderModels(props.agentName, props.provId, props.selectedAuthType()),
      );
    } catch {
      setProviderModels(null);
    }
  };

  createEffect(() => {
    void (props.agentName, props.provId, props.selectedAuthType(), props.providers);
    void loadProviderModels();
  });

  const schemaValue = (ref: ParamSchemaRef): string =>
    `${ref.provider}\t${ref.authType}\t${ref.model}`;

  const selectedSettingsParamSchemaRef = (): ParamSchemaRef | null => {
    const raw = settingsSchemaValue();
    if (!raw) return null;
    const [provider, authType, model] = raw.split('\t');
    if (!provider || !authType || !model) return null;
    return { provider, authType: authType as AuthType, model };
  };

  const paramSchemaOptions = (): ModelSelectDropdownItem[] =>
    paramSpecOptions().map((item) => ({
      value: schemaValue(item),
      label: item.model,
      provider: item.provider,
      providerId: item.provider,
    }));

  const requestParamDefaultsFromSpecs = (
    specs: readonly ProviderParamSpec[],
  ): RequestParamDefaults | null => {
    let out: RequestParamDefaults = {};
    for (const spec of [...specs].sort(compareProviderParamSpecs)) {
      if (spec.default === undefined) continue;
      if (!providerParamIsApplicable(spec, out)) continue;
      out = setProviderParamValue(out, spec.path, spec.default);
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const keySignature = (value: RequestParamDefaults | null): string => {
    const paths: string[] = [];
    const visit = (item: unknown, prefix: string): void => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(path);
        visit((item as Record<string, unknown>)[key], path);
      }
    };
    visit(value ?? {}, '');
    return paths.join('\n');
  };

  const parseSettingsJsonLenient = (): RequestParamDefaults | null | undefined => {
    try {
      const parsed = JSON.parse(settingsJson().trim() || '{}') as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      return Object.keys(parsed).length === 0 ? null : (parsed as RequestParamDefaults);
    } catch {
      return undefined;
    }
  };

  const loadSchemaDefaults = async (
    ref: ParamSchemaRef,
    options: { applyJson?: boolean } = { applyJson: true },
  ): Promise<void> => {
    try {
      const specs = await getCatalogModelParamSpecs(
        props.agentName,
        ref.provider,
        ref.authType,
        ref.model,
      );
      const defaults = requestParamDefaultsFromSpecs(specs);
      setSettingsSchemaKeySignature(keySignature(defaults));
      if (options.applyJson !== false) {
        setSettingsJson(defaults ? JSON.stringify(defaults, null, 2) : '{}');
      }
      setSettingsError(null);
    } catch {
      toast.error(`Couldn't load defaults for ${ref.model}`);
    }
  };

  const handleSettingsSchemaSelect = (value: string): void => {
    setSettingsSchemaValue(value);
    setSettingsSchemaKeySignature(null);
    const [provider, authType, model] = value.split('\t');
    if (!provider || !authType || !model) return;
    void loadSchemaDefaults({ provider, authType: authType as AuthType, model });
  };

  const settingsJsonHasCustomKeys = () => {
    const current = parseSettingsJsonLenient();
    if (current === undefined) return false;
    const ref = selectedSettingsParamSchemaRef();
    if (!ref) return keySignature(current) !== '';
    const schemaSignature = settingsSchemaKeySignature();
    return schemaSignature !== null && keySignature(current) !== schemaSignature;
  };

  const selectedSchemaLabel = () => {
    if (settingsJsonHasCustomKeys()) return 'custom';
    const selected = settingsSchemaValue();
    return (
      paramSchemaOptions().find((item) => item.value === selected)?.label ??
      selectedSettingsParamSchemaRef()?.model ??
      null
    );
  };

  const loadParamSpecOptions = async () => {
    if (!connected() || paramSpecOptionsLoaded()) return;
    try {
      setParamSpecOptions(await listModelParamSpecIndex(props.agentName));
    } catch {
      setParamSpecOptions([]);
    } finally {
      setParamSpecOptionsLoaded(true);
    }
  };

  createEffect(() => {
    void (props.agentName, props.provId, props.selectedAuthType(), connected());
    void loadParamSpecOptions();
  });

  const formatProviderModelPrice = (perToken: number | null | undefined): string => {
    if (perToken == null) return '–';
    const perMillion = Number(perToken) * 1_000_000;
    if (perMillion === 0) return 'Free';
    if (perMillion < 0.01) return '< $0.01';
    if (perMillion < 1) return `$${perMillion.toFixed(3)}`;
    return `$${perMillion.toFixed(2)}`;
  };

  const handleRefreshModels = async () => {
    setRefreshing(true);
    try {
      const result = await refreshProviderModels(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
      );
      if (result.ok) {
        toast.success(
          `${provDef.name}: refreshed ${result.model_count} model${result.model_count === 1 ? '' : 's'}`,
        );
      } else {
        toast.error(result.error ?? `Couldn't refresh ${provDef.name}`);
      }
      await loadProviderModels();
      props.onUpdate();
    } catch {
      // network/server error toast already raised by fetchMutate
    } finally {
      setRefreshing(false);
    }
  };

  const parsePrice = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  const highlightedJson = createMemo(() => highlight(settingsJson() || ' ', 'json'));

  const parseSettingsJson = (): RequestParamDefaults | null => {
    const raw = settingsJson().trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parameter JSON must be an object.');
    }
    return Object.keys(parsed).length === 0 ? null : (parsed as RequestParamDefaults);
  };

  const parseSettingsCustomSchemaJson = (): ModelParamDefinition[] | null => {
    const raw = settingsCustomSchemaJson().trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Parameter schema must be an array.');
    }
    return parsed.length === 0 ? null : (parsed as ModelParamDefinition[]);
  };

  const scrollToBottomOfModels = () =>
    requestAnimationFrame(() => {
      if (modelsScrollRef) modelsScrollRef.scrollTop = modelsScrollRef.scrollHeight;
    });

  const handleAddManualModel = async () => {
    const name = manualName().trim();
    if (!name) return;
    const inputPrice = parsePrice(manualInputPrice());
    const outputPrice = parsePrice(manualOutputPrice());
    if (
      (manualInputPrice().trim() && inputPrice === null) ||
      (manualOutputPrice().trim() && outputPrice === null)
    ) {
      setManualModelError('Prices must be valid non-negative numbers.');
      return;
    }
    setManualModelError(null);
    setAddingModel(true);
    try {
      await addManualModel(props.agentName, props.provId, props.selectedAuthType(), {
        model_name: name,
        ...(inputPrice !== null ? { input_price_per_million_tokens: inputPrice } : {}),
        ...(outputPrice !== null ? { output_price_per_million_tokens: outputPrice } : {}),
      });
      toast.success(`Added ${name} to ${provDef.name}`);
      setManualName('');
      setManualInputPrice('');
      setManualOutputPrice('');
      setManualModelError(null);
      await loadProviderModels();
      props.onUpdate();
      scrollToBottomOfModels();
    } catch {
      // error toast from fetchMutate
    } finally {
      setAddingModel(false);
    }
  };

  const openManualModelSettings = (model: AvailableModel) => {
    setSettingsModel(model);
    setSettingsSchemaValue(model.param_schema_ref ? schemaValue(model.param_schema_ref) : '');
    setSettingsCustomSchemaJson(JSON.stringify(model.param_schema ?? [], null, 2));
    setSettingsSchemaKeySignature(null);
    setSettingsJson(JSON.stringify(model.param_defaults ?? {}, null, 2));
    setSettingsError(null);
    void loadParamSpecOptions();
    if (model.param_schema_ref) {
      void loadSchemaDefaults(model.param_schema_ref, { applyJson: false });
    }
  };

  const closeManualModelSettings = () => {
    if (settingsSaving()) return;
    setSettingsModel(null);
    setSettingsError(null);
  };

  const handleSaveManualModelSettings = async () => {
    const model = settingsModel();
    if (!model || settingsSaving()) return;
    setSettingsError(null);
    let paramDefaults: RequestParamDefaults | null;
    let paramSchema: ModelParamDefinition[] | null;
    try {
      paramDefaults = parseSettingsJson();
      paramSchema = parseSettingsCustomSchemaJson();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Invalid JSON.');
      return;
    }

    setSettingsSaving(true);
    try {
      await updateManualModelSettings(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
        model.model_name,
        {
          param_schema_ref: selectedSettingsParamSchemaRef(),
          param_schema: paramSchema,
          param_defaults: paramDefaults,
        },
      );
      toast.success(`Updated ${model.model_name} parameters`);
      await loadProviderModels();
      props.onUpdate();
      setSettingsModel(null);
    } catch {
      // error toast from fetchMutate
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleRemoveManualModel = async (modelId: string) => {
    try {
      await removeManualModel(props.agentName, props.provId, props.selectedAuthType(), modelId);
      await loadProviderModels();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    }
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await disconnectProvider(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
      );
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

  return (
    <div class="provider-detail">
      <ProviderSubviewHeader
        layout={props.layout}
        onBack={props.onBack}
        title="Connect providers"
      />

      {/* Provider row */}
      <div class="provider-detail__header provider-detail__header--split">
        <div class="provider-detail__identity">
          <span class="provider-detail__icon">
            {providerIcon(props.provId, 28) ?? (
              <span
                class="provider-card__logo-letter"
                style={{
                  background: provDef.color,
                  width: '32px',
                  height: '32px',
                  'font-size': '13px',
                }}
              >
                {provDef.initial}
              </span>
            )}
          </span>
          <div class="provider-detail__title-group">
            <div class="provider-detail__name">
              {provDef.name}
              <Show when={provDef.beta}>
                <span class="provider-detail__beta-badge">beta</span>
              </Show>
            </div>
            <Show when={isSubMode() && provDef.subscriptionRequirementNote}>
              <div class="provider-detail__subtitle">{provDef.subscriptionRequirementNote}</div>
            </Show>
          </div>
        </div>
        <div class="provider-detail__header-actions">
          <Show when={showAddKeyButton()}>
            <button
              type="button"
              class="btn btn--sm"
              style="background: hsl(var(--foreground)); color: hsl(var(--background)); border: none; font-size: var(--font-size-xs); display: inline-flex; align-items: center; gap: 4px;"
              onClick={() => setAddKeyOpen(true)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M4 11h11v2H4zm0-5h16v2H4zm0 10h8v2H4zm15-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" />
              </svg>
              {isSubMode() ? 'Add connection' : 'Add another key'}
            </button>
          </Show>
        </div>
      </div>

      <Show when={connected()}>
        <div class="provider-detail__models-bar">
          <span>
            {activeProviderRow()?.cached_model_count ?? 0} model
            {(activeProviderRow()?.cached_model_count ?? 0) === 1 ? '' : 's'}
            <Show when={lastFetchedAgo()}> – last refreshed: {lastFetchedAgo()}</Show>
          </span>
          <button
            class="btn btn--outline btn--sm provider-detail__refresh-btn"
            disabled={refreshing() || props.busy()}
            onClick={handleRefreshModels}
            aria-label={`Refresh models from ${provDef.name}`}
            title={`Refresh models from ${provDef.name}`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              classList={{ 'provider-detail__refresh-icon--spinning': refreshing() }}
            >
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            {refreshing() ? 'Refreshing…' : 'Refresh models'}
          </button>
        </div>
      </Show>

      <Show when={connected()}>
        <div class="provider-detail__section">
          <div class="provider-detail__label">Models</div>
          <Show
            when={providerModels()}
            fallback={<p class="provider-detail__hint">Loading models…</p>}
          >
            {(models) => (
              <>
                <div class="provider-detail__hint">
                  {models().length} fetched model{models().length === 1 ? '' : 's'}
                </div>
                <div class="provider-model-table" ref={modelsScrollRef}>
                  <div class="provider-model-table__head" aria-hidden="true">
                    <span>Model name</span>
                    <span>Input / 1M tokens</span>
                    <span>Output / 1M tokens</span>
                  </div>
                  <For each={models()}>
                    {(model) => (
                      <div class="provider-model-table__row">
                        <span class="provider-model-table__model">
                          <span class="provider-model-table__label">
                            {model.manual
                              ? model.model_name
                              : model.display_name || model.model_name}
                          </span>
                          <Show
                            when={
                              !model.manual &&
                              model.display_name &&
                              model.display_name !== model.model_name
                            }
                          >
                            <span class="provider-model-table__id">{model.model_name}</span>
                          </Show>
                          <Show when={model.manual}>
                            <span
                              class="provider-model-table__manual-badge"
                              title="You added this model; it isn’t returned by the provider’s /models endpoint"
                            >
                              Custom
                            </span>
                          </Show>
                          <Show when={model.manual}>
                            <button
                              type="button"
                              class="provider-model-table__settings-btn"
                              classList={{
                                'provider-model-table__settings-btn--configured':
                                  model.param_defaults !== null &&
                                  model.param_defaults !== undefined,
                              }}
                              aria-label={`Configure ${model.model_name} parameters`}
                              title={`Configure ${model.model_name} parameters`}
                              onClick={() => openManualModelSettings(model)}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <line x1="4" y1="21" x2="4" y2="14" />
                                <line x1="4" y1="10" x2="4" y2="3" />
                                <line x1="12" y1="21" x2="12" y2="12" />
                                <line x1="12" y1="8" x2="12" y2="3" />
                                <line x1="20" y1="21" x2="20" y2="16" />
                                <line x1="20" y1="12" x2="20" y2="3" />
                                <line x1="1" y1="14" x2="7" y2="14" />
                                <line x1="9" y1="8" x2="15" y2="8" />
                                <line x1="17" y1="16" x2="23" y2="16" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              class="provider-model-table__remove-btn"
                              aria-label={`Remove ${model.model_name} from ${provDef.name}`}
                              title={`Remove ${model.model_name} from ${provDef.name}`}
                              onClick={() => handleRemoveManualModel(model.model_name)}
                            >
                              ×
                            </button>
                          </Show>
                        </span>
                        <span class="provider-model-table__cell provider-model-table__cell--price">
                          <span class="provider-model-table__mobile-label">Input / 1M tokens</span>
                          <span class="provider-model-table__price">
                            {formatProviderModelPrice(model.input_price_per_token)}
                          </span>
                        </span>
                        <span class="provider-model-table__cell provider-model-table__cell--price">
                          <span class="provider-model-table__mobile-label">Output / 1M tokens</span>
                          <span class="provider-model-table__price">
                            {formatProviderModelPrice(model.output_price_per_token)}
                          </span>
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </Show>
          <div class="provider-model-add">
            <div class="custom-provider-model-row">
              <input
                class="provider-detail__input custom-provider-model-row__name"
                type="text"
                placeholder="Model name"
                aria-label="Manual model name"
                value={manualName()}
                onInput={(e) => {
                  setManualName(e.currentTarget.value);
                  setManualModelError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && manualName().trim()) {
                    e.preventDefault();
                    void handleAddManualModel();
                  }
                }}
              />
              <input
                class="provider-detail__input custom-provider-model-row__price"
                type="text"
                inputmode="decimal"
                placeholder="$/M in"
                aria-label="Input price per million tokens"
                value={manualInputPrice()}
                onInput={(e) => {
                  setManualInputPrice(e.currentTarget.value);
                  setManualModelError(null);
                }}
              />
              <input
                class="provider-detail__input custom-provider-model-row__price"
                type="text"
                inputmode="decimal"
                placeholder="$/M out"
                aria-label="Output price per million tokens"
                value={manualOutputPrice()}
                onInput={(e) => {
                  setManualOutputPrice(e.currentTarget.value);
                  setManualModelError(null);
                }}
              />
            </div>
            <Show when={manualModelError()}>
              {(message) => (
                <div class="provider-detail__error provider-model-add__error" role="alert">
                  {message()}
                </div>
              )}
            </Show>
            <button
              type="button"
              class="btn btn--outline btn--sm provider-model-add__btn"
              disabled={addingModel() || !manualName().trim()}
              onClick={handleAddManualModel}
            >
              {addingModel() ? <span class="spinner" /> : '+ Add model'}
            </button>
          </div>
        </div>
      </Show>

      <Show when={settingsModel()}>
        {(model) => (
          <div
            class="modal-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeManualModelSettings();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeManualModelSettings();
            }}
          >
            <div
              class="modal-card manual-model-settings"
              role="dialog"
              aria-modal="true"
              aria-labelledby="manual-model-settings-title"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 class="modal-card__title" id="manual-model-settings-title">
                Model parameters
              </h2>
              <p class="modal-card__desc">
                Configure raw request JSON for {model().model_name}. These defaults are merged into
                requests before provider-specific routing params.
              </p>

              <div class="manual-model-settings__section">
                <div class="manual-model-settings__section-head">
                  <label class="provider-detail__label">Parameter schema source</label>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm manual-model-settings__clear-schema"
                    onClick={() => {
                      setSettingsSchemaValue('');
                      setSettingsSchemaKeySignature(null);
                    }}
                    disabled={!settingsSchemaValue() || settingsSaving()}
                  >
                    No schema
                  </button>
                </div>
                <ModelSelectDropdown
                  selectedValue={settingsSchemaValue() || null}
                  selectedLabel={selectedSchemaLabel()}
                  items={paramSchemaOptions()}
                  loading={!paramSpecOptionsLoaded()}
                  placeholder="Search models..."
                  emptyLabel="No matching modelparams.dev schemas."
                  requireSearch
                  showSublabel={false}
                  compact
                  showGroupHeaders={false}
                  onSelect={handleSettingsSchemaSelect}
                />
              </div>

              <div class="manual-model-settings__section">
                <label class="provider-detail__label" for="manual-model-settings-schema-json">
                  Custom parameter schema
                </label>
                <p class="provider-detail__hint">
                  Optional array of modelparams.dev-style parameter definitions. Use this for extra
                  keys not covered by the selected schema source.
                </p>
                <textarea
                  id="manual-model-settings-schema-json"
                  class="manual-model-settings__textarea manual-model-settings__textarea--plain"
                  aria-label="Custom parameter schema JSON"
                  spellcheck={false}
                  value={settingsCustomSchemaJson()}
                  disabled={settingsSaving()}
                  onInput={(e) => {
                    setSettingsCustomSchemaJson(e.currentTarget.value);
                    setSettingsError(null);
                  }}
                />
              </div>

              <div class="manual-model-settings__section">
                <label class="provider-detail__label" for="manual-model-settings-json">
                  Custom JSON
                </label>
                <div class="manual-model-settings__json-editor">
                  <pre
                    ref={jsonHighlightRef}
                    class="manual-model-settings__highlight hljs"
                    aria-hidden="true"
                  >
                    <code innerHTML={highlightedJson()} />
                  </pre>
                  <textarea
                    id="manual-model-settings-json"
                    class="manual-model-settings__textarea"
                    aria-label="Custom parameter JSON"
                    spellcheck={false}
                    value={settingsJson()}
                    disabled={settingsSaving()}
                    onInput={(e) => {
                      setSettingsJson(e.currentTarget.value);
                      setSettingsError(null);
                    }}
                    onScroll={(e) => {
                      if (jsonHighlightRef) {
                        jsonHighlightRef.scrollTop = e.currentTarget.scrollTop;
                        jsonHighlightRef.scrollLeft = e.currentTarget.scrollLeft;
                      }
                    }}
                  />
                </div>
                <Show when={settingsError()}>
                  {(message) => (
                    <div class="provider-detail__error manual-model-settings__error" role="alert">
                      {message()}
                    </div>
                  )}
                </Show>
              </div>

              <div class="modal-card__footer manual-model-settings__footer">
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  onClick={closeManualModelSettings}
                  disabled={settingsSaving()}
                >
                  Cancel
                </button>
                <button
                  class="btn btn--primary btn--sm"
                  type="button"
                  onClick={handleSaveManualModelSettings}
                  disabled={settingsSaving()}
                >
                  {settingsSaving() ? <span class="spinner" /> : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Subscription sign-in URL instruction (token mode with external sign-in) */}
      <Show when={isSubMode() && provDef.subscriptionSignInUrl}>
        <p class="provider-detail__hint">
          {provDef.subscriptionSignInHint ??
            `Sign in to your ${provDef.name} account to get your API key, then paste it below.`}
        </p>
        <a
          class="btn btn--primary btn--sm provider-detail__signin-btn"
          href={provDef.subscriptionSignInUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${provDef.subscriptionSignInLabel ?? 'Sign in'} (opens in a new tab)`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          {provDef.subscriptionSignInLabel ?? 'Sign in'}
        </a>
      </Show>

      {/* Subscription terminal instruction */}
      <Show when={isSubMode() && provDef.subscriptionCommand}>
        <p class="provider-detail__hint">
          {isCommandOnly()
            ? 'Run the command below to log in via your browser.'
            : 'Run the command below, then paste the token.'}
        </p>
        <div class="modal-terminal">
          <div class="modal-terminal__header">
            <div class="modal-terminal__dots">
              <span class="modal-terminal__dot modal-terminal__dot--red" />
              <span class="modal-terminal__dot modal-terminal__dot--yellow" />
              <span class="modal-terminal__dot modal-terminal__dot--green" />
            </div>
            <div class="modal-terminal__tabs">
              <span class="modal-terminal__tab modal-terminal__tab--active">Terminal</span>
            </div>
          </div>
          <div class="modal-terminal__body">
            <CopyButton text={provDef.subscriptionCommand!} />
            <div>
              <span class="modal-terminal__prompt">$</span>
              <span class="modal-terminal__code">{provDef.subscriptionCommand}</span>
            </div>
          </div>
        </div>
      </Show>

      {/* Command-only subscription */}
      <Show when={isCommandOnly()}>
        <p class="provider-detail__hint" style="margin-top: 16px;">
          A browser window will open for you to log in. Once authenticated, the connection will be
          detected automatically.
        </p>
        <Show when={connected()}>
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
        <Show when={!connected()}>
          <button class="btn btn--primary provider-detail__action" onClick={props.onBack}>
            Done
          </button>
        </Show>
      </Show>

      {/* OAuth subscription */}
      <Show when={isPopupOAuthFlow()}>
        <OAuthDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onPollProviders={props.onPollProviders}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Paste-code OAuth subscription (Anthropic) */}
      <Show when={isPopupPasteFlow()}>
        <AnthropicOAuthDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Device-code subscription */}
      <Show when={isDeviceCodeFlow()}>
        <DeviceCodeDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Ollama (no key) */}
      <Show when={isOllama}>
        <div class="provider-detail__field">
          <span class="provider-detail__no-key">No API key required for local models</span>
          <Show when={getRoutingProviderApiKeyUrl(props.provId)}>
            <a
              href={getRoutingProviderApiKeyUrl(props.provId)}
              target="_blank"
              rel="noopener noreferrer"
              class="provider-detail__docs-link"
              style="margin-left: 8px; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground));"
            >
              Get {provDef.name} ↗
            </a>
          </Show>
        </div>
        <Show when={!connected()}>
          <button
            class="btn btn--primary provider-detail__action"
            disabled={props.busy()}
            onClick={handleOllamaConnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Connect
            </Show>
          </button>
        </Show>
        <Show when={connected()}>
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

      {/* API key / subscription token form (non-Ollama, non-command-only, non-OAuth) */}
      <Show
        when={
          !isOllama &&
          !isCommandOnly() &&
          !isPopupOAuthFlow() &&
          !isPopupPasteFlow() &&
          !isDeviceCodeFlow()
        }
      >
        <ProviderKeyForm
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          isSubMode={isSubMode}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          keyInput={props.keyInput}
          setKeyInput={props.setKeyInput}
          editing={props.editing}
          setEditing={props.setEditing}
          validationError={props.validationError}
          setValidationError={props.setValidationError}
          getKeyPrefixDisplay={getKeyPrefixDisplay}
          providers={props.providers}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
        />
      </Show>
    </div>
  );
};

export default ProviderDetailView;
