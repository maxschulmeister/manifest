import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { InteractionUpdate, SDKAgent, SDKMessage } from '@cursor/sdk';
import { ForwardResult } from '../routing/proxy/provider-client';
import type { ForwardOptions } from '../routing/proxy/proxy-types';
import { installCursorMcpToolTimeoutOverride } from './adapted/cursor-mcp-timeout-override';
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
import { hasTrailingUserMessagesAfterToolResults } from './adapted/cursor-provider-live-run-drain';
import {
  ManifestCursorLiveRunAbortError,
  attachManifestCursorLiveSdkRun,
  collectManifestBridgeToolBatch,
  consumeOpenAiToolResultsForLiveRun,
  getManifestCursorLiveRunForScope,
  isManifestLiveRunReady,
  markManifestLiveRunCancelled,
  markManifestLiveRunError,
  markManifestLiveRunFinished,
  peekManifestLiveEvent,
  queueManifestLiveEvent,
  releaseAllManifestCursorLiveRunsForTests,
  releaseManifestCursorLiveRun,
  shiftManifestLiveEvent,
  startManifestCursorLiveRun,
  waitForBridgeToolOrLiveRunDone,
  waitForManifestLiveRunProgress,
  type ManifestCursorLiveSdkRun,
} from './adapted/manifest-cursor-live-run';
import type { ManifestBridgeToolRequest } from './adapted/manifest-tool-bridge-types';
import { getManifestToolBridgeRegistry } from './adapted/manifest-tool-bridge-server';
import {
  buildManifestToolBridgeSnapshotFromOpenAiTools,
  buildManifestToolBridgeSurfaceSignature,
} from './adapted/manifest-tool-bridge-snapshot';
import {
  buildBootstrapCursorPrompt,
  buildIncrementalCursorPrompt,
  computeManifestBootstrapContextFingerprint,
  cursorPromptToSdkUserMessage,
  openAiMessagesToContext,
} from './cursor-message-converter';
import {
  buildCursorModelSelection,
  extractCursorRouteParams,
  parseCursorManifestModel,
  resolveCursorAgentMode,
  stripCursorRouteParams,
} from './cursor-param-mapper';
import {
  buildOpenAiChatCompletion,
  buildOpenAiSseStream,
  computeAssistantStreamDelta,
  estimateUsage,
  extractAssistantTextFromSdkMessage,
  manifestBridgeRequestsToOpenAiToolCalls,
  openAiJsonResponse,
  openAiSseResponse,
} from './cursor-openai-stream';
import { buildCursorSessionPoolKey, resolveCursorConversationId } from './cursor-session-pool';
import { getManifestCursorSettingSources } from './cursor-setting-sources';

export interface CursorForwardOptions extends ForwardOptions {
  agentId: string;
  sessionKey: string;
}

interface RunTextResult {
  text: string;
  bridgeRequests: ManifestBridgeToolRequest[];
}

@Injectable()
export class CursorProxyService implements OnModuleDestroy {
  private readonly logger = new Logger(CursorProxyService.name);
  private mcpTimeoutInstalled = false;

