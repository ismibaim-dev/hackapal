import express, { Router, type Response } from 'express';
import { log } from './log.js';
import type { OrderService, WebhookEvent } from './orders.js';
import { renderPage, type PageOptions } from './pages.js';
import type { PayPalGateway } from './paypal.js';

export interface PayPalRoutesDeps {
  orders: OrderService;
  paypal: PayPalGateway;
  webhookId: string | undefined;
}

function sendPage(res: Response, status: number, page: PageOptions): void {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(renderPage(page));
}

/** Buyer-facing return/cancel pages and the PayPal webhook. */
export function paypalRoutes({ orders, paypal, webhookId }: PayPalRoutesDeps): Router {
  const router = Router();

  // PayPal sends the buyer here after they approve: /paypal/return?token=<PayPal order id>&PayerID=...
  router.get('/paypal/return', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const order = token ? await orders.getByPayPalOrderId(token) : undefined;
    if (!order) {
      sendPage(res, 404, {
        title: 'Order not found',
        paragraphs: ["We couldn't find this order. Nothing was charged by this page. Please go back to your assistant."],
        tone: 'warning',
      });
      return;
    }

    let result;
    try {
      result = await orders.capture(order.id, 'return');
    } catch (err) {
      log.error('capture on return failed', { order_id: order.id, err });
      sendPage(res, 502, {
        title: "We couldn't confirm your payment yet",
        paragraphs: [
          'PayPal did not answer in time. You will not be charged twice: trying again is safe.',
          'You can also go back to your assistant and ask it to check the order status.',
        ],
        link: { href: req.originalUrl, label: 'Try again' },
        tone: 'warning',
      });
      return;
    }

    switch (result.outcome) {
      case 'completed':
        sendPage(res, 200, {
          title: 'Payment complete',
          paragraphs: [
            'Payment complete, you can go back to your assistant.',
            "Auntie's Kitchen will contact you to arrange pickup or local delivery.",
          ],
          tone: 'success',
        });
        return;
      case 'pending':
        sendPage(res, 200, {
          title: 'Payment received, waiting for PayPal',
          paragraphs: [
            'PayPal accepted your payment but is holding it for a short review.',
            'You can go back to your assistant; it can check when the payment clears.',
          ],
        });
        return;
      case 'declined':
        // PayPal's guidance for INSTRUMENT_DECLINED: send the buyer back to choose another funding source.
        res.set('Cache-Control', 'no-store').redirect(302, result.order.approvalUrl);
        return;
      case 'not_approved':
        sendPage(res, 200, {
          title: 'Payment not approved yet',
          paragraphs: ["PayPal hasn't confirmed your approval for this order. Nothing was charged."],
          link: { href: result.order.approvalUrl, label: 'Open PayPal again' },
          tone: 'warning',
        });
        return;
      case 'failed':
        sendPage(res, 200, {
          title: "This order can't be paid",
          paragraphs: ['Nothing was charged. Please ask your assistant to start a new order.'],
          tone: 'warning',
        });
        return;
    }
  });

  // PayPal sends the buyer here when they cancel: /paypal/cancel?token=<PayPal order id>
  router.get('/paypal/cancel', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const order = token ? await orders.cancelByPayPalOrderId(token) : undefined;
    if (order?.status === 'COMPLETED') {
      sendPage(res, 200, {
        title: 'Already paid',
        paragraphs: ['This order was already paid, so nothing was cancelled. You can go back to your assistant.'],
        tone: 'success',
      });
      return;
    }
    sendPage(res, 200, {
      title: 'Payment cancelled',
      paragraphs: [
        'Nothing was charged.',
        'If you change your mind, ask your assistant for the PayPal link again; it stays valid for a while.',
      ],
    });
  });

  // Raw body on this route only: the signature check needs the exact bytes PayPal sent.
  router.post('/webhooks/paypal', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!webhookId) {
      log.warn('webhook received but PAYPAL_WEBHOOK_ID is not set');
      res.status(503).json({ error: 'webhook_not_configured' });
      return;
    }
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let event: WebhookEvent;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      event = parsed as WebhookEvent;
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const transmissionId = req.headers['paypal-transmission-id'];
    let verified: boolean;
    try {
      verified = await paypal.verifyWebhookSignature({ headers: req.headers, rawBody, webhookId });
    } catch (err) {
      // PayPal retries non-2xx deliveries, so a temporary failure here isn't lost.
      log.error('webhook verification unavailable', { event_id: event.id, transmission_id: transmissionId, err });
      res.status(503).json({ error: 'verification_unavailable' });
      return;
    }
    if (!verified) {
      log.warn('webhook rejected: signature not verified', {
        event_id: event.id,
        event_type: event.event_type,
        transmission_id: transmissionId,
      });
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    log.info('webhook verified', { event_id: event.id, event_type: event.event_type, transmission_id: transmissionId });
    // Acknowledge first (PayPal retries after 30 s), then process.
    res.status(200).json({ received: true });
    setImmediate(() => {
      orders.handleWebhookEvent(event).catch((err: unknown) => {
        log.error('webhook processing failed', { event_id: event.id, event_type: event.event_type, err });
      });
    });
  });

  return router;
}
