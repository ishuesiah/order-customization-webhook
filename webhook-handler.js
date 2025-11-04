// webhook-handler.js
// Receives Shopify webhooks and queues them for processing

const express = require('express');
const crypto = require('crypto');
const { Database } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database();

// Initialize database
db.initialize().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Admin dashboard
app.get('/', async (req, res) => {
  try {
    const stats = await db.getStats();
    const recentOrders = await db.getRecentOrders(50);
    
    // Build HTML dashboard
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
</head>
<body>
  <h1>🎯 Webhook Queue Dashboard</h1>
  <p style="color: #6b7280;">Auto-refreshes every 30 seconds</p>
  
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
        <th>Created</th>
        <th>Updated</th>
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
          <td>${new Date(order.created_at).toLocaleString()}</td>
          <td>${new Date(order.updated_at).toLocaleString()}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div style="margin-top: 20px; padding: 15px; background: white; border-radius: 8px;">
    <h3>🛠️ System Info</h3>
    <p><strong>Endpoint:</strong> POST /webhooks/shopify/orders/create</p>
    <p><strong>Worker:</strong> Run <code>node worker.js</code> to process pending orders</p>
    <p><strong>Database:</strong> ${process.env.DB_PATH || './webhook-queue.db'}</p>
  </div>
</body>
</html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// Webhook endpoint - uses raw body for HMAC verification
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
function formatTepoCustomizations(lineItems = []) {
  let formatted = 'CUSTOMIZATIONS:\n\n';
  let hasAny = false;

  for (const item of lineItems) {
    if (!item.properties || item.properties.length === 0) continue;

    // Filter out technical junk
    const cleanProps = item.properties.filter((prop) => {
      const name = String(prop.name || '');
      return !name.startsWith('_') &&
             !name.includes('optionSetId') &&
             !name.includes('hc_default') &&
             !name.includes('copy');
    });

    if (cleanProps.length === 0) continue;
    hasAny = true;

    formatted += `${item.title}:\n`;

    for (const prop of cleanProps) {
      let value = String(prop.value ?? '');
      // Remove measurement details like "(12.3 mm ...)"
      value = value.replace(/\([^)]*\d+\.?\d*\s*mm[^)]*\)/gi, '').trim();
      formatted += `☐ ${prop.name}: ${value}\n`;
    }
    formatted += '\n';
  }

  return hasAny ? formatted : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// DETERMINE TAG TYPE (Charm vs Customization)
// ═══════════════════════════════════════════════════════════════════════════
function determineTagType(lineItems = []) {
  // Check if any item has "charm" in its properties
  for (const item of lineItems) {
    if (!item.properties || item.properties.length === 0) continue;

    // Check item title
    if (item.title && item.title.toLowerCase().includes('charm')) {
      return 'charm';
    }

    // Check properties
    for (const prop of item.properties) {
      const name = String(prop.name || '').toLowerCase();
      const value = String(prop.value || '').toLowerCase();
      
      if (name.includes('charm') || value.includes('charm')) {
        return 'charm';
      }
    }
  }

  // Default to customization if no charm found
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

    // Format customizations
    const formattedNote = formatTepoCustomizations(order.line_items);
    
    if (!formattedNote) {
      console.log('ℹ️  No customizations found, skipping');
      return res.status(200).send('OK');
    }
    
    console.log('✨ Formatted customizations');

    // Determine tag type (charm or customization)
    const tagType = determineTagType(order.line_items);
    console.log(`🏷️  Tag type: ${tagType}`);

    // Add to database queue
    await db.addOrder(
      order.id,
      order.name.replace('#', ''), // Strip # for ShipStation search
      formattedNote,
      tagType
    );

    console.log('💾 Order queued for processing');

    // Respond immediately
    res.status(200).send('OK');
    console.log('✅ Sent 200 OK to Shopify\n');

  } catch (error) {
    console.error('💥 Webhook error:', error.message);
    if (!res.headersSent) res.status(200).send('OK');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🚀 Webhook server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`📝 Webhook endpoint: POST /webhooks/shopify/orders/create`);
  console.log(`${'═'.repeat(80)}\n`);
  
  const missing = [];
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) missing.push('SHOPIFY_WEBHOOK_SECRET');
  
  if (missing.length > 0) {
    console.error(`⚠️  Missing env vars: ${missing.join(', ')}`);
  } else {
    console.log('✅ All environment variables set');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing database...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, closing database...');
  db.close();
  process.exit(0);
});
