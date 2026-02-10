// server.js
// Combined webhook handler + worker in one process
// This solves the separate container/database issue

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'webhook-queue.db');
let db = null;

// Initialize database
function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ Error opening database:', err);
        reject(err);
        return;
      }
      
      console.log(`✅ Connected to SQLite database: ${DB_PATH}`);
      
      // Create tables
      const createTables = `
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shopify_order_id INTEGER NOT NULL,
          order_number TEXT NOT NULL,
          formatted_note TEXT NOT NULL,
          tag_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          shipstation_order_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_check_at DATETIME,
          attempts INTEGER DEFAULT 0,
          error_message TEXT,
          UNIQUE(shopify_order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_order_number ON orders(order_number);
      `;
      
      db.exec(createTables, (err) => {
        if (err) {
          console.error('❌ Error creating tables:', err);
          reject(err);
          return;
        }
        console.log('✅ Database tables ready');
        resolve();
      });
    });
  });
}

// Database helper functions
function addOrder(shopifyOrderId, orderNumber, formattedNote, tagType) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO orders (shopify_order_id, order_number, formatted_note, tag_type, status)
      VALUES (?, ?, ?, ?, 'pending')
      ON CONFLICT(shopify_order_id) DO UPDATE SET
        formatted_note = excluded.formatted_note,
        tag_type = excluded.tag_type,
        updated_at = CURRENT_TIMESTAMP
    `;
    
    db.run(sql, [shopifyOrderId, orderNumber, formattedNote, tagType], function(err) {
      if (err) {
        console.error('❌ Error adding order:', err);
        reject(err);
        return;
      }
      console.log(`✅ Added order ${orderNumber} to queue (ID: ${this.lastID})`);
      resolve(this.lastID);
    });
  });
}

function getPendingOrders(limit = 50) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * FROM orders 
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `;
    
    db.all(sql, [limit], (err, rows) => {
      if (err) {
        console.error('❌ Error getting pending orders:', err);
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function updateOrderStatus(id, status, shipstationOrderId = null, errorMessage = null) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE orders 
      SET status = ?,
          shipstation_order_id = COALESCE(?, shipstation_order_id),
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP,
          last_check_at = CURRENT_TIMESTAMP,
          attempts = attempts + 1
      WHERE id = ?
    `;
    
    db.run(sql, [status, shipstationOrderId, errorMessage, id], (err) => {
      if (err) {
        console.error('❌ Error updating order status:', err);
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function getStats() {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT 
        status,
        COUNT(*) as count
      FROM orders
      GROUP BY status
    `;
    
    db.all(sql, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getRecentOrders(limit = 100) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * FROM orders 
      ORDER BY created_at DESC
      LIMIT ?
    `;
    
    db.all(sql, [limit], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS APP SETUP
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Dashboard
app.get('/', async (req, res) => {
  try {
    const stats = await getStats();
    const recentOrders = await getRecentOrders(50);
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Webhook Queue Dashboard</title>
  <meta http-equiv="refresh" content="30">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f3f4f6;
    }
    h1 { color: #1f2937; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .stat-number {
      font-size: 32px;
      font-weight: bold;
      color: #6366f1;
    }
    .stat-label {
      color: #6b7280;
      font-size: 14px;
      margin-top: 5px;
    }
    table {
      width: 100%;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    th {
      background: #6366f1;
      color: white;
      padding: 12px;
      text-align: left;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e5e7eb;
    }
    tr:hover {
      background: #f9fafb;
    }
    .status {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .status-pending { background: #fef3c7; color: #92400e; }
    .status-completed { background: #d1fae5; color: #065f46; }
    .status-failed { background: #fee2e2; color: #991b1b; }
    .tag-charm { color: #db2777; }
    .tag-customization { color: #7c3aed; }
    .note-preview {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: #6b7280;
    }
  </style>
  <script>
    function formatPST(utcDateStr) {
      const date = new Date(utcDateStr);
      return date.toLocaleString('en-US', { 
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    }
  </script>
</head>
<body>
  <h1>🎯 Webhook Queue Dashboard</h1>
  <p style="color: #6b7280;">Auto-refreshes every 30 seconds • Times shown in PST</p>
  
  <div class="stats">
    ${stats.map(s => `
      <div class="stat-card">
        <div class="stat-number">${s.count}</div>
        <div class="stat-label">${s.status.toUpperCase()}</div>
      </div>
    `).join('')}
  </div>

  <h2>Recent Orders</h2>
  <table>
    <thead>
      <tr>
        <th>Order #</th>
        <th>Status</th>
        <th>Tag</th>
        <th>Note Preview</th>
        <th>Attempts</th>
        <th>Created (PST)</th>
        <th>Updated (PST)</th>
      </tr>
    </thead>
    <tbody>
      ${recentOrders.map(order => `
        <tr>
          <td><strong>${order.order_number}</strong></td>
          <td><span class="status status-${order.status}">${order.status}</span></td>
          <td><span class="tag-${order.tag_type}">${order.tag_type}</span></td>
          <td class="note-preview">${order.formatted_note.substring(0, 50)}...</td>
          <td>${order.attempts}</td>
          <td><script>document.write(formatPST('${order.created_at}'));</script></td>
          <td><script>document.write(formatPST('${order.updated_at}'));</script></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div style="margin-top: 20px; padding: 15px; background: white; border-radius: 8px;">
    <h3>🛠️ System Info</h3>
    <p><strong>Mode:</strong> Combined (Webhook + Worker in one process)</p>
    <p><strong>Endpoint:</strong> POST /webhooks/shopify/orders/create</p>
    <p><strong>Worker:</strong> Running in background (checks every 5 min)</p>
    <p><strong>Database:</strong> ${DB_PATH}</p>
    <p><strong>Current Time (PST):</strong> <script>document.write(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));</script></p>
  </div>
</body>
</html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// Webhook endpoint
app.post('/webhooks/shopify/orders/create',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
// HMAC VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader || !rawBody) return false;
  
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(hmacHeader, 'utf8')
    );
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEPO FORMATTER
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// TEPO FORMATTER
// ═══════════════════════════════════════════════════════════════════════════

function formatTepoCustomizations(lineItems = []) {
    let formatted = 'CUSTOMIZATIONS:\n\n';
    let hasAny = false;
    let hasCharms = false;  // Track if any charms are present for the signature line
  
    for (const item of lineItems) {
      if (!item.properties || item.properties.length === 0) continue;
  
      // Filter out internal/hidden properties (ones starting with _ or containing system keys)
      const cleanProps = item.properties.filter((prop) => {
        const name = String(prop.name || '');
        return !name.startsWith('_') &&
               !name.includes('optionSetId') &&
               !name.includes('hc_default') &&
               !name.includes('copy');
      });
  
      if (cleanProps.length === 0) continue;
      hasAny = true;
  
      // ══════════════════════════════════════════════════════════════════════
      // FIX #1: Just use item.name - it already includes variant info from Shopify
      // The webhook payload's item.name is typically "Product Title - Variant Title"
      // ══════════════════════════════════════════════════════════════════════
      const productName = item.name || item.title || 'Unknown Product';
      
      // Check if this item is a charm (for tracking signature line need)
      const isCharmItem = productName.toLowerCase().includes('charm');
      if (isCharmItem) hasCharms = true;
  
      formatted += `${productName}\n`;
  
      // ══════════════════════════════════════════════════════════════════════
      // FIX #2: Handle monogram properties specially
      // Look for monogram-related properties and format as "Ribbon one monogram: 'X'"
      // ══════════════════════════════════════════════════════════════════════
      
      // First, check if any properties indicate this is a monogram charm
      const monogramProp = cleanProps.find((prop) => {
        const name = String(prop.name || '').toLowerCase();
        const value = String(prop.value || '').toLowerCase();
        // Look for properties like "Monogram Letter", "Letter", "Initial", etc.
        return name.includes('monogram') || 
               name.includes('letter') || 
               name.includes('initial') ||
               // Also check if it's a single character value (likely a monogram letter)
               (value.length === 1 && /^[a-z]$/i.test(value));
      });
  
      // Check if this is a ribbon/monogram charm item
      const isMonogramCharm = productName.toLowerCase().includes('monogram') || 
                              productName.toLowerCase().includes('ribbon');
  
      for (const prop of cleanProps) {
        const propName = String(prop.name || '');
        const propNameLower = propName.toLowerCase();
        let value = String(prop.value ?? '');
        
        // Remove measurement parentheticals like "(150mm x 200mm)"
        value = value.replace(/\([^)]*\d+\.?\d*\s*mm[^)]*\)/gi, '').trim();
  
        // Special handling for monogram letters on ribbon charms
        if (isMonogramCharm && 
            (propNameLower.includes('monogram') || 
             propNameLower.includes('letter') || 
             propNameLower.includes('initial') ||
             (value.length === 1 && /^[a-z]$/i.test(value)))) {
          // Format as "Ribbon one monogram: 'M'"
          formatted += `☐ Ribbon one monogram: '${value.toUpperCase()}'\n`;
        } else {
          // Standard formatting for other properties
          formatted += `☐ ${propName}: ${value}\n`;
        }
      }
      formatted += '\n';
    }
  
    // ══════════════════════════════════════════════════════════════════════
    // FIX #3: Add signature line at the bottom if there are any charms
    // ══════════════════════════════════════════════════════════════════════
    if (hasAny && hasCharms) {
      formatted += '════════════════════════════════════════\n';
      formatted += 'Charm(s) handplaced by: ____________________________\n';
    }
  
    return hasAny ? formatted : '';
  }

function determineTagType(lineItems = []) {
  for (const item of lineItems) {
    if (!item.properties || item.properties.length === 0) continue;

    if (item.name && item.name.toLowerCase().includes('charm')) {
      return 'charm';
    }

    for (const prop of item.properties) {
      const name = String(prop.name || '').toLowerCase();
      const value = String(prop.value || '').toLowerCase();
      
      if (name.includes('charm') || value.includes('charm')) {
        return 'charm';
      }
    }
  }

  return 'customization';
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

async function handleWebhook(req, res) {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic') || 'orders/create';
    const shop = req.get('X-Shopify-Shop-Domain') || 'unknown';
    
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`📨 Webhook: ${topic} from ${shop}`);
    console.log(`${'═'.repeat(80)}`);

    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    
    if (!verifyShopifyWebhook(rawBody, hmac)) {
      console.warn('❌ HMAC verification failed');
      return res.status(401).send('Unauthorized');
    }
    
    console.log('✅ HMAC verified');

    const order = JSON.parse(rawBody);
    console.log(`📦 Order: ${order.name} (ID: ${order.id})`);

        // ============ ADD THIS DEBUG SECTION ============
    // Debug: Log the first line item with customizations to see field structure
    const itemWithProps = order.line_items?.find(item => 
      item.properties && item.properties.length > 0
    );
    
    if (itemWithProps) {
      console.log('\n🔍 DEBUG - Line item with customizations:');
      console.log('  name:', itemWithProps.name);
      console.log('  title:', itemWithProps.title);
      console.log('  variant_title:', itemWithProps.variant_title);
      console.log('  sku:', itemWithProps.sku);
      // This will help you see if name includes the full title + variant
    }

    const formattedNote = formatTepoCustomizations(order.line_items);
    
    if (!formattedNote) {
      console.log('ℹ️  No customizations found, skipping');
      return res.status(200).send('OK');
    }
    
    console.log('✨ Formatted customizations');

    const tagType = determineTagType(order.line_items);
    console.log(`🏷️  Tag type: ${tagType}`);

    await addOrder(
      order.id,
      order.name.replace('#', ''),
      formattedNote,
      tagType
    );

    console.log('💾 Order queued for processing');

    res.status(200).send('OK');
    console.log('✅ Sent 200 OK to Shopify\n');

  } catch (error) {
    console.error('💥 Webhook error:', error.message);
    if (!res.headersSent) res.status(200).send('OK');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARCEL SELECTION CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Box dimensions in centimeters (L × W × H)
const PACKAGE_DIMENSIONS = {
  'BoxMaster 2"': { length: 25.4, width: 17.78, height: 5, units: 'centimeters' },
  'BoxMaster 3"': { length: 27.94, width: 20.95, height: 7.62, units: 'centimeters' },
  'BoxMaster 6"': { length: 29.21, width: 24.13, height: 15.24, units: 'centimeters' }
};

// Weight thresholds in kilograms
const WEIGHT_THRESHOLDS = {
  small: 1.5,   // < 1.5 kg → BoxMaster 2"
  medium: 2.5   // >= 1.5 kg and < 2.5 kg → BoxMaster 3", >= 2.5 kg → BoxMaster 6"
};

// International carrier settings
const INTERNATIONAL_CARRIER = {
  carrierCode: 'ups',
  serviceCode: 'ups_worldwide_expedited'
};

// Helper: Check if order is international (not US or Canada)
function isInternational(shipTo) {
  if (!shipTo || !shipTo.country) return false;
  const country = shipTo.country.toUpperCase();
  return country !== 'US' && country !== 'USA' && country !== 'CA' && country !== 'CAN' && country !== 'CANADA';
}

// Helper: Convert ShipStation weight to kilograms
function getWeightInKg(weight) {
  if (!weight || weight.value === undefined || weight.value === null) return 0;

  const units = (weight.units || '').toLowerCase();
  const value = weight.value;

  switch (units) {
    case 'ounces':
    case 'oz':
      return value * 0.0283495;
    case 'pounds':
    case 'lbs':
    case 'lb':
      return value * 0.453592;
    case 'grams':
    case 'g':
      return value / 1000;
    case 'kilograms':
    case 'kg':
    default:
      return value;
  }
}

// Helper: Select package dimensions based on weight
function selectPackageByWeight(weightInKg) {
  if (weightInKg < WEIGHT_THRESHOLDS.small) {
    return { name: 'BoxMaster 2"', dimensions: PACKAGE_DIMENSIONS['BoxMaster 2"'] };
  } else if (weightInKg < WEIGHT_THRESHOLDS.medium) {
    return { name: 'BoxMaster 3"', dimensions: PACKAGE_DIMENSIONS['BoxMaster 3"'] };
  } else {
    return { name: 'BoxMaster 6"', dimensions: PACKAGE_DIMENSIONS['BoxMaster 6"'] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHIPSTATION API
// ═══════════════════════════════════════════════════════════════════════════

function createShipStationClient() {
  return axios.create({
    baseURL: 'https://ssapi.shipstation.com',
    auth: {
      username: process.env.SHIPSTATION_API_KEY,
      password: process.env.SHIPSTATION_API_SECRET
    },
    timeout: 15000
  });
}

async function findShipStationOrder(orderNumber) {
  const client = createShipStationClient();
  
  try {
    const response = await client.get('/orders', {
      params: { orderNumber }
    });
    
    const orders = response.data?.orders || [];
    return orders[0] || null;
  } catch (error) {
    console.error(`❌ Error searching for order ${orderNumber}:`, error.message);
    return null;
  }
}

async function getFullOrder(orderId) {
  const client = createShipStationClient();
  
  try {
    const response = await client.get(`/orders/${orderId}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error getting full order ${orderId}:`, error.message);
    throw error;
  }
}

async function updateOrderDetails(orderId, giftMessage) {
  const client = createShipStationClient();

  try {
    console.log(`  📝 Getting full order ${orderId}...`);
    const fullOrder = await getFullOrder(orderId);

    // DEBUG: Log what we GET from ShipStation
    console.log(`  🔍 BEFORE UPDATE - Order has ${fullOrder.customsItems?.length || 0} customs items`);

    // Start building the updated order
    const updatedOrder = {
      ...fullOrder,
      giftMessage: giftMessage
    };

    // ═══════════════════════════════════════════════════════════════════════
    // PARCEL SELECTION LOGIC
    // ═══════════════════════════════════════════════════════════════════════

    // Get weight and select appropriate package
    const weightInKg = getWeightInKg(fullOrder.weight);
    const selectedPackage = selectPackageByWeight(weightInKg);

    console.log(`  📦 Weight: ${weightInKg.toFixed(2)} kg → Package: ${selectedPackage.name}`);

    // Set package dimensions
    updatedOrder.dimensions = selectedPackage.dimensions;

    // Check if international and set carrier
    const isIntl = isInternational(fullOrder.shipTo);

    if (isIntl) {
      console.log(`  🌍 International order (${fullOrder.shipTo?.country}) → Setting UPS Worldwide Expedited`);
      updatedOrder.carrierCode = INTERNATIONAL_CARRIER.carrierCode;
      updatedOrder.serviceCode = INTERNATIONAL_CARRIER.serviceCode;
    } else {
      console.log(`  🏠 Domestic order (${fullOrder.shipTo?.country})`);
    }

    // DEBUG: Log what we're SENDING to ShipStation
    console.log(`  🔍 SENDING TO SS - dimensions:`, JSON.stringify(updatedOrder.dimensions));
    if (isIntl) {
      console.log(`  🔍 SENDING TO SS - carrier: ${updatedOrder.carrierCode}, service: ${updatedOrder.serviceCode}`);
    }

    await client.post('/orders/createorder', updatedOrder);
    console.log(`  ✅ Order updated (gift message + package${isIntl ? ' + carrier' : ''})`);

    return true;
  } catch (error) {
    console.error(`  ❌ Error updating order:`, error.response?.data || error.message);
    throw error;
  }
}

async function getTagId(tagName) {
  const client = createShipStationClient();
  
  try {
    const response = await client.get('/accounts/listtags');
    const tags = response.data?.tags || response.data || [];
    const tag = tags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
    
    if (!tag) {
      console.warn(`⚠️  Tag "${tagName}" not found in ShipStation`);
      return null;
    }
    
    return tag.tagId;
  } catch (error) {
    console.error(`❌ Error getting tag ID for "${tagName}":`, error.message);
    return null;
  }
}

async function addTagToOrder(orderId, tagId) {
  const client = createShipStationClient();
  
  try {
    console.log(`  🏷️  Adding tag ${tagId} to order ${orderId}...`);
    
    await client.post('/orders/addtag', {
      orderId: orderId,
      tagId: tagId
    });
    
    console.log(`  ✅ Tag added successfully`);
    return true;
  } catch (error) {
    console.error(`  ❌ Error adding tag:`, error.response?.data || error.message);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKER - PROCESS PENDING ORDERS
// ═══════════════════════════════════════════════════════════════════════════

async function processOrder(order) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`📦 Processing order ${order.order_number} (DB ID: ${order.id})`);
  console.log(`   Tag: ${order.tag_type}`);
  console.log(`   Attempts: ${order.attempts}`);
  
  try {
    console.log(`  🔍 Searching ShipStation for order ${order.order_number}...`);
    const shipstationOrder = await findShipStationOrder(order.order_number);
    
    if (!shipstationOrder) {
      console.log(`  ⏳ Order not in ShipStation yet, will retry later`);
      await updateOrderStatus(order.id, 'pending', null, 'Order not yet synced');
      return;
    }
    
    console.log(`  ✅ Found in ShipStation! Order ID: ${shipstationOrder.orderId}`);

    await updateOrderDetails(shipstationOrder.orderId, order.formatted_note);
    
    const tagId = await getTagId(order.tag_type);
    
    if (tagId) {
      await addTagToOrder(shipstationOrder.orderId, tagId);
    } else {
      console.warn(`  ⚠️  Skipping tag (not found in ShipStation)`);
    }
    
    await updateOrderStatus(order.id, 'completed', shipstationOrder.orderId, null);
    
    console.log(`  🎉 Order ${order.order_number} completed successfully!`);
    
  } catch (error) {
    console.error(`  💥 Error processing order:`, error.message);
    
    if (order.attempts >= 10) {
      await updateOrderStatus(order.id, 'failed', null, error.message);
      console.log(`  ❌ Order ${order.order_number} marked as failed after ${order.attempts + 1} attempts`);
    } else {
      await updateOrderStatus(order.id, 'pending', null, error.message);
      console.log(`  ⚠️  Order ${order.order_number} will retry later`);
    }
  }
}

async function processPendingOrders() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🔄 Checking for pending orders...`);
  console.log(`   Time: ${new Date().toLocaleString()}`);
  console.log(`${'═'.repeat(80)}`);
  
  try {
    const pendingOrders = await getPendingOrders(50);
    
    if (pendingOrders.length === 0) {
      console.log('✅ No pending orders to process');
      return;
    }
    
    console.log(`📋 Found ${pendingOrders.length} pending orders`);
    
    for (const order of pendingOrders) {
      await processOrder(order);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const stats = await getStats();
    console.log(`\n📊 Current Stats:`);
    stats.forEach(s => {
      console.log(`   ${s.status}: ${s.count}`);
    });
    
  } catch (error) {
    console.error('💥 Error in processing loop:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER & WORKER
// ═══════════════════════════════════════════════════════════════════════════

async function start() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🚀 Starting Combined Webhook + Worker Server...`);
  console.log(`${'═'.repeat(80)}\n`);
  
  // Initialize database
  await initDatabase();
  
  // Start Express server
  app.listen(PORT, () => {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/`);
    console.log(`📝 Webhook endpoint: POST /webhooks/shopify/orders/create`);
    console.log(`${'═'.repeat(80)}\n`);
    
    const missing = [];
    if (!process.env.SHOPIFY_WEBHOOK_SECRET) missing.push('SHOPIFY_WEBHOOK_SECRET');
    if (!process.env.SHIPSTATION_API_KEY) missing.push('SHIPSTATION_API_KEY');
    if (!process.env.SHIPSTATION_API_SECRET) missing.push('SHIPSTATION_API_SECRET');
    
    if (missing.length > 0) {
      console.error(`⚠️  Missing env vars: ${missing.join(', ')}`);
    } else {
      console.log('✅ All environment variables set');
    }
  });
  
  // Start worker in background
  const POLL_INTERVAL = process.env.POLL_INTERVAL || 5 * 60 * 1000; // 5 minutes
  console.log(`🤖 Worker starting (checks every ${POLL_INTERVAL / 1000} seconds)...\n`);
  
  // Initial check
  await processPendingOrders();
  
  // Recurring checks
  setInterval(processPendingOrders, POLL_INTERVAL);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, closing database...');
  if (db) db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, closing database...');
  if (db) db.close();
  process.exit(0);
});

// Start everything
start().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
