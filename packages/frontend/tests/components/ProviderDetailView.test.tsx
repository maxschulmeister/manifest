import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal, type Accessor, type Setter } from 'solid-js';

type AuthType = 'api_key' | 'subscription' | 'local';

interface RoutingProvider {
  id: string;
  provider: string;
  auth_type: AuthType;
  is_active: boolean;
  has_api_key: boolean;
  connected_at: string;
  models_fetched_at?: string | null;
  cached_model_count?: number;
}

interface AvailableModel {
  model_name: string;
  display_name?: string;
  provider: string;
  auth_type?: AuthType;
  context_window: number;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  capability_reasoning: boolean;
  capability_code: boolean;
  quality_score: number;
  manual?: boolean;
  param_schema_ref?: { provider: string; authType: AuthType; model: string } | null;
  param_defaults?: Record<string, unknown> | null;
}

const mockConnectProvider = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockRefreshProviderModels = vi.fn();
const mockGetProviderModels = vi.fn();
const mockAddManualModel = vi.fn();
const mockUpdateManualModelSettings = vi.fn();
const mockRemoveManualModel = vi.fn();
const mockListModelParamSpecIndex = vi.fn();
const mockGetCatalogModelParamSpecs = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  connectProvider: (...args: unknown[]) => mockConnectProvider(...args),
  disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
  refreshProviderModels: (...args: unknown[]) => mockRefreshProviderModels(...args),
  getProviderModels: (...args: unknown[]) => mockGetProviderModels(...args),
  addManualModel: (...args: unknown[]) => mockAddManualModel(...args),
  updateManualModelSettings: (...args: unknown[]) => mockUpdateManualModelSettings(...args),
  removeManualModel: (...args: unknown[]) => mockRemoveManualModel(...args),
}));

vi.mock('../../src/services/api/model-params.js', () => ({
  listModelParamSpecIndex: (...args: unknown[]) => mockListModelParamSpecIndex(...args),
  getCatalogModelParamSpecs: (...args: unknown[]) => mockGetCatalogModelParamSpecs(...args),
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatTimeAgo: (ts: string | null | undefined) => (ts ? '5m ago' : null),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/CopyButton.js', () => ({
  default: (props: { text: string }) => <span data-testid="copy-btn">{props.text}</span>,
}));

vi.mock('../../src/components/ProviderKeyForm.js', () => ({
  default: () => <div data-testid="provider-key-form" />,
  MAX_KEYS_PER_PROVIDER: 5,
}));

vi.mock('../../src/components/OAuthDetailView.js', () => ({
  default: () => <div data-testid="oauth-detail" />,
}));

vi.mock('../../src/components/AnthropicOAuthDetailView.js', () => ({
  default: () => <div data-testid="anthropic-oauth-detail" />,
}));

vi.mock('../../src/components/DeviceCodeDetailView.js', () => ({
  default: () => <div data-testid="device-code-detail" />,
}));

import { toast } from '../../src/services/toast-store.js';
import ProviderDetailView from '../../src/components/ProviderDetailView.jsx';

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'anthropic', name: 'Anthropic', initial: 'A', color: '#d97757' },
    { id: 'openai', name: 'OpenAI', initial: 'O', color: '#10a37f' },
  ],
}));