  async onModuleDestroy(): Promise<void> {
    await releaseAllManifestCursorLiveRunsForTests();
    await disposeAllSessionCursorAgents();
    await getManifestToolBridgeRegistry().disposeAll();
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
      if (!this.mcpTimeoutInstalled) {
        installCursorMcpToolTimeoutOverride();
        this.mcpTimeoutInstalled = true;
      }

      const conversationId = resolveCursorConversationId(opts.sessionKey, opts.extraHeaders);
      const scopeKey = buildCursorSessionPoolKey(opts.agentId, apiKey, conversationId);
      const routeParams = extractCursorRouteParams(opts.body);
      const agentMode = resolveCursorAgentMode(routeParams);
      const strippedBody = stripCursorRouteParams(opts.body);
      const context = openAiMessagesToContext(strippedBody);
      const { manifestModelId } = parseCursorManifestModel(opts.model);
      const selection = buildCursorModelSelection(manifestModelId, routeParams);
      const cwd = process.env.CURSOR_SDK_CWD ?? process.cwd();

      const bridgeSnapshot = buildManifestToolBridgeSnapshotFromOpenAiTools(strippedBody.tools);
      const bridgeSurfaceSignature = buildManifestToolBridgeSurfaceSignature(bridgeSnapshot);
      const bridgeEnabled = bridgeSnapshot.tools.length > 0;

      const resumeOutcome = await this.tryResumePendingLiveRun(
        scopeKey,
        context.messages,
        opts,
        manifestModelId,
      );
      if (resumeOutcome) return resumeOutcome;

      const bridgeRun = bridgeEnabled
        ? await getManifestToolBridgeRegistry().createRun({ snapshot: bridgeSnapshot })
        : undefined;

      let liveRunForBridgeQueue: ReturnType<typeof startManifestCursorLiveRun> | undefined;
      const queuedBridgeBeforeLiveRun: ManifestBridgeToolRequest[] = [];

      const lease = await acquireSessionCursorAgent(scopeKey, {
        apiKey,
        cwd,
        modelSelection: selection,
        agentMode,
        bridgeSurfaceSignature,
        bridgeRun,
        onBridgeToolRequest: (request) => {
          if (liveRunForBridgeQueue && !liveRunForBridgeQueue.disposed) {
            queueManifestLiveEvent(liveRunForBridgeQueue, { type: 'bridge-tool', request });
          } else {
            queuedBridgeBeforeLiveRun.push(request);
          }
        },
      });

      const plan = planCursorSessionSend(lease.sendState, context);
      if (plan.resetAgent) {
        await resetSessionCursorAgent(scopeKey);
        await bridgeRun?.dispose();
        const freshBridgeRun = bridgeEnabled
          ? await getManifestToolBridgeRegistry().createRun({ snapshot: bridgeSnapshot })
          : undefined;
        const freshLease = await acquireSessionCursorAgent(scopeKey, {
          apiKey,
          cwd,
          modelSelection: selection,
          agentMode,
          bridgeSurfaceSignature,
          bridgeRun: freshBridgeRun,
          onBridgeToolRequest: (request) => {
            if (liveRunForBridgeQueue && !liveRunForBridgeQueue.disposed) {
              queueManifestLiveEvent(liveRunForBridgeQueue, { type: 'bridge-tool', request });
            } else {
              queuedBridgeBeforeLiveRun.push(request);
            }
          },
        });
        return await this.executeRun(
          freshLease,
          plan,
          context,
          opts,
          manifestModelId,
          apiKey,
          scopeKey,
          bridgeSnapshot,
          bridgeEnabled,
          queuedBridgeBeforeLiveRun,
          (run) => {
            liveRunForBridgeQueue = run;
          },
        );
      }

      return await this.executeRun(
        lease,
        plan,
        context,
        opts,
        manifestModelId,
        apiKey,
        scopeKey,
        bridgeSnapshot,
        bridgeEnabled,
        queuedBridgeBeforeLiveRun,
        (run) => {
          liveRunForBridgeQueue = run;
        },
      );
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

  private async tryResumePendingLiveRun(
    scopeKey: string,
    messages: ReturnType<typeof openAiMessagesToContext>['messages'],
    opts: CursorForwardOptions,
    manifestModelId: string,
  ): Promise<ForwardResult | undefined> {
    const liveRun = getManifestCursorLiveRunForScope(scopeKey);
    if (!liveRun || liveRun.disposed || !liveRun.bridgeRun) return undefined;

    const toolResults = consumeOpenAiToolResultsForLiveRun(liveRun, messages);
    if (toolResults.length === 0) return undefined;

    liveRun.bridgeRun.resolveToolResults(toolResults);

    if (opts.stream) {
      return this.streamLiveRunUntilDone(liveRun, opts, manifestModelId, '', liveRun.sdkRun);
    }

    const result = await this.collectLiveRunUntilDone(liveRun, opts.signal);
    return this.buildForwardResult(
      manifestModelId,
      result.text,
      result.bridgeRequests,
      opts.stream,
      '',
    );
  }

  private async executeRun(
    lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    plan: ReturnType<typeof planCursorSessionSend>,
    context: ReturnType<typeof openAiMessagesToContext>,
    opts: CursorForwardOptions,
    manifestModelId: string,
    apiKey: string,
    scopeKey: string,
    bridgeSnapshot: ReturnType<typeof buildManifestToolBridgeSnapshotFromOpenAiTools>,
    bridgeEnabled: boolean,
    queuedBridgeBeforeLiveRun: ManifestBridgeToolRequest[],
    assignLiveRun: (run: ReturnType<typeof startManifestCursorLiveRun>) => void,
  ): Promise<ForwardResult> {
    const prompt =
      plan.mode === 'bootstrap'
        ? buildBootstrapCursorPrompt(context, {
            bridgeSnapshot,
            bridgeEnabled,
          })
        : buildIncrementalCursorPrompt(context);
    const sdkMessage = cursorPromptToSdkUserMessage(prompt);
    const fingerprint = computeManifestBootstrapContextFingerprint(context);

    const liveRun = startManifestCursorLiveRun({
      id: lease.bridgeRun?.id ?? `manifest-live-${scopeKey}`,
      scopeKey,
      agent: lease.agent,
      bridgeRun: lease.bridgeRun,
    });
    assignLiveRun(liveRun);
    lease.bridgeRun?.setOnToolRequest((request) => {
      queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request });
    });
    for (const request of queuedBridgeBeforeLiveRun.splice(0)) {
      queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request });
    }

    if (opts.signal?.aborted) {
      throw new Error('Request aborted');
    }

    const pendingBridge = collectManifestBridgeToolBatch(liveRun);
    if (pendingBridge.length > 0) {
      return this.buildForwardResult(
        manifestModelId,
        '',
        pendingBridge,
        opts.stream,
        prompt.text,
        lease,
        fingerprint,
        plan.mode === 'bootstrap',
      );
    }

    const routeParams = extractCursorRouteParams(opts.body);
    const agentMode = resolveCursorAgentMode(routeParams);
    const selection = buildCursorModelSelection(manifestModelId, routeParams);

    const run = await lease.agent.send(sdkMessage, {
      model: selection,
      mode: agentMode,
      onDelta: (args) => this.handleSdkDelta(liveRun, args.update),
    });
    attachManifestCursorLiveSdkRun(liveRun, run);
    lease.trackRunCompletion(
      this.finalizeLiveRunInBackground(liveRun, run, lease, fingerprint, plan.mode === 'bootstrap'),
    );

    if (opts.stream) {
      return this.streamLiveRunUntilDone(liveRun, opts, manifestModelId, prompt.text, run);
    }

    const result = await this.collectSdkRunWithBridge(liveRun, run, opts.signal);
    const bridgeBatch = collectManifestBridgeToolBatch(liveRun);
    const allBridge = [...result.bridgeRequests, ...bridgeBatch];
    if (allBridge.length > 0) {
      return this.buildForwardResult(
        manifestModelId,
        result.text,
        allBridge,
        false,
        prompt.text,
        lease,
        fingerprint,
        plan.mode === 'bootstrap',
      );
    }

    lease.commitSend(fingerprint, plan.mode === 'bootstrap');
    await releaseManifestCursorLiveRun(liveRun);
    const usage = estimateUsage(prompt.text, result.text);
    const body = buildOpenAiChatCompletion(manifestModelId, result.text, usage);
    return {
      response: openAiJsonResponse(body),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }

  private handleSdkDelta(
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    update: InteractionUpdate,
  ): void {
    if (update.type === 'text-delta') {
      liveRun.textDeltas.push(update.text);
      queueManifestLiveEvent(liveRun, { type: 'text-delta', text: update.text });
    }
  }

  private async collectSdkRunWithBridge(
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    run: Awaited<ReturnType<SDKAgent['send']>>,
    signal?: AbortSignal,
  ): Promise<RunTextResult> {
    let text = '';
    let streamedAssistantSnapshot = '';
    const bridgeRequests: ManifestBridgeToolRequest[] = [];
    const iterator = run.stream()[Symbol.asyncIterator]();
    let pendingStream = iterator.next();

    collectLoop: while (true) {
      if (signal?.aborted) {
        await run.cancel().catch(() => undefined);
        throw new Error('Request aborted');
      }

      const bridgeBatch = collectManifestBridgeToolBatch(liveRun);
      if (bridgeBatch.length > 0) {
        bridgeRequests.push(...bridgeBatch);
        break collectLoop;
      }

      let raced: { kind: 'stream'; value: IteratorResult<unknown> } | { kind: 'tick' };
      try {
        raced = await Promise.race([
          pendingStream.then((value) => ({ kind: 'stream' as const, value })),
          waitForBridgeToolOrLiveRunDone(liveRun, signal).then(() => ({ kind: 'tick' as const })),
        ]);
      } catch (error) {
        if (error instanceof ManifestCursorLiveRunAbortError || signal?.aborted) {
          await run.cancel().catch(() => undefined);
          throw new Error('Request aborted');
        }
        throw error;
      }

      if (raced.kind === 'tick') continue;

      if (raced.value.done) break collectLoop;

      pendingStream = iterator.next();
      const extracted = extractAssistantTextFromSdkMessage(raced.value.value as SDKMessage);
      const { delta, nextFullText } = computeAssistantStreamDelta(
        streamedAssistantSnapshot,
        extracted,
      );
      streamedAssistantSnapshot = nextFullText;
      if (delta) text += delta;
    }

    bridgeRequests.push(...collectManifestBridgeToolBatch(liveRun));

    if (bridgeRequests.length === 0) {
      const result = await run.wait();
      if (result.status === 'error') {
        throw new Error(result.result ?? 'Cursor SDK run failed');
      }
      if (!text && result.result) text = result.result;
      markManifestLiveRunFinished(liveRun);
    }

    if (!text) text = liveRun.textDeltas.join('');

    return { text, bridgeRequests };
  }

  private async streamLiveRunUntilDone(
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    opts: CursorForwardOptions,
    manifestModelId: string,
    promptText: string,
    run?: ManifestCursorLiveSdkRun,
  ): Promise<ForwardResult> {
    if (opts.signal?.aborted) {
      throw new Error('Request aborted');
    }

    const encoder = new TextEncoder();
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let emittedIncrementalText = false;
        let streamedAssistantSnapshot = liveRun.emittedAssistantPrefix;
        if (streamedAssistantSnapshot.length > 0) {
          emittedIncrementalText = true;
        }
        const recordAssistantSnapshot = (): void => {
          liveRun.emittedAssistantPrefix = streamedAssistantSnapshot;
        };
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: manifestModelId,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`,
            ),
          );

          if (run) {
            const iterator = run.stream()[Symbol.asyncIterator]();
            let pendingStream = iterator.next();

            streamCollectLoop: while (true) {
              if (opts.signal?.aborted) {
                await run.cancel().catch(() => undefined);
                throw new Error('Request aborted');
              }

              const bridgeBatch = collectManifestBridgeToolBatch(liveRun);
              if (bridgeBatch.length > 0) {
                recordAssistantSnapshot();
                await this.enqueueToolCallChunks(
                  controller,
                  encoder,
                  id,
                  created,
                  manifestModelId,
                  bridgeBatch,
                  promptText,
                );
                return;
              }

              let raced: { kind: 'stream'; value: IteratorResult<unknown> } | { kind: 'tick' };
              try {
                raced = await Promise.race([
                  pendingStream.then((value) => ({ kind: 'stream' as const, value })),
                  waitForBridgeToolOrLiveRunDone(liveRun, opts.signal).then(() => ({
                    kind: 'tick' as const,
                  })),
                ]);
              } catch (error) {
                if (error instanceof ManifestCursorLiveRunAbortError || opts.signal?.aborted) {
                  await run.cancel().catch(() => undefined);
                  throw new Error('Request aborted');
                }
                throw error;
              }

              if (raced.kind === 'tick') continue;

              if (raced.value.done) break streamCollectLoop;

              pendingStream = iterator.next();
              const extracted = extractAssistantTextFromSdkMessage(raced.value.value as SDKMessage);
              const { delta, nextFullText } = computeAssistantStreamDelta(
                streamedAssistantSnapshot,
                extracted,
              );
              streamedAssistantSnapshot = nextFullText;
              if (delta) {
                emittedIncrementalText = true;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model: manifestModelId,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                    })}\n\n`,
                  ),
                );
              }
            }

            const trailingBridgeBatch = collectManifestBridgeToolBatch(liveRun);
            if (trailingBridgeBatch.length > 0) {
              recordAssistantSnapshot();
              await this.enqueueToolCallChunks(
                controller,
                encoder,
                id,
                created,
                manifestModelId,
                trailingBridgeBatch,
                promptText,
              );
              return;
            }
          }

          while (!isManifestLiveRunReady(liveRun)) {
            await waitForManifestLiveRunProgress(liveRun, opts.signal);
            while (peekManifestLiveEvent(liveRun)?.type === 'text-delta') {
              const event = shiftManifestLiveEvent(liveRun);
              if (event?.type !== 'text-delta') continue;
              // onDelta mirrors run.stream(); skip re-emitting when the SDK run was consumed above.
              if (run && emittedIncrementalText) continue;
              const { delta, nextFullText } = computeAssistantStreamDelta(
                streamedAssistantSnapshot,
                event.text,
              );
              streamedAssistantSnapshot = nextFullText;
              if (!delta) continue;
              emittedIncrementalText = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: manifestModelId,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
            }
            const bridgeBatch = collectManifestBridgeToolBatch(liveRun);
            if (bridgeBatch.length > 0) {
              recordAssistantSnapshot();
              await this.enqueueToolCallChunks(
                controller,
                encoder,
                id,
                created,
                manifestModelId,
                bridgeBatch,
                promptText,
              );
              return;
            }
          }

          const finalBridgeBatch = collectManifestBridgeToolBatch(liveRun);
          if (finalBridgeBatch.length > 0) {
            recordAssistantSnapshot();
            await this.enqueueToolCallChunks(
              controller,
              encoder,
              id,
              created,
              manifestModelId,
              finalBridgeBatch,
              promptText,
            );
            return;
          }

          const text = liveRun.textDeltas.join('');
          const usage = estimateUsage(promptText, text);
          recordAssistantSnapshot();
          if (text && !emittedIncrementalText && text.length > streamedAssistantSnapshot.length) {
            const trailing = text.slice(streamedAssistantSnapshot.length);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: manifestModelId,
                  choices: [{ index: 0, delta: { content: trailing }, finish_reason: null }],
                })}\n\n`,
              ),
            );
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: manifestModelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: {
                  prompt_tokens: usage.prompt_tokens,
                  completion_tokens: usage.completion_tokens,
                  total_tokens: usage.prompt_tokens + usage.completion_tokens,
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          if (error instanceof ManifestCursorLiveRunAbortError) {
            markManifestLiveRunCancelled(liveRun);
          } else {
            markManifestLiveRunError(
              liveRun,
              error instanceof Error ? error.message : String(error),
            );
          }
          controller.error(error);
        }
      },
    });

    return {
      response: openAiSseResponse(stream),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }

  private async enqueueToolCallChunks(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    id: string,
    created: number,
    manifestModelId: string,
    bridgeBatch: ManifestBridgeToolRequest[],
    promptText: string,
  ): Promise<void> {
    const toolCalls = manifestBridgeRequestsToOpenAiToolCalls(bridgeBatch);
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index]!;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: manifestModelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: toolCall.id,
                      type: toolCall.type,
                      function: { name: toolCall.function.name, arguments: '' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: manifestModelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index, function: { arguments: toolCall.function.arguments } }],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );
    }
    const usage = estimateUsage(promptText, '');
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: manifestModelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
          },
        })}\n\n`,
      ),
    );
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  }

  private async collectLiveRunUntilDone(
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    signal?: AbortSignal,
  ): Promise<RunTextResult> {
    while (!isManifestLiveRunReady(liveRun)) {
      await waitForManifestLiveRunProgress(liveRun, signal);
    }
    const bridgeRequests = collectManifestBridgeToolBatch(liveRun);
    return { text: liveRun.textDeltas.join(''), bridgeRequests };
  }

  private async finalizeLiveRunInBackground(
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    run: Awaited<ReturnType<SDKAgent['send']>>,
    lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    fingerprint: string,
    bootstrapped: boolean,
  ): Promise<void> {
    try {
      const result = await run.wait();
      if (result.status === 'error') {
        markManifestLiveRunError(liveRun, result.result ?? 'Cursor SDK run failed');
      } else {
        markManifestLiveRunFinished(liveRun);
        lease.commitSend(fingerprint, bootstrapped);
      }
    } catch (error) {
      markManifestLiveRunError(liveRun, error instanceof Error ? error.message : String(error));
    } finally {
      const pendingBridge = collectManifestBridgeToolBatch(liveRun);
      const awaitingToolResults = liveRun.bridgeRun?.hasPendingToolCalls() ?? false;
      if (pendingBridge.length === 0 && liveRun.done && !awaitingToolResults) {
        await releaseManifestCursorLiveRun(liveRun);
      }
    }
  }

  private buildForwardResult(
    manifestModelId: string,
    text: string,
    bridgeRequests: ManifestBridgeToolRequest[],
    stream: boolean,
    promptText: string,
    lease?: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    fingerprint?: string,
    bootstrapped?: boolean,
  ): ForwardResult {
    const toolCalls = manifestBridgeRequestsToOpenAiToolCalls(bridgeRequests);
    const usage = estimateUsage(promptText, text || ' ');
    if (stream) {
      return {
        response: openAiSseResponse(buildOpenAiSseStream(manifestModelId, text, usage, toolCalls)),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
    if (
      lease &&
      fingerprint !== undefined &&
      bootstrapped !== undefined &&
      bridgeRequests.length === 0
    ) {
      lease.commitSend(fingerprint, bootstrapped);
    }
    return {
      response: openAiJsonResponse(
        buildOpenAiChatCompletion(manifestModelId, text, usage, toolCalls),
      ),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }
}

export const __testUtils = {
  getManifestCursorSettingSources,
  hasTrailingUserMessagesAfterToolResults,
  releaseAllManifestCursorLiveRunsForTests,
  streamLiveRunUntilDoneForTests(
    service: CursorProxyService,
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    opts: CursorForwardOptions,
    manifestModelId: string,
    promptText: string,
    run?: Awaited<ReturnType<SDKAgent['send']>>,
  ): Promise<ForwardResult> {
    return service['streamLiveRunUntilDone'](liveRun, opts, manifestModelId, promptText, run);
  },
  collectSdkRunWithBridgeForTests(
    service: CursorProxyService,
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    run: Awaited<ReturnType<SDKAgent['send']>>,
    signal?: AbortSignal,
  ): Promise<RunTextResult> {
    return service['collectSdkRunWithBridge'](liveRun, run, signal);
  },
  collectLiveRunUntilDoneForTests(
    service: CursorProxyService,
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    signal?: AbortSignal,
  ): Promise<RunTextResult> {
    return service['collectLiveRunUntilDone'](liveRun, signal);
  },
  finalizeLiveRunInBackgroundForTests(
    service: CursorProxyService,
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    run: Awaited<ReturnType<SDKAgent['send']>>,
    lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    fingerprint: string,
    bootstrapped: boolean,
  ): Promise<void> {
    return service['finalizeLiveRunInBackground'](liveRun, run, lease, fingerprint, bootstrapped);
  },
  handleSdkDeltaForTests(
    service: CursorProxyService,
    liveRun: ReturnType<typeof startManifestCursorLiveRun>,
    update: InteractionUpdate,
  ): void {
    service['handleSdkDelta'](liveRun, update);
  },
  buildForwardResultForTests(
    service: CursorProxyService,
    manifestModelId: string,
    text: string,
    bridgeRequests: ManifestBridgeToolRequest[],
    stream: boolean,
    promptText: string,
    lease?: Awaited<ReturnType<typeof acquireSessionCursorAgent>>,
    fingerprint?: string,
    bootstrapped?: boolean,
  ): ForwardResult {
    return service['buildForwardResult'](
      manifestModelId,
      text,
      bridgeRequests,
      stream,
      promptText,
      lease,
      fingerprint,
      bootstrapped,
    );
  },
  executeRunForTests(
    service: CursorProxyService,
    args: {
      lease: Awaited<ReturnType<typeof acquireSessionCursorAgent>>;
      plan: ReturnType<typeof planCursorSessionSend>;
      context: ReturnType<typeof openAiMessagesToContext>;
      opts: CursorForwardOptions;
      manifestModelId: string;
      apiKey: string;
      scopeKey: string;
      bridgeSnapshot: ReturnType<typeof buildManifestToolBridgeSnapshotFromOpenAiTools>;
      bridgeEnabled: boolean;
      queuedBridgeBeforeLiveRun?: ManifestBridgeToolRequest[];
      assignLiveRun?: (run: ReturnType<typeof startManifestCursorLiveRun>) => void;
    },
  ): Promise<ForwardResult> {
    const queued = args.queuedBridgeBeforeLiveRun ?? [];
    return service['executeRun'](
      args.lease,
      args.plan,
      args.context,
      args.opts,
      args.manifestModelId,
      args.apiKey,
      args.scopeKey,
      args.bridgeSnapshot,
      args.bridgeEnabled,
      queued,
      args.assignLiveRun ?? (() => undefined),
    );
  },
};
