import {
  computeManifestBootstrapContextFingerprint,
  computeManifestContextFingerprint,
} from '../cursor-message-converter';
import {
  MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
  planCursorSessionSend,
  shouldBootstrapCursorContext,
} from './cursor-session-send-policy';

describe('cursor-session-send-policy', () => {
  it('bootstraps on first send', () => {
    expect(
      planCursorSessionSend(
        { bootstrapped: false, contextFingerprint: '', incrementalSendCount: 0 },
        { messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).toEqual({ mode: 'bootstrap', resetAgent: false, reason: 'initial' });
  });

  it('uses incremental when bootstrap fingerprint unchanged', () => {
    const context = { messages: [{ role: 'user', content: 'hi' }] };
    const fingerprint = computeManifestBootstrapContextFingerprint(context);
    expect(
      planCursorSessionSend(
        { bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: 1 },
        context,
      ),
    ).toEqual({ mode: 'incremental', resetAgent: false, reason: 'incremental' });
  });

  it('uses incremental when full transcript grows on follow-up', () => {
    const firstTurn = { messages: [{ role: 'user', content: 'hi' }] };
    const followUp = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'follow up' },
      ],
    };
    const bootstrapFingerprint = computeManifestBootstrapContextFingerprint(firstTurn);
    expect(computeManifestContextFingerprint(firstTurn)).not.toBe(
      computeManifestContextFingerprint(followUp),
    );
    expect(
      planCursorSessionSend(
        {
          bootstrapped: true,
          contextFingerprint: bootstrapFingerprint,
          incrementalSendCount: 1,
        },
        followUp,
      ),
    ).toEqual({ mode: 'incremental', resetAgent: false, reason: 'incremental' });
  });

  it('rebootstraps after incremental threshold', () => {
    const context = { messages: [{ role: 'user', content: 'hi' }] };
    const fingerprint = computeManifestBootstrapContextFingerprint(context);
    expect(
      planCursorSessionSend(
        {
          bootstrapped: true,
          contextFingerprint: fingerprint,
          incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
        },
        context,
      ),
    ).toEqual({ mode: 'bootstrap', resetAgent: true, reason: 'incremental_threshold' });
  });

  it('bootstraps when fingerprint missing despite bootstrapped flag', () => {
    expect(
      shouldBootstrapCursorContext(
        { bootstrapped: true, contextFingerprint: '', incrementalSendCount: 1 },
        { messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).toBe(true);
  });

  it('rebootstraps when bootstrap context diverges', () => {
    const before = {
      systemPrompt: 'Be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const after = {
      systemPrompt: 'Be terse',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'follow up' },
      ],
    };
    expect(
      shouldBootstrapCursorContext(
        {
          bootstrapped: true,
          contextFingerprint: computeManifestBootstrapContextFingerprint(before),
          incrementalSendCount: 1,
        },
        after,
      ),
    ).toBe(true);
    expect(
      planCursorSessionSend(
        {
          bootstrapped: true,
          contextFingerprint: computeManifestBootstrapContextFingerprint(before),
          incrementalSendCount: 1,
        },
        after,
      ),
    ).toEqual({ mode: 'bootstrap', resetAgent: true, reason: 'context_divergence' });
  });
});
