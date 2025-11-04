// database.js
// SQLite database for webhook job queue

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database file location
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'webhook-queue.db');

class Database {
  constructor() {
    this.db = null;
  }

  // Initialize database connection and create tables
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          console.error('❌ Error opening database:', err);
          reject(err);
          return;
        }
        
        console.log(`✅ Connected to SQLite database: ${DB_PATH}`);
        this.createTables()
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  // Create tables if they don't exist
  async createTables() {
    const createOrdersTable = `
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
    `;

    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_order_number ON orders(order_number);
      CREATE INDEX IF NOT EXISTS idx_created_at ON orders(created_at);
    `;

    return new Promise((resolve, reject) => {
      this.db.exec(createOrdersTable + createIndexes, (err) => {
        if (err) {
          console.error('❌ Error creating tables:', err);
          reject(err);
          return;
        }
        console.log('✅ Database tables ready');
        resolve();
      });
    });
  }

  // Add a new order to the queue
  async addOrder(shopifyOrderId, orderNumber, formattedNote, tagType) {
    const sql = `
      INSERT INTO orders (shopify_order_id, order_number, formatted_note, tag_type, status)
      VALUES (?, ?, ?, ?, 'pending')
      ON CONFLICT(shopify_order_id) DO UPDATE SET
        formatted_note = excluded.formatted_note,
        tag_type = excluded.tag_type,
        updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [shopifyOrderId, orderNumber, formattedNote, tagType], function(err) {
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

  // Get all pending orders
  async getPendingOrders(limit = 50) {
    const sql = `
      SELECT * FROM orders 
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [limit], (err, rows) => {
        if (err) {
          console.error('❌ Error getting pending orders:', err);
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  // Update order status
  async updateOrderStatus(id, status, shipstationOrderId = null, errorMessage = null) {
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

    return new Promise((resolve, reject) => {
      this.db.run(sql, [status, shipstationOrderId, errorMessage, id], (err) => {
        if (err) {
          console.error('❌ Error updating order status:', err);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  // Get statistics
  async getStats() {
    const sql = `
      SELECT 
        status,
        COUNT(*) as count,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM orders
      GROUP BY status
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          console.error('❌ Error getting stats:', err);
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  // Get recent orders (for admin page)
  async getRecentOrders(limit = 100) {
    const sql = `
      SELECT * FROM orders 
      ORDER BY created_at DESC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [limit], (err, rows) => {
        if (err) {
          console.error('❌ Error getting recent orders:', err);
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  // Delete old completed orders (cleanup)
  async deleteOldCompletedOrders(daysOld = 30) {
    const sql = `
      DELETE FROM orders 
      WHERE status = 'completed' 
      AND updated_at < datetime('now', '-' || ? || ' days')
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [daysOld], function(err) {
        if (err) {
          console.error('❌ Error deleting old orders:', err);
          reject(err);
          return;
        }
        console.log(`🗑️ Deleted ${this.changes} old completed orders`);
        resolve(this.changes);
      });
    });
  }

  // Close database connection
  close() {
    if (this.db) {
      this.db.close((err) => {
        if (err) {
          console.error('❌ Error closing database:', err);
        } else {
          console.log('✅ Database connection closed');
        }
      });
    }
  }
}

module.exports = { Database };