function createTestProps(overrides: {
  provId?: string;
  providers?: RoutingProvider[];
  selectedAuthType?: AuthType;
  busy?: boolean;
} = {}) {
  const [busy, setBusy] = createSignal(overrides.busy ?? false);
  const [keyInput, setKeyInput] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [selectedAuthType, setSelectedAuthType] = createSignal<AuthType>(
    overrides.selectedAuthType ?? 'api_key',
  );

  return {
    provId: overrides.provId ?? 'ollama',
    agentName: 'test-agent',
    providers: overrides.providers ?? [],
    selectedAuthType: selectedAuthType as Accessor<AuthType>,
    busy,
    setBusy: setBusy as Setter<boolean>,
    keyInput,
    setKeyInput: setKeyInput as Setter<string>,
    editing,
    setEditing: setEditing as Setter<boolean>,
    validationError,
    setValidationError: setValidationError as Setter<string | null>,
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('ProviderDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectProvider.mockResolvedValue({});
    mockDisconnectProvider.mockResolvedValue({ notifications: [] });
    mockRefreshProviderModels.mockResolvedValue({
      ok: true,
      model_count: 3,
      last_fetched_at: '2026-04-12T10:00:00Z',
      error: null,
    });
    mockGetProviderModels.mockResolvedValue([]);
    mockAddManualModel.mockResolvedValue({ model_name: 'claude-secret' });
    mockUpdateManualModelSettings.mockResolvedValue({ model_name: 'claude-secret' });
    mockRemoveManualModel.mockResolvedValue({ ok: true });
    mockListModelParamSpecIndex.mockResolvedValue([]);
    mockGetCatalogModelParamSpecs.mockResolvedValue([]);
  });

  describe('manual models', () => {
    const connectedAnthropic: RoutingProvider[] = [
      {
        id: 'p1',
        provider: 'anthropic',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
        models_fetched_at: '2026-04-12T09:55:00Z',
        cached_model_count: 2,
      },
    ];

    it('hides the add-model row when the provider is not connected', () => {
      const props = createTestProps({ provId: 'anthropic', providers: [] });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.queryByPlaceholderText('Model name')).toBeNull();
    });

    it('shows the add-model row with name + input/output price inputs when connected', () => {
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByPlaceholderText('Model name')).toBeDefined();
      expect(screen.getByPlaceholderText('$/M in')).toBeDefined();
      expect(screen.getByPlaceholderText('$/M out')).toBeDefined();
      expect(screen.getByText('+ Add model')).toBeDefined();
    });

    it('adds a manual model with only name and prices from the add row', async () => {
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.input(screen.getByPlaceholderText('Model name'), {
        target: { value: 'claude-secret' },
      });
      fireEvent.input(screen.getByPlaceholderText('$/M in'), {
        target: { value: '3' },
      });
      fireEvent.input(screen.getByPlaceholderText('$/M out'), {
        target: { value: '15' },
      });
      fireEvent.click(screen.getByText('+ Add model'));

      await waitFor(() => {
        expect(mockAddManualModel).toHaveBeenCalledWith('test-agent', 'anthropic', 'api_key', {
          model_name: 'claude-secret',
          input_price_per_million_tokens: 3,
          output_price_per_million_tokens: 15,
        });
        expect(toast.success).toHaveBeenCalledWith('Added claude-secret to Anthropic');
      });
      expect(screen.queryByLabelText('Parameter schema source')).toBeNull();
      expect((screen.getByPlaceholderText('Model name') as HTMLInputElement).value).toBe('');
    });

    it('submits on Enter from the model name field', async () => {
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.input(screen.getByPlaceholderText('Model name'), {
        target: { value: 'claude-secret' },
      });
      fireEvent.keyDown(screen.getByPlaceholderText('Model name'), { key: 'Enter' });

      await waitFor(() => {
        expect(mockAddManualModel).toHaveBeenCalled();
      });
    });

    it('the Add button is disabled when the name is empty', () => {
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByText('+ Add model')).toHaveProperty('disabled', true);
    });

    it('shows an inline error instead of submitting invalid prices', async () => {
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.input(screen.getByPlaceholderText('Model name'), {
        target: { value: 'claude-secret' },
      });
      fireEvent.input(screen.getByPlaceholderText('$/M in'), {
        target: { value: 'not-a-price' },
      });
      fireEvent.click(screen.getByText('+ Add model'));

      expect(screen.getByRole('alert').textContent).toBe('Prices must be valid non-negative numbers.');
      expect(mockAddManualModel).not.toHaveBeenCalled();
    });

    it('shows manual models as the exact model string and removes them on click', async () => {
      mockGetProviderModels.mockResolvedValue([
        {
          model_name: 'claude-opus',
          display_name: 'Claude Opus',
          provider: 'anthropic',
          auth_type: 'api_key',
          context_window: 200000,
          input_price_per_token: null,
          output_price_per_token: null,
          capability_reasoning: false,
          capability_code: false,
          quality_score: 3,
        },
        {
          model_name: 'claude-secret',
          display_name: 'Claude Secret',
          provider: 'anthropic',
          auth_type: 'api_key',
          context_window: 128000,
          input_price_per_token: null,
          output_price_per_token: null,
          capability_reasoning: false,
          capability_code: false,
          quality_score: 3,
          manual: true,
          param_schema_ref: { provider: 'anthropic', authType: 'api_key', model: 'claude-opus' },
          param_defaults: { temperature: 0.2 },
        },
      ]);
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      await waitFor(() => {
        expect(screen.getByText('claude-secret')).toBeDefined();
      });
      expect(screen.getAllByText('claude-secret')).toHaveLength(1);
      expect(screen.queryByText('Claude Secret')).toBeNull();
      expect(screen.getByText('Custom')).toBeDefined();
      expect(screen.getByLabelText('Configure claude-secret parameters')).toBeDefined();
      expect(screen.queryByText('Params: claude-opus')).toBeNull();

      fireEvent.click(screen.getByLabelText('Remove claude-secret from Anthropic'));

      await waitFor(() => {
        expect(mockRemoveManualModel).toHaveBeenCalledWith(
          'test-agent',
          'anthropic',
          'api_key',
          'claude-secret',
        );
      });
    });

    it('opens settings for a manual model and saves schema source plus custom JSON', async () => {
      mockListModelParamSpecIndex.mockResolvedValue([
        { provider: 'anthropic', authType: 'api_key', model: 'claude-opus' },
        { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
      ]);
      mockGetCatalogModelParamSpecs.mockResolvedValue([
        {
          provider: 'zai',
          authType: 'api_key',
          model: 'glm-5.1',
          path: 'temperature',
          type: 'number',
          label: 'Temperature',
          description: 'Sampling temperature',
          default: 0.7,
          group: 'sampling',
        },
        {
          provider: 'zai',
          authType: 'api_key',
          model: 'glm-5.1',
          path: 'top_p',
          type: 'number',
          label: 'Top P',
          description: 'Nucleus sampling',
          default: 0.95,
          group: 'sampling',
        },
      ]);
      mockGetProviderModels.mockResolvedValue([
        {
          model_name: 'glm-5.2',
          display_name: 'GLM 5.2',
          provider: 'zai',
          auth_type: 'api_key',
          context_window: 128000,
          input_price_per_token: null,
          output_price_per_token: null,
          capability_reasoning: false,
          capability_code: false,
          quality_score: 3,
          manual: true,
          param_defaults: { temperature: 0.2 },
        },
      ]);
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Configure glm-5.2 parameters')).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText('Configure glm-5.2 parameters'));

      await waitFor(() => {
        expect(screen.getByText('custom')).toBeDefined();
      });
      expect(screen.queryByText('Start typing to search modelparams.dev.')).toBeNull();
      fireEvent.click(screen.getByLabelText('Change model selection'));
      const textarea = screen.getByLabelText('Custom parameter JSON') as HTMLTextAreaElement;
      expect(textarea.value).toContain('temperature');
      fireEvent.input(screen.getByPlaceholderText('Search models...'), {
        target: { value: 'glm 5' },
      });
      fireEvent.click(screen.getByText('glm-5.1'));
      await waitFor(() => {
        expect(mockGetCatalogModelParamSpecs).toHaveBeenCalledWith(
          'test-agent',
          'zai',
          'api_key',
          'glm-5.1',
        );
        expect(textarea.value).toContain('"temperature": 0.7');
        expect(textarea.value).toContain('"top_p": 0.95');
      });
      fireEvent.input(textarea, {
        target: { value: '{\n  "temperature": 0.4,\n  "vendor": { "reasoning": true }\n}' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(mockUpdateManualModelSettings).toHaveBeenCalledWith(
          'test-agent',
          'anthropic',
          'api_key',
          'glm-5.2',
          {
            param_schema_ref: { provider: 'zai', authType: 'api_key', model: 'glm-5.1' },
            param_defaults: { temperature: 0.4, vendor: { reasoning: true } },
          },
        );
      });
    });

    it('keeps the settings dialog open when custom JSON is invalid', async () => {
      mockGetProviderModels.mockResolvedValue([
        {
          model_name: 'glm-5.2',
          provider: 'anthropic',
          auth_type: 'api_key',
          context_window: 128000,
          input_price_per_token: null,
          output_price_per_token: null,
          capability_reasoning: false,
          capability_code: false,
          quality_score: 3,
          manual: true,
        },
      ]);
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Configure glm-5.2 parameters')).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText('Configure glm-5.2 parameters'));
      fireEvent.input(screen.getByLabelText('Custom parameter JSON'), {
        target: { value: '{ nope' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });
      expect(mockUpdateManualModelSettings).not.toHaveBeenCalled();
    });

    it('swallows add errors without throwing', async () => {
      mockAddManualModel.mockRejectedValueOnce(new Error('boom'));
      const props = createTestProps({ provId: 'anthropic', providers: connectedAnthropic });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.input(screen.getByPlaceholderText('Model name'), {
        target: { value: 'claude-secret' },
      });
      fireEvent.click(screen.getByText('+ Add model'));

      await waitFor(() => {
        expect(mockAddManualModel).toHaveBeenCalled();
      });
    });
  });
});
