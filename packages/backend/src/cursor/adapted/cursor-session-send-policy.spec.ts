import { computeManifestContextFingerprint } from '../cursor-message-converter';
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

  it('uses incremental when fingerprint unchanged', () => {
    const context = { messages: [{ role: 'user', content: 'hi' }] };
    const fingerprint = computeManifestContextFingerprint(context);
    expect(
      planCursorSessionSend(
        { bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: 1 },
        context,
      ),
    ).toEqual({ mode: 'incremental', resetAgent: false, reason: 'incremental' });
  });

  it('rebootstraps after incremental threshold', () => {
    const context = { messages: [{ role: 'user', content: 'hi' }] };
    const fingerprint = computeManifestContextFingerprint(context);
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

  it('rebootstraps when context diverges', () => {
    const before = { messages: [{ role: 'user', content: 'hi' }] };
    const after = { messages: [{ role: 'user', content: 'changed' }] };
    expect(
      shouldBootstrapCursorContext(
        {
          bootstrapped: true,
          contextFingerprint: computeManifestContextFingerprint(before),
          incrementalSendCount: 1,
        },
        after,
      ),
    ).toBe(true);
    expect(
      planCursorSessionSend(
        {
          bootstrapped: true,
          contextFingerprint: computeManifestContextFingerprint(before),
          incrementalSendCount: 1,
        },
        after,
      ).reason,
    ).toBe('context_divergence');
  });
});
