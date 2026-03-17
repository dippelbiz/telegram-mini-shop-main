require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ==================== API ====================

// Получение всех товаров с вариантами
app.get('/api/products', async (req, res) => {
  try {
    // Получаем все продукты
    const products = await pool.query(`
      SELECT id, name, description, image, category 
      FROM products 
      ORDER BY id
    `);
    
    // Получаем все варианты с дополнительной информацией
    const variants = await pool.query(`
      SELECT 
        v.id, 
        v.product_id, 
        v.name, 
        v.price, 
        v.weight_kg, 
        v.packaging_cost,
        v.sort_order,
        v.is_active,
        p.purchase_price_kg
      FROM product_variants v
      JOIN products p ON v.product_id = p.id
      ORDER BY v.product_id, v.sort_order
    `);
    
    // Группируем варианты по product_id и рассчитываем price_seller
    const variantsByProduct = {};
    variants.rows.forEach(v => {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      
      // Рассчитываем price_seller по формуле
      const base_cost = (v.purchase_price_kg * v.weight_kg) + (v.packaging_cost || 0);
      const avg_price = (v.price + base_cost) / 2;
      const price_seller = Math.ceil(avg_price / 10) * 10;
      
      // Добавляем рассчитанное поле к варианту
      variantsByProduct[v.product_id].push({
        id: v.id,
        name: v.name,
        price: v.price,
        price_seller: price_seller,
        weight_kg: v.weight_kg,
        packaging_cost: v.packaging_cost,
        sort_order: v.sort_order,
        is_active: v.is_active
      });
    });

    // Формируем результат
    const result = products.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      image: p.image,
      category: p.category,
      variants: variantsByProduct[p.id] || []
    }));
    
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение корзины пользователя
app.get('/api/cart/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query(`
      SELECT 
        c.product_id, c.variant_id, c.quantity, c.price_at_time,
        p.name, p.description, p.image,
        v.name as variant_name, v.price
      FROM carts c
      JOIN products p ON c.product_id = p.id
      LEFT JOIN product_variants v ON c.variant_id = v.id
      WHERE c.user_id = $1
    `, [userId]);

    const items = result.rows.map(row => ({
      productId: row.product_id,
      variantId: row.variant_id,
      quantity: row.quantity,
      priceAtTime: row.price_at_time,
      name: row.name,
      variantName: row.variant_name,
      price: row.price,
      description: row.description,
      image: row.image
    }));

    res.json({ userId, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Добавление товара в корзину
app.post('/api/cart/add', async (req, res) => {
  const { userId, productId, variantId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numVariantId = parseInt(variantId, 10);
  const numQuantity = parseInt(quantity, 10);

  try {
    // Проверяем существование и активность варианта
    const variant = await pool.query(
      'SELECT price, is_active FROM product_variants WHERE id = $1 AND product_id = $2',
      [numVariantId, numProductId]
    );
    if (variant.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid variant' });
    }
    if (!variant.rows[0].is_active) {
      return res.status(400).json({ error: 'Variant is not active' });
    }
    const price = variant.rows[0].price;

    await pool.query(`
      INSERT INTO carts (user_id, product_id, variant_id, quantity, price_at_time)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, product_id, variant_id)
      DO UPDATE SET quantity = carts.quantity + EXCLUDED.quantity
    `, [numUserId, numProductId, numVariantId, numQuantity, price]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновление количества
app.post('/api/cart/update', async (req, res) => {
  const { userId, productId, variantId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numVariantId = parseInt(variantId, 10);
  const numQuantity = parseInt(quantity, 10);

  if (numQuantity < 0) return res.status(400).json({ error: 'Quantity must be non-negative' });

  try {
    if (numQuantity === 0) {
      await pool.query(
        'DELETE FROM carts WHERE user_id = $1 AND product_id = $2 AND variant_id = $3',
        [numUserId, numProductId, numVariantId]
      );
    } else {
      await pool.query(`
        UPDATE carts SET quantity = $1
        WHERE user_id = $2 AND product_id = $3 AND variant_id = $4
      `, [numQuantity, numUserId, numProductId, numVariantId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Удаление из корзины
app.delete('/api/cart/remove', async (req, res) => {
  const { userId, productId, variantId } = req.body;
  try {
    await pool.query(
      'DELETE FROM carts WHERE user_id = $1 AND product_id = $2 AND variant_id = $3',
      [userId, productId, variantId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение заказов пользователя
app.get('/api/orders/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновление статуса заказа
app.put('/api/order/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;

  const allowed = ['Активный', 'Завершен', 'Отменен'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const order = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status !== 'Активный' && status !== order.rows[0].status) {
      return res.status(400).json({ error: 'Cannot change non-active order' });
    }

    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    
    // Если заказ отменён, уведомляем бота
    if (status === 'Отменен') {
      const orderData = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const orderInfo = orderData.rows[0];
      
      if (process.env.BOT_URL) {
        try {
          await fetch(`${process.env.BOT_URL}/api/order-cancelled`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId: orderId,
              orderNumber: orderInfo.order_number,
              userId: orderInfo.user_id,
              sellerId: orderInfo.seller_id
            })
          });
          console.log(`✅ Уведомление об отмене заказа ${orderInfo.order_number} отправлено в бот`);
        } catch (err) {
          console.error('❌ Ошибка отправки уведомления об отмене в бот:', err);
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение точек самовывоза
app.get('/api/pickup-locations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT district, address, sort_order FROM pickup_locations ORDER BY district, sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Создание заказа
app.post('/api/order', async (req, res) => {
  try {
    const data = req.body;
    if (!data) {
      return res.status(400).json({ error: 'No data' });
    }

    const userId = data.userId;
    const buyer_name = data.contact?.name || 'Покупатель';
    const items = data.items;
    const total = data.total;
    const address = data.contact?.address;
    const payment = data.contact?.paymentMethod;
    const delivery = data.contact?.deliveryType;
    const contact = data.contact;
    const request_id = data.requestId;

    if (!userId || !items || !total || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`Получен запрос на новый заказ: delivery=${delivery}, address=${address}`);

    // Проверка на дубликат
    if (request_id) {
      const existing = await pool.query('SELECT id FROM orders WHERE request_id = $1', [request_id]);
      if (existing.rows.length > 0) {
        console.log(`⚠️ Дублирующийся запрос с requestId ${request_id} отклонён`);
        return res.status(409).json({ error: 'Duplicate order' });
      }
    }

    // Получаем seller_id из точки самовывоза
    let seller_id = null;
    let address_id = null;
    let prefix = null;
    
    if (delivery === 'pickup') {
      const addrResult = await pool.query(
        'SELECT id, seller_id, prefix FROM pickup_locations WHERE address = $1', 
        [address]
      );
      if (addrResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid pickup address' });
      }
      address_id = addrResult.rows[0].id;
      seller_id = addrResult.rows[0].seller_id;
      prefix = addrResult.rows[0].prefix;
    } else {
      // Для доставки - администратор (id=6)
      seller_id = 6;
      prefix = 'D';
    }

    // Получаем информацию о продавце
    const seller = await pool.query('SELECT name FROM sellers WHERE id = $1', [seller_id]);
    const seller_name = seller.rows[0]?.name || 'Неизвестный';

    // Получаем содержимое корзины
    const cartResult = await pool.query(`
      SELECT 
        c.product_id, c.variant_id, c.quantity, c.price_at_time,
        p.name,
        v.name as variant_name
      FROM carts c
      JOIN products p ON c.product_id = p.id
      LEFT JOIN product_variants v ON c.variant_id = v.id
      WHERE c.user_id = $1
    `, [userId]);

    if (cartResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    let total_sum = 0;
    const orderItems = cartResult.rows.map(row => {
      const itemTotal = row.price_at_time * row.quantity;
      total_sum += itemTotal;
      return {
        productId: row.product_id,
        variantId: row.variant_id,
        name: row.name,
        variantName: row.variant_name,
        quantity: row.quantity,
        price: row.price_at_time,
      };
    });

    // Генерируем номер заказа
    const order_number = await generateOrderNumber(prefix);

    const itemsJson = JSON.stringify(orderItems);
    const contactJson = JSON.stringify(contact);

    // Вставляем заказ
    const insertResult = await pool.query(`
      INSERT INTO orders (order_number, user_id, seller_id, address_id, items, total, contact, status, request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [order_number, userId, seller_id, address_id, itemsJson, total_sum, contactJson, 'Активный', request_id]);

    const orderId = insertResult.rows[0].id;

    // Очищаем корзину
    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId]);

    console.log('Новый заказ:', { id: orderId, userId, items: orderItems, total: total_sum, contact, seller_id, address_id, request_id, order_number });

    // Отправка заказа в бота
    let orderNumberFromBot = null;
    if (process.env.BOT_URL) {
      const botOrderData = {
        userId: userId,
        name: buyer_name,
        items: orderItems,
        total: total_sum,
        address: address,
        paymentMethod: payment,
        deliveryType: delivery,
        contact: contact,
        requestId: request_id
      };
      try {
        const botUrl = process.env.BOT_URL;
        console.log(`Отправка заказа в бота: ${botUrl}/api/new-order`);
        
        const botResponse = await fetch(`${botUrl}/api/new-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(botOrderData)
        });
        
        if (botResponse.ok) {
          const botData = await botResponse.json();
          if (botData.orderNumber) {
            orderNumberFromBot = botData.orderNumber;
            await pool.query('UPDATE orders SET order_number = $1 WHERE id = $2', [orderNumberFromBot, orderId]);
          }
          console.log(`✅ Заказ отправлен в бота, получен номер: ${orderNumberFromBot}`);
        } else {
          const errorText = await botResponse.text();
          console.error(`❌ Бот вернул ошибку ${botResponse.status}: ${errorText.substring(0, 200)}`);
        }
      } catch (err) {
        console.error(`❌ Ошибка отправки в бота: ${err.message}`);
      }
    }

    // Возвращаем клиенту номер заказа (строку с префиксом)
    res.json({ orderNumber: order_number });

  } catch (err) {
    console.error('❌ Ошибка в /api/order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Вспомогательная функция для генерации номера заказа
async function generateOrderNumber(prefix) {
  if (!prefix) {
    console.error('generateOrderNumber: prefix is null, using X');
    prefix = 'X';
  }
  
  // Обрезаем до 3 символов
  if (prefix.length > 3) {
    prefix = prefix.substring(0, 3);
  }
  
  const result = await pool.query(
    `SELECT order_number FROM orders 
     WHERE order_number LIKE $1 
     ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  
  if (result.rows.length > 0) {
    const lastNum = result.rows[0].order_number.substring(prefix.length);
    const num = parseInt(lastNum) || 0;
    return prefix + (num + 1);
  } else {
    return prefix + '1';
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
