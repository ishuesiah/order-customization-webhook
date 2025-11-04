// webhook-handler.js
// Shopify → ShipStation Gift Note Formatter
// Formats Tepo customizations cleanly into ShipStation's Gift Message field

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint (for Kinsta monitoring)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint (just for testing)
app.get('/', (req, res) => {
  res.status(200).send('🎉 Shopify Webhook Handler is running!');
});

// Use raw body ONLY for the webhook route (needed for HMAC verification)
// This MUST come BEFORE any JSON parsing middleware
app.post('/webhooks/shopify/orders/create',
  express.raw({ type: 'application/json' }),
  handleShopifyOrderWebhook
);

// JSON parsing for other routes (if you add any later)
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════════
// HMAC VERIFICATION (Security)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Verifies that the webhook actually came from Shopify
 * @param {Buffer|string} rawBody - The raw request body
 * @param {string} hmacHeader - The X-Shopify-Hmac-Sha256 header value
 * @returns {boolean} - True if valid, false otherwise
 */
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader || !rawBody) {
    console.warn('❌ HMAC verification failed: Missing header or body');
    return false;
  }

  // Make sure we have the webhook secret
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
    console.error('❌ SHOPIFY_WEBHOOK_SECRET environment variable not set!');
    return false;
  }

  // Calculate what the HMAC should be
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(hmacHeader, 'utf8')
    );
  } catch (error) {
    console.warn('❌ HMAC verification failed:', error.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEPO CUSTOMIZATION FORMATTER
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Formats ugly Tepo customizations into clean, readable text for gift notes
 * @param {Array} lineItems - Array of line items from Shopify order
 * @returns {string} - Formatted customization text
 */
function formatTepoCustomizations(lineItems = []) {
  let formatted = 'CUSTOMIZATIONS:\n\n';
  let hasAnyCustomizations = false;

  for (const item of lineItems) {
    // Skip items without properties
    if (!item.properties || item.properties.length === 0) continue;

    // Filter out technical/internal properties that customers don't need to see
    const cleanProps = item.properties.filter((prop) => {
      const name = String(prop.name || '');
      // Remove properties starting with underscore or containing technical IDs
      return !name.startsWith('_') &&
             !name.includes('optionSetId') &&
             !name.includes('hc_default') &&
             !name.includes('copy');
    });

    // Skip if no clean properties remain
    if (cleanProps.length === 0) continue;

    hasAnyCustomizations = true;

    // Add item name as header
    formatted += `${item.title}:\n`;

    // Add each customization with checkbox format
    for (const prop of cleanProps) {
      let value = String(prop.value ?? '');
      
      // Strip out measurement details like "(12.3 mm ...)" that clutter the display
      value = value.replace(/\([^)]*\d+\.?\d*\s*mm[^)]*\)/gi, '').trim();
      
      // Add the customization with checkbox
      formatted += `☐ ${prop.name}: ${value}\n`;
    }

    formatted += '\n'; // Add spacing between items
  }

  // If no customizations were found, return empty string
  return hasAnyCustomizations ? formatted : '';
}

// ══════════════════════════════════════════════════════════════════════════════
// SHIPSTATION API HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Searches ShipStation for an order by its order number
 * @param {string} orderNumber - The Shopify order number (e.g., "#1001")
 * @returns {Object|null} - The ShipStation order object or null if not found
 */
async function findShipStationOrderByNumber(orderNumber) {
  const url = 'https://ssapi.shipstation.com/orders';
  
  // ShipStation stores order numbers WITHOUT the # symbol
  // Shopify sends them WITH the # symbol, so we need to strip it
  const cleanOrderNumber = orderNumber.replace('#', '');
  
  try {
    const response = await axios.get(url, {
      params: { orderNumber: cleanOrderNumber },
      auth: {
        username: process.env.SHIPSTATION_API_KEY,
        password: process.env.SHIPSTATION_API_SECRET
      },
      timeout: 15000, // 15 second timeout
    });

    // Return the first matching order, or null if none found
    return (response.data?.orders?.[0]) || null;
  } catch (error) {
    console.error(`❌ Error finding order ${orderNumber}:`, error.message);
    return null;
  }
}

/**
 * Updates ONLY the gift message field in ShipStation (preserves SKUs and other data)
 * @param {number} orderId - The ShipStation internal order ID
 * @param {string} message - The gift message content
 */
async function updateShipStationGiftMessage(orderId, message) {
  const url = 'https://ssapi.shipstation.com/orders/createorder';
  
  try {
    await axios.post(
      url,
      {
        orderId,           // Tell ShipStation which order to update
        giftMessage: message, // The new gift message
        // IMPORTANT: We don't include ANY other fields here
        // This way we don't accidentally overwrite items, SKUs, customs, etc.
      },
      {
        auth: {
          username: process.env.SHIPSTATION_API_KEY,
          password: process.env.SHIPSTATION_API_SECRET
        },
        timeout: 15000,
      }
    );
    
    console.log(`✅ Successfully updated gift note for order ID ${orderId}`);
  } catch (error) {
    console.error(`❌ Error updating gift message for order ${orderId}:`, 
                  error.response?.data || error.message);
    throw error; // Re-throw so the caller knows it failed
  }
}

