import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { SDKAgent } from '@cursor/sdk';
import { ForwardResult } from '../routing/proxy/provider-client';
import type { ForwardOptions } from '../routing/proxy/proxy-types';
import {
  acquireSessionCursorAgent,
  disposeAllSessionCursorAgents,
  resetSessionCursorAgent,
} from './adapted/cursor-session-agent';
import { planCursorSessionSend } from './adapted/cursor-session-send-policy';
import {
  MISSING_CURSOR_API_KEY_MESSAGE,
  cursorProviderErrorResponse,
  sanitizeCursorProviderError,
} from './adapted/cursor-provider-errors';
import {
  buildBootstrapCursorPrompt,
  buildIncrementalCursorPrompt,
  computeManifestContextFingerprint,
  cursorPromptToSdkUserMessage,
  openAiMessagesToContext,
} from './cursor-message-converter';
import { parseCursorManifestModel } from './cursor-param-mapper';
import {
  buildOpenAiChatCompletion,
  buildOpenAiSseStream,
  estimateUsage,
  extractAssistantTextFromSdkMessage,
  openAiJsonResponse,
  openAiSseResponse,
} from './cursor-openai-stream';
import { buildCursorSessionPoolKey, resolveCursorConversationId } from './cursor-session-pool';
import { getManifestCursorSettingSources } from './cursor-setting-sources';

export interface CursorForwardOptions extends ForwardOptions {
  agentId: string;
  sessionKey: string;
}

@Injectable()
export class CursorProxyService implements OnModuleDestroy {
  private readonly logger = new Logger(CursorProxyService.name);

  async onModuleDestroy(): Promise<void> {
    await disposeAllSessionCursorAgents();
  }

  async forward(opts: CursorForwardOptions): Promise<ForwardResult> {
    const apiKey = opts.apiKey?.trim();
    if (!apiKey) {
      return {
        response: cursorProviderErrorResponse(MISSING_CURSOR_API_KEY_MESSAGE, 401),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }

    try {
      const conversationId = resolveCursorConversationId(opts.sessionKey, opts.extraHeaders);
      const scopeKey = buildCursorSessionPoolKey(opts.agentId, apiKey, conversationId);
      const context = openAiMessagesToContext(opts.body);
      const { selection, manifestModelId } = parseCursorManifestModel(opts.model);
      const cwd = process.env.CURSOR_SDK_CWD ?? process.cwd();

      const lease = await acquireSessionCursorAgent(scopeKey, {
        apiKey,
        cwd,
        modelSelection: selection,
        agentMode: 'agent',
      });

      const plan = planCursorSessionSend(lease.sendState, context);
      if (plan.resetAgent) {
        await resetSessionCursorAgent(scopeKey);
        const freshLease = await acquireSessionCursorAgent(scopeKey, {
          apiKey,
          cwd,
          modelSelection: selection,
          agentMode: 'agent',
        });
        return await this.executeRun(freshLease, plan, context, opts, manifestModelId, apiKey);
      }

      return await this.executeRun(lease, plan, context, opts, manifestModelId, apiKey);
    } catch (error) {
      const message = sanitizeCursorProviderError(error, opts.apiKey);
      this.logger.warn(`Cursor SDK forward failed: ${message}`);
      return {
        response: cursorProviderErrorResponse(message),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  private async executeRun(
    lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    plan: ReturnType<typeof planCursorSessionSend>,
    context: ReturnType<typeof openAiMessagesToContext>,
    opts: CursorForwardOptions,
    manifestModelId: string,
    apiKey: string,
  ): Promise<ForwardResult> {
    const prompt =
      plan.mode === 'bootstrap'
        ? buildBootstrapCursorPrompt(context)
        : buildIncrementalCursorPrompt(context);
    const sdkMessage = cursorPromptToSdkUserMessage(prompt);
    const fingerprint = computeManifestContextFingerprint(context);

    const run = await lease.agent.send(sdkMessage, {
      model: parseCursorManifestModel(opts.model).selection,
    });
    lease.trackRunCompletion(run.wait());

    if (opts.stream) {
      return this.forwardStreaming(
        run,
        lease,
        plan,
        fingerprint,
        manifestModelId,
        prompt.text,
        opts.signal,
      );
    }

    const completionText = await this.collectRunText(run, opts.signal);
    lease.commitSend(fingerprint, plan.mode === 'bootstrap');

    const usage = estimateUsage(prompt.text, completionText);
    const body = buildOpenAiChatCompletion(manifestModelId, completionText, usage);
    return {
      response: openAiJsonResponse(body),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }

  private async forwardStreaming(
    run: Awaited<ReturnType<SDKAgent['send']>>,
    lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    plan: ReturnType<typeof planCursorSessionSend>,
    fingerprint: string,
    manifestModelId: string,
    promptText: string,
    signal?: AbortSignal,
  ): Promise<ForwardResult> {
    let completionText = '';
    for await (const event of run.stream()) {
      if (signal?.aborted) {
        await run.cancel().catch(() => undefined);
        throw new Error('Request aborted');
      }
      const delta = extractAssistantTextFromSdkMessage(event);
      if (delta) completionText += delta;
    }
    await run.wait();
    lease.commitSend(fingerprint, plan.mode === 'bootstrap');

    const usage = estimateUsage(promptText, completionText);
    const stream = buildOpenAiSseStream(manifestModelId, completionText, usage);
    return {
      response: openAiSseResponse(stream),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }

  private async collectRunText(
    run: Awaited<ReturnType<SDKAgent['send']>>,
    signal?: AbortSignal,
  ): Promise<string> {
    let text = '';
    for await (const event of run.stream()) {
      if (signal?.aborted) {
        await run.cancel().catch(() => undefined);
        throw new Error('Request aborted');
      }
      text += extractAssistantTextFromSdkMessage(event);
    }
    const result = await run.wait();
    if (result.status === 'error') {
      throw new Error(result.result ?? 'Cursor SDK run failed');
    }
    if (!text && result.result) text = result.result;
    return text;
  }
}

export const __testUtils = {
  getManifestCursorSettingSources,
};
