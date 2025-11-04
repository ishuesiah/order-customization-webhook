// worker.js
// Background worker that processes pending orders from the queue

const axios = require('axios');
const { Database } = require('./database');

const db = new Database();

// ShipStation API credentials
const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;

// How often to check for pending orders (milliseconds)
const POLL_INTERVAL = process.env.POLL_INTERVAL || 5 * 60 * 1000; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════
// SHIPSTATION API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create axios client for ShipStation API
 */
function createShipStationClient() {
  return axios.create({
    baseURL: 'https://ssapi.shipstation.com',
    auth: {
      username: SHIPSTATION_API_KEY,
      password: SHIPSTATION_API_SECRET
    },
    timeout: 15000
  });
}

/**
 * Search for order in ShipStation by order number
 */
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

/**
 * Get full order details from ShipStation
 */
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

/**
 * Update order gift message in ShipStation
 */
async function updateGiftMessage(orderId, giftMessage) {
  const client = createShipStationClient();
  
  try {
    // First, GET the complete order
    console.log(`  📝 Getting full order ${orderId}...`);
    const fullOrder = await getFullOrder(orderId);
    
    // Update only the gift message
    console.log(`  📝 Updating gift message...`);
    const updatedOrder = {
      ...fullOrder,
      giftMessage: giftMessage
    };
    
    await client.post('/orders/createorder', updatedOrder);
    console.log(`  ✅ Gift message updated`);
    
    return true;
  } catch (error) {
    console.error(`  ❌ Error updating gift message:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get tag ID by tag name
 */
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

/**
 * Add tag to order in ShipStation
 */
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
// ORDER PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process a single pending order
 */
async function processOrder(order) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`📦 Processing order ${order.order_number} (DB ID: ${order.id})`);
  console.log(`   Tag: ${order.tag_type}`);
  console.log(`   Attempts: ${order.attempts}`);
  
  try {
    // 1. Search for order in ShipStation
    console.log(`  🔍 Searching ShipStation for order ${order.order_number}...`);
    const shipstationOrder = await findShipStationOrder(order.order_number);
    
    if (!shipstationOrder) {
      console.log(`  ⏳ Order not in ShipStation yet, will retry later`);
      await db.updateOrderStatus(order.id, 'pending', null, 'Order not yet synced');
      return;
    }
    
    console.log(`  ✅ Found in ShipStation! Order ID: ${shipstationOrder.orderId}`);
    
    // 2. Update gift message
    await updateGiftMessage(shipstationOrder.orderId, order.formatted_note);
    
    // 3. Add tag
    const tagId = await getTagId(order.tag_type);
    
    if (tagId) {
      await addTagToOrder(shipstationOrder.orderId, tagId);
    } else {
      console.warn(`  ⚠️  Skipping tag (not found in ShipStation)`);
    }
    
    // 4. Mark as completed
    await db.updateOrderStatus(order.id, 'completed', shipstationOrder.orderId, null);
    
    console.log(`  🎉 Order ${order.order_number} completed successfully!`);
    
  } catch (error) {
    console.error(`  💥 Error processing order:`, error.message);
    
    // If we've tried too many times, mark as failed
    if (order.attempts >= 10) {
      await db.updateOrderStatus(order.id, 'failed', null, error.message);
      console.log(`  ❌ Order ${order.order_number} marked as failed after ${order.attempts + 1} attempts`);
    } else {
      await db.updateOrderStatus(order.id, 'pending', null, error.message);
      console.log(`  ⚠️  Order ${order.order_number} will retry later`);
    }
  }
}

/**
 * Process all pending orders
 */
async function processPendingOrders() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🔄 Checking for pending orders...`);
  console.log(`   Time: ${new Date().toLocaleString()}`);
  console.log(`${'═'.repeat(80)}`);
  
  try {
    const pendingOrders = await db.getPendingOrders(50);
    
    if (pendingOrders.length === 0) {
      console.log('✅ No pending orders to process');
      return;
    }
    
    console.log(`📋 Found ${pendingOrders.length} pending orders`);
    
    // Process each order
    for (const order of pendingOrders) {
      await processOrder(order);
      
      // Small delay between orders to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Show stats
    const stats = await db.getStats();
    console.log(`\n📊 Current Stats:`);
    stats.forEach(s => {
      console.log(`   ${s.status}: ${s.count}`);
    });
    
  } catch (error) {
    console.error('💥 Error in processing loop:', error);
  }
}

/**
 * Cleanup old completed orders (runs daily)
 */
async function cleanupOldOrders() {
  console.log('\n🗑️  Running cleanup of old completed orders...');
  try {
    const deleted = await db.deleteOldCompletedOrders(30); // Delete orders > 30 days old
    if (deleted > 0) {
      console.log(`✅ Cleaned up ${deleted} old orders`);
    }
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WORKER LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function startWorker() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🤖 ShipStation Worker Starting...`);
  console.log(`   Poll Interval: ${POLL_INTERVAL / 1000} seconds`);
  console.log(`   Database: ${process.env.DB_PATH || './webhook-queue.db'}`);
  console.log(`${'═'.repeat(80)}`);
  
  // Check environment variables
  if (!SHIPSTATION_API_KEY || !SHIPSTATION_API_SECRET) {
    console.error('❌ Missing ShipStation credentials!');
    console.error('   Set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET');
    process.exit(1);
  }
  
  // Initialize database
  await db.initialize();
  
  // Initial processing
  await processPendingOrders();
  
  // Set up recurring processing
  setInterval(processPendingOrders, POLL_INTERVAL);
  
  // Set up daily cleanup (runs every 24 hours)
  setInterval(cleanupOldOrders, 24 * 60 * 60 * 1000);
  
  console.log(`\n✅ Worker is running! Processing orders every ${POLL_INTERVAL / 1000} seconds...`);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  db.close();
  process.exit(0);
});

// Start the worker
startWorker().catch(error => {
  console.error('💥 Fatal error:', error);
  db.close();
  process.exit(1);
});
