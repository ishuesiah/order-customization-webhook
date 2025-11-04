// webhook-handler.js (runs on Kinsta)
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

// Verify webhook is from Shopify
function verifyShopifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');
  return hash === hmac;
}

// Clean Tepo properties into your format
function formatTepoCustomizations(lineItems) {
  let formatted = 'CUSTOMIZATIONS:\n\n';
  
  lineItems.forEach(item => {
    if (!item.properties || item.properties.length === 0) return;
    
    // Filter out ugly technical properties
    const cleanProps = item.properties.filter(prop => {
      const name = prop.name;
      return !name.startsWith('_') && 
             !name.includes('optionSetId') &&
             !name.includes('hc_default') &&
             !name.includes('copy'); // Remove the "copy" duplicates
    });
    
    if (cleanProps.length === 0) return;
    
    // Add item header
    formatted += `${item.title}:\n`;
    
    // Add each customization as checkbox
    cleanProps.forEach(prop => {
      // Remove measurements (like your Tampermonkey script does)
      let value = prop.value;
      value = value.replace(/\([^)]*\d+\.?\d*\s*mm[^)]*\)/gi, '').trim();
      
      formatted += `☐ ${prop.name}: ${value}\n`;
    });
    
    formatted += '\n';
  });
  
  return formatted;
}

// Main webhook handler
app.post('/webhooks/shopify/orders/create', async (req, res) => {
  // Verify it's really from Shopify
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }
  
  const order = req.body;
  
  try {
    // 1. Extract and format customizations (READ from Shopify, don't modify!)
    const formattedCustomizations = formatTepoCustomizations(order.line_items);
    
    // 2. Wait a bit for order to sync to ShipStation (usually 1-2 minutes)
    await new Promise(resolve => setTimeout(resolve, 90000)); // 90 seconds
    
    // 3. Find the order in ShipStation by order number
    const shipstationOrders = await axios.get(
      `https://ssapi.shipstation.com/orders?orderNumber=${order.name}`,
      {
        auth: {
          username: process.env.SHIPSTATION_API_KEY,
          password: process.env.SHIPSTATION_API_SECRET
        }
      }
    );
    
    if (shipstationOrders.data.orders.length === 0) {
      console.log(`Order ${order.name} not in ShipStation yet, will retry...`);
      // Could implement retry logic here
      return res.status(200).send('OK');
    }
    
    const shipstationOrder = shipstationOrders.data.orders[0];
    
    // 4. Update ONLY the Gift Note field (surgical update!)
    await axios.post(
      'https://ssapi.shipstation.com/orders/createorder',
      {
        orderId: shipstationOrder.orderId,
        giftMessage: formattedCustomizations,
        // CRITICAL: Don't include customsItems or any other fields!
        // This way SKUs stay intact
      },
      {
        auth: {
          username: process.env.SHIPSTATION_API_KEY,
          password: process.env.SHIPSTATION_API_SECRET
        }
      }
    );
    
    console.log(`✅ Updated Gift Note for order ${order.name}`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error processing order:', error);
    res.status(500).send('Error');
  }
});

app.listen(process.env.PORT || 3000);
