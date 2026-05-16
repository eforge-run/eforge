/**
 * Slack-compatible webhook notifier extension — demonstrates safe event hooks.
 *
 * This extension listens for `plan:error:set` lifecycle events and formats a
 * Slack-compatible payload. It only sends the webhook when
 * `EFORGE_SLACK_WEBHOOK_URL` is set. Without that environment variable, it logs
 * a credential-free skip message so validation, import tests, and event replay
 * never require live Slack credentials.
 *
 * Runtime status: `onEvent` hooks are dispatched at runtime and can also be
 * replay-tested with `eforge extension test`. Treat replay as code execution:
 * if the webhook env var is set, matching replayed events will send requests.
 */

import type { EforgeExtensionAPI, EventOfType } from '@eforge-build/extension-sdk';

const WEBHOOK_URL_ENV = 'EFORGE_SLACK_WEBHOOK_URL';

type PlanErrorSetEvent = EventOfType<'plan:error:set'>;

interface SlackWebhookPayload {
  text: string;
  blocks: Array<{
    type: 'section';
    text: {
      type: 'mrkdwn';
      text: string;
    };
  }>;
}

function formatPayload(event: PlanErrorSetEvent): SlackWebhookPayload {
  return {
    text: `eforge plan ${event.planId} failed: ${event.error}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [`*:warning: eforge plan error*`, `*Plan:* ${event.planId}`, `*Error:* ${event.error}`].join('\n'),
        },
      },
    ],
  };
}

export default function slackWebhookNotifier(eforge: EforgeExtensionAPI): void {
  eforge.onEvent('plan:error:set', async (event: PlanErrorSetEvent, ctx) => {
    const webhookUrl = process.env[WEBHOOK_URL_ENV];
    if (!webhookUrl) {
      ctx.logger.info(`${WEBHOOK_URL_ENV} is unset; skipping Slack-compatible plan error notification`);
      return;
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(formatPayload(event)),
    });

    if (!response.ok) {
      ctx.logger.warn(`Slack-compatible webhook returned HTTP ${response.status} for plan ${event.planId}`);
      return;
    }

    ctx.logger.info(`Sent Slack-compatible plan error notification for ${event.planId}`);
  });
}
