import type { Component } from 'solid-js';
import { Title, Meta } from '@solidjs/meta';

const Help: Component = () => {
  return (
    <div class="container--sm">
      <Title>Help & Support - Manifest</Title>
      <Meta
        name="description"
        content="Get help with Manifest. Schedule a call or contact support."
      />
      <div class="page-header">
        <div>
          <h1>Help & Support</h1>
          <span class="breadcrumb">
            Questions or issues? Reach out and we'll get back to you quickly
          </span>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Schedule a Call</span>
            <span class="settings-card__label-desc">
              Book a 30-min call with us to get help setting things up.
            </span>
          </div>
          <div class="settings-card__control">
            <a
              href="https://calendly.com/sebastien-manifest/30min?month=2026-02"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn--outline btn--sm"
              style="text-decoration: none;"
            >
              Book
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style="margin-left: 4px;"
                aria-hidden="true"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Email Support</span>
            <span class="settings-card__label-desc">
              sebastien@manifest.build &mdash; we typically respond within 24 hours.
            </span>
          </div>
          <div class="settings-card__control">
            <a
              href="mailto:sebastien@manifest.build"
              class="btn btn--outline btn--sm"
              style="text-decoration: none;"
            >
              Contact
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style="margin-left: 4px;"
                aria-hidden="true"
              >
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </a>
          </div>
        </div>
      </div>

      <div class="settings-card" style="margin-top: 1.5rem;">
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Cursor provider</span>
            <span class="settings-card__label-desc">
              Connect Cursor under Providers with your Cursor API key. Manifest routes requests
              through the local Cursor SDK and bills them as subscription usage ($0.00 per token).
            </span>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Context variants</span>
            <span class="settings-card__label-desc">
              Models with multiple context windows appear as separate entries such as{' '}
              <code>cursor/gpt-5.5@1m</code> and <code>cursor/gpt-5.5@272k</code>. Pick the variant
              that matches the context size you need in Routing or the Playground.
            </span>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Model parameters</span>
            <span class="settings-card__label-desc">
              Use the params affordance on a Cursor route to set reasoning level, fast mode, and SDK
              mode (<code>agent</code> or <code>plan</code>). These flow into Cursor{' '}
              <code>ModelSelection.params</code> on each proxied request.
            </span>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Agent tool bridge</span>
            <span class="settings-card__label-desc">
              When an agent sends OpenAI-style <code>tools</code>, Manifest exposes them to Cursor
              as MCP tools prefixed with <code>manifest__</code> (for example{' '}
              <code>manifest__bash</code>). Cursor returns standard OpenAI <code>tool_calls</code>;
              your agent executes them locally. Manifest does not run agent tools on the backend.
              Send tool results on the next request to resume the same Cursor run.
            </span>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Refresh models</span>
            <span class="settings-card__label-desc">
              Use <strong>Refresh models</strong> on the Routing page or{' '}
              <code>POST /api/v1/routing/:agent/cursor/sync</code> to pull the latest catalog from
              Cursor without reconnecting the provider.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Help;