/**
 * Polls ShipStation repeatedly with exponential backoff until order is found
 * This is necessary because Shopify webhook fires BEFORE order syncs to ShipStation
 * 
 * Backoff schedule: 2s, 4s, 8s, 16s, 32s, 32s (total ~94 seconds of waiting)
 * 
 * @param {string} orderNumber - The Shopify order number
 * @param {string} giftMessage - The formatted gift message to set
 * @returns {Promise<boolean>} - True if successful, false if gave up
 */
async function pollShipStationAndUpdate(orderNumber, giftMessage) {
  const backoffs = [2000, 4000, 8000, 16000, 32000, 32000]; // milliseconds
  
  for (let i = 0; i < backoffs.length; i++) {
    console.log(`🔍 Looking for order ${orderNumber} in ShipStation (attempt ${i + 1}/${backoffs.length})...`);
    
    const found = await findShipStationOrderByNumber(orderNumber);
    
    if (found) {
      // Success! Order exists in ShipStation, update the gift note
      await updateShipStationGiftMessage(found.orderId, giftMessage);
      console.log(`✅ Completed processing for order ${orderNumber}`);
      return true;
    }
    
    // Not found yet, wait before trying again
    console.log(`⏳ Order ${orderNumber} not in ShipStation yet. Waiting ${backoffs[i]/1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, backoffs[i]));
  }
  
  // Gave up after all retries
  console.warn(`⚠️ Gave up waiting for order ${orderNumber} to appear in ShipStation`);
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Main webhook handler that receives Shopify order creation events
 * and updates ShipStation gift notes with formatted customizations
 */
async function handleShopifyOrderWebhook(req, res) {
  try {
    // Extract Shopify headers
    const hmac = req.get('X-Shopify-Hmac-Sha256') || req.get('x-shopify-hmac-sha256');
    const topic = req.get('X-Shopify-Topic') || 'orders/create';
    const shop = req.get('X-Shopify-Shop-Domain') || 'unknown.myshopify.com';
    
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`📨 Received webhook: ${topic} from ${shop}`);
    console.log(`${'═'.repeat(80)}`);

    // Get the raw body (needed for HMAC verification)
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    
    // Verify HMAC to make sure this is really from Shopify
    const valid = verifyShopifyWebhook(rawBody, hmac);
    
    if (!valid) {
      console.warn(`❌ HMAC verification failed for ${topic} from ${shop}`);
      return res.status(401).send('Unauthorized');
    }
    
    console.log('✅ HMAC verified - webhook is authentic');

    // Parse the order data (AFTER we've verified it's legit)
    const order = JSON.parse(rawBody);
    console.log(`📦 Processing order: ${order.name} (${order.line_items?.length || 0} items)`);

    // Format the customizations into clean text
    const giftMessage = formatTepoCustomizations(order.line_items);
    
    if (!giftMessage) {
      console.log('ℹ️  No customizations found in this order, skipping ShipStation update');
      return res.status(200).send('OK');
    }
    
    console.log('✨ Formatted customizations:', 
                giftMessage.split('\n').slice(0, 5).join('\n') + '\n...');

    // Respond to Shopify immediately (they require a fast 200 OK)
    // We'll do the ShipStation work in the background
    res.status(200).send('OK');
    console.log('✅ Sent 200 OK to Shopify');

    // Do the ShipStation work AFTER responding to Shopify
    // Using 'finish' event ensures the response is fully sent first
    res.on('finish', async () => {
      try {
        console.log('🚀 Starting background ShipStation update...');
        await pollShipStationAndUpdate(order.name, giftMessage);
      } catch (error) {
        // Log the error but don't crash - we already responded to Shopify
        console.error('💥 Background processing failed:', 
                      error.response?.data || error.message);
      }
    });

  } catch (error) {
    console.error('💥 Webhook handler error:', error.response?.data || error.message);
    
    // If we haven't sent a response yet, send a 200 anyway to avoid Shopify retries
    // (We log the error for debugging but don't want Shopify to keep retrying)
    if (!res.headersSent) {
      res.status(200).send('OK');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🚀 Webhook server running on port ${PORT}`);
  console.log(`📝 Endpoints:`);
  console.log(`   GET  /              - Server status`);
  console.log(`   GET  /health        - Health check`);
  console.log(`   POST /webhooks/shopify/orders/create - Shopify webhook`);
  console.log(`${'═'.repeat(80)}\n`);
  
  // Verify environment variables are set
  const missing = [];
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) missing.push('SHOPIFY_WEBHOOK_SECRET');
  if (!process.env.SHIPSTATION_API_KEY) missing.push('SHIPSTATION_API_KEY');
  if (!process.env.SHIPSTATION_API_SECRET) missing.push('SHIPSTATION_API_SECRET');
  
  if (missing.length > 0) {
    console.error(`⚠️  WARNING: Missing environment variables: ${missing.join(', ')}`);
    console.error(`   The webhook will not work without these!`);
  } else {
    console.log('✅ All environment variables are set');
  }
});
