// webhook-handler.js
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ── Setup ─────────────────────────────────────────────────────────────────────
const app = express();

// Use raw body ONLY for the Shopify webhook route so HMAC is correct.
// Important: this must come BEFORE any body parser for that path.
app.post('/webhooks/shopify/orders/create',
  express.raw({ type: 'application/json' }),
  shopifyOrdersCreateHandler
);

// Fallback for other routes (JSON parsing is fine elsewhere)
app.use(express.json());

// ── HMAC verification ─────────────────────────────────────────────────────────
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader || !rawBody) return false;
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  // Use timingSafeEqual to avoid timing attacks.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(hmacHeader, 'utf8')
    );
  } catch {
    return false;
  }
}

// ── TEPO → gift note formatting ──────────────────────────────────────────────
function formatTepoCustomizations(lineItems = []) {
  let formatted = 'CUSTOMIZATIONS:\n\n';

  for (const item of lineItems) {
    if (!item.properties || item.properties.length === 0) continue;

    const clean = item.properties.filter((prop) => {
      const name = String(prop.name || '');
      return !name.startsWith('_') &&
             !name.includes('optionSetId') &&
             !name.includes('hc_default') &&
             !name.includes('copy');
    });

    if (clean.length === 0) continue;

    formatted += `${item.title}:\n`;
    for (const prop of clean) {
      let value = String(prop.value ?? '');
      // Strip measurements like "(12.3 mm ...)"
      value = value.replace(/\([^)]*\d+\.?\d*\s*mm[^)]*\)/gi, '').trim();
      formatted += `☐ ${prop.name}: ${value}\n`;
    }
    formatted += '\n';
  }

  return formatted;
}

// ── ShipStation helpers ──────────────────────────────────────────────────────
async function findShipStationOrderByNumber(orderNumber) {
  const url = `https://ssapi.shipstation.com/orders`;
  const res = await axios.get(url, {
    params: { orderNumber },
    auth: {
      username: process.env.SHIPSTATION_API_KEY,
      password: process.env.SHIPSTATION_API_SECRET
    },
    timeout: 15000,
  });
  return (res.data && res.data.orders && res.data.orders[0]) || null;
}

async function updateShipStationGiftMessage(orderId, message) {
  const url = `https://ssapi.shipstation.com/orders/createorder`;
  await axios.post(
    url,
    {
      orderId,
      giftMessage: message,
      // DO NOT include any other fields to avoid overwriting items/SKUs.
    },
    {
      auth: {
        username: process.env.SHIPSTATION_API_KEY,
        password: process.env.SHIPSTATION_API_SECRET
      },
      timeout: 15000,
    }
  );
}

// Polls for up to ~2 minutes with exponential backoff (2, 4, 8, 16, 32, 32 secs).
async function pollShipStationAndUpdate(orderNumber, giftMessage) {
  const backoffs = [2000, 4000, 8000, 16000, 32000, 32000];
  for (let i = 0; i < backoffs.length; i++) {
    const found = await findShipStationOrderByNumber(orderNumber);
    if (found) {
      await updateShipStationGiftMessage(found.orderId, giftMessage);
      console.log(`✅ Updated Gift Note for order ${orderNumber}`);
      return true;
    }
    console.log(`Order ${orderNumber} not in ShipStation yet. Retry ${i + 1}/${backoffs.length}`);
    await new Promise((r) => setTimeout(r, backoffs[i]));
  }
  console.warn(`⚠️ Gave up waiting for ShipStation order ${orderNumber}`);
  return false;
}

// ── Route handler ────────────────────────────────────────────────────────────
async function shopifyOrdersCreateHandler(req, res) {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256') || req.get('x-shopify-hmac-sha256');
    const topic = req.get('X-Shopify-Topic') || 'orders/create';
    const shop  = req.get('X-Shopify-Shop-Domain') || 'unknown.myshopify.com';

    // Verify HMAC using the raw buffer (not parsed JSON!)
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const valid = verifyShopifyWebhook(rawBody, hmac);
    if (!valid) {
      console.warn(`Shopify HMAC failed for topic ${topic} from ${shop}`);
      return res.status(401).send('Unauthorized');
    }

    // Parse the JSON only after verification.
    const order = JSON.parse(rawBody);

    // Build the gift note content now
    const giftMessage = formatTepoCustomizations(order.line_items);

    // Respond immediately (Shopify requirement: fast 200)
    res.status(200).send('OK');

    // Do the ShipStation work after the response has been sent.
    // Using 'finish' ensures the connection is fully flushed first.
    res.on('finish', async () => {
      try {
        await pollShipStationAndUpdate(order.name, giftMessage);
      } catch (err) {
        console.error('Background processing failed:', err?.response?.data || err.message);
      }
    });

  } catch (err) {
    console.error('Webhook handler error:', err?.response?.data || err.message);
    // If we get here before sending anything, fall back to a 200 to avoid Shopify retries.
    if (!res.headersSent) res.status(200).send('OK');
  }
}

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on :${PORT}`);
});
