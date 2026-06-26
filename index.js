const { ObjectId } = require("mongodb");
const express = require("express");
const app = express();
const dotenv = require("dotenv");
dotenv.config();
const cors = require("cors");
const port = process.env.PORT || 5000;
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("reselll_hub_db");

    const sellerCollection = db.collection("sellerProducts");
    const wishlistCollection = db.collection("wishlist");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    // ─── Products ────────────────────────────────────────────────────────────

    app.get("/api/products", async (req, res) => {
      const { category, condition, search, sort } = req.query;
      const query = { status: "available" };
      if (category) query.category = category;
      if (condition) query.condition = condition;
      if (search) query.title = { $regex: search, $options: "i" };
      let sortOption = { createdAt: -1 };
      if (sort === "price_asc") sortOption = { price: 1 };
      if (sort === "price_desc") sortOption = { price: -1 };
      const result = await sellerCollection
        .find(query)
        .sort(sortOption)
        .toArray();
      res.send(result);
    });

    app.get("/api/products/:id", async (req, res) => {
      const result = await sellerCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.send(result);
    });

    // ─── Seller Products ─────────────────────────────────────────────────────

    app.get("/api/sellerProducts/:email", async (req, res) => {
      const result = await sellerCollection
        .find({ "sellerInfo.email": req.params.email })
        .toArray();
      res.send(result);
    });

    app.get("/api/sellerProducts/product/:id", async (req, res) => {
      const result = await sellerCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.send(result);
    });

    app.post("/api/addedProduct", async (req, res) => {
      const {
        title,
        description,
        category,
        condition,
        price,
        quantity,
        images,
        sellerInfo,
      } = req.body;
      const result = await sellerCollection.insertOne({
        title,
        description,
        category,
        condition,
        price: Number(price),
        quantity: Number(quantity),
        images,
        sellerInfo,
        status: "available",
        createdAt: new Date(),
      });
      res.send(result);
    });

    app.put("/api/sellerProducts/:id", async (req, res) => {
      const {
        title,
        category,
        condition,
        price,
        quantity,
        description,
        images,
        status,
      } = req.body;
      const result = await sellerCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            title,
            category,
            condition,
            price: Number(price),
            quantity: Number(quantity),
            description,
            images,
            status,
            updatedAt: new Date(),
          },
        },
      );
      res.send(result);
    });

    app.delete("/api/sellerProducts/:id", async (req, res) => {
      const result = await sellerCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // ─── Wishlist ─────────────────────────────────────────────────────────────

    app.post("/api/wishlist", async (req, res) => {
      try {
        const {
          productId,
          userId,
          userEmail,
          title,
          price,
          image,
          sellerInfo,
        } = req.body;
        if (!productId || (!userId && !userEmail)) {
          return res
            .status(400)
            .json({ error: "productId and userId or userEmail are required" });
        }
        const existing = await wishlistCollection.findOne({
          productId,
          $or: [
            userId ? { userId } : null,
            userEmail ? { userEmail } : null,
          ].filter(Boolean),
        });
        if (existing)
          return res.status(409).json({ error: "Already in wishlist" });
        const result = await wishlistCollection.insertOne({
          productId,
          userId: userId || "",
          userEmail: userEmail || "",
          title: title || "",
          price: Number(price) || 0,
          image: image || "",
          sellerInfo: sellerInfo || null,
          createdAt: new Date(),
        });
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/api/wishlist/user/:userId", async (req, res) => {
      try {
        const result = await wishlistCollection
          .find({ userId: req.params.userId })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/api/wishlist/:email", async (req, res) => {
      try {
        const result = await wishlistCollection
          .find({ userEmail: req.params.email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.delete("/api/wishlist/:id", async (req, res) => {
      try {
        const result = await wishlistCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── Stripe ───────────────────────────────────────────────────────────────

    app.post("/api/create-checkout-session", async (req, res) => {
      const {
        productId,
        productTitle,
        productImage,
        price,
        buyerEmail,
        buyerName,
        buyerId,
        sellerId,
        sellerName,
        sellerEmail,
      } = req.body;
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          customer_email: buyerEmail,
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: productTitle,
                  images: productImage ? [productImage] : [],
                },
                unit_amount: Math.round(price * 100),
              },
              quantity: 1,
            },
          ],
          metadata: {
            productId,
            buyerId,
            buyerName,
            buyerEmail,
            sellerId,
            sellerName,
            sellerEmail,
            productTitle,
            price: String(price),
          },
          success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/products/${productId}`,
        });
        res.json({ url: session.url, sessionId: session.id });
      } catch (err) {
        console.error("Stripe error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/api/orders/confirm", async (req, res) => {
      const { sessionId } = req.body;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res.status(400).json({ error: "Payment not completed" });
        }
        const existing = await ordersCollection.findOne({
          stripeSessionId: sessionId,
        });
        if (existing) {
          return res.json({
            success: true,
            orderId: existing._id.toString(),
            alreadyExists: true,
          });
        }
        const meta = session.metadata;
        const order = {
          buyerInfo: {
            userId: meta.buyerId,
            name: meta.buyerName,
            email: meta.buyerEmail,
          },
          sellerInfo: {
            userId: meta.sellerId,
            name: meta.sellerName,
            email: meta.sellerEmail,
          },
          productId: meta.productId,
          productTitle: meta.productTitle,
          price: parseFloat(meta.price),
          paymentStatus: "paid",
          orderStatus: "pending", // ← FIXED: was "processing"
          stripeSessionId: sessionId,
          createdAt: new Date(),
        };
        const orderResult = await ordersCollection.insertOne(order);
        const orderId = orderResult.insertedId.toString();
        await paymentsCollection.insertOne({
          orderId,
          transactionId: session.payment_intent,
          amount: session.amount_total / 100,
          paymentStatus: "success",
          stripeSessionId: sessionId,
          createdAt: new Date(),
        });
        await sellerCollection.updateOne(
          { _id: new ObjectId(meta.productId) },
          { $set: { status: "sold" } },
        );
        res.json({ success: true, orderId });
      } catch (err) {
        console.error("Order confirm error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Orders ───────────────────────────────────────────────────────────────
    // IMPORTANT: specific routes must come before /api/orders/:id

    app.get("/api/orders/buyer/:email", async (req, res) => {
      try {
        const result = await ordersCollection
          .find({ "buyerInfo.email": req.params.email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/orders/seller/:email", async (req, res) => {
      try {
        const result = await ordersCollection
          .find({ "sellerInfo.email": req.params.email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET single order — AFTER the specific routes above
    app.get("/api/orders/:id", async (req, res) => {
      try {
        const result = await ordersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!result) return res.status(404).json({ error: "Order not found" });
        res.send(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PATCH cancel order — buyer cancels while still "pending"
    app.patch("/api/orders/:id/cancel", async (req, res) => {
      try {
        const order = await ordersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.orderStatus !== "pending") {
          return res.status(400).json({
            error: `Cannot cancel an order with status: ${order.orderStatus}`,
          });
        }
        await ordersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { orderStatus: "cancelled", updatedAt: new Date() } },
        );
        await sellerCollection.updateOne(
          { _id: new ObjectId(order.productId) },
          { $set: { status: "available" } },
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PATCH seller updates order status
    app.patch("/api/orders/:id/status", async (req, res) => {
      try {
        const { status } = req.body;
        const ALLOWED = [
          "pending",
          "accepted",
          "cancelled",
          "shipped",
          "delivered",
        ];
        if (!ALLOWED.includes(status)) {
          return res.status(400).json({ error: `Invalid status: ${status}` });
        }
        const order = await ordersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!order) return res.status(404).json({ error: "Order not found" });

        const TRANSITIONS = {
          pending: ["accepted", "cancelled"],
          accepted: ["shipped"],
          shipped: ["delivered"],
          delivered: [],
          cancelled: [],
        };

        const current = order.orderStatus;
        if (!TRANSITIONS[current]?.includes(status)) {
          return res
            .status(400)
            .json({ error: `Cannot move from "${current}" to "${status}"` });
        }

        await ordersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { orderStatus: status, updatedAt: new Date() } },
        );
        res.json({ success: true, orderStatus: status });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Payments ─────────────────────────────────────────────────────────────

    app.get("/api/payments/buyer/:email", async (req, res) => {
      try {
        const buyerOrders = await ordersCollection
          .find({ "buyerInfo.email": req.params.email })
          .toArray();
        if (buyerOrders.length === 0) return res.json([]);
        const orderIds = buyerOrders.map((o) => o._id.toString());
        const payments = await paymentsCollection
          .find({ orderId: { $in: orderIds } })
          .sort({ createdAt: -1 })
          .toArray();
        const enriched = payments.map((payment) => {
          const order = buyerOrders.find(
            (o) => o._id.toString() === payment.orderId,
          );
          return {
            ...payment,
            productTitle: order?.productTitle || "Unknown product",
            orderStatus: order?.orderStatus || "—",
          };
        });
        res.json(enriched);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Buyer Summary ────────────────────────────────────────────────────────

    app.get("/api/buyer/summary/:email", async (req, res) => {
      try {
        const [orders, wishlist] = await Promise.all([
          ordersCollection
            .find({ "buyerInfo.email": req.params.email })
            .sort({ createdAt: -1 })
            .toArray(),
          wishlistCollection.find({ userEmail: req.params.email }).toArray(),
        ]);
        res.json({
          totalOrders: orders.length,
          wishlistCount: wishlist.length,
          recentPurchases: orders.slice(0, 5),
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET seller analytics
    app.get("/api/seller/analytics/:email", async (req, res) => {
      try {
        const email = req.params.email;

        // All delivered/shipped orders for this seller
        const orders = await ordersCollection
          .find({
            "sellerInfo.email": email,
            orderStatus: { $in: ["delivered", "shipped", "accepted"] },
          })
          .toArray();

        // Total revenue & total orders
        const totalRevenue = orders.reduce((sum, o) => sum + (o.price || 0), 0);
        const totalOrders = orders.length;

        // Monthly sales trend (last 6 months)
        const now = new Date();
        const monthly = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const label = d.toLocaleString("en-US", {
            month: "short",
            year: "2-digit",
          });
          const monthOrders = orders.filter((o) => {
            const od = new Date(o.createdAt);
            return (
              od.getMonth() === d.getMonth() &&
              od.getFullYear() === d.getFullYear()
            );
          });
          monthly.push({
            month: label,
            revenue: monthOrders.reduce((sum, o) => sum + (o.price || 0), 0),
            orders: monthOrders.length,
          });
        }

        // Top selling products (by number of orders)
        const productMap = {};
        orders.forEach((o) => {
          const key = o.productTitle || "Unknown";
          if (!productMap[key])
            productMap[key] = { title: key, orders: 0, revenue: 0 };
          productMap[key].orders += 1;
          productMap[key].revenue += o.price || 0;
        });
        const topProducts = Object.values(productMap)
          .sort((a, b) => b.orders - a.orders)
          .slice(0, 5);

        // Order status breakdown
        const allOrders = await ordersCollection
          .find({ "sellerInfo.email": email })
          .toArray();

        const statusBreakdown = allOrders.reduce((acc, o) => {
          const s = o.orderStatus || "pending";
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});

        res.json({
          totalRevenue,
          totalOrders,
          monthly,
          topProducts,
          statusBreakdown,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Hello World!"));

app.listen(port, () => console.log(`Example app listening on port ${port}`));
