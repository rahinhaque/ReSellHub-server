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

// ── Shared refund helper ──────────────────────────────────────────────────────
async function issueRefund(orderId, paymentsCollection, ordersCollection) {
  const payment = await paymentsCollection.findOne({ orderId });
  if (!payment) return { skipped: true, reason: "no payment found" };
  if (payment.paymentStatus === "refunded")
    return { skipped: true, reason: "already refunded" };
  if (!payment.transactionId)
    return { skipped: true, reason: "no transactionId" };

  const refund = await stripe.refunds.create({
    payment_intent: payment.transactionId,
  });

  await paymentsCollection.updateOne(
    { _id: payment._id },
    {
      $set: {
        paymentStatus: "refunded",
        refundId: refund.id,
        refundedAt: new Date(),
      },
    },
  );

  await ordersCollection.updateOne(
    { orderId },
    { $set: { paymentStatus: "refunded" } },
  );

  return { success: true, refundId: refund.id };
}

async function run() {
  try {
    await client.connect();

    const db = client.db("reselll_hub_db");

    // ── Collections ───────────────────────────────────────────────────────────
    const sellerCollection = db.collection("sellerProducts");
    const wishlistCollection = db.collection("wishlist");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("user");
    const sessionsCollection = db.collection("session"); // better-auth sessions

    // ── Active-user middleware ──────────────────────────────────────────────
    // The Next.js frontend has its own session-cookie auth (better-auth),
    // but this Express API has no awareness of who's calling it beyond
    // whatever the client sends in the body. At minimum, every mutation
    // route that's keyed off an email/userId should confirm that user
    // isn't blocked before doing anything. This checks status by email
    // since that's what most routes already receive from the client.
    //
    // NOTE: this is a stop-gap, not real authentication. The Express API
    // currently trusts whatever buyerEmail/sellerEmail the client sends —
    // there's no token/session verification here at all. That's a separate,
    // larger problem (anyone can call these endpoints with any email) and
    // should be addressed by validating the better-auth session token on
    // every request, ideally by sharing a verification call back to the
    // Next.js app or by switching to a single backend.
    async function requireActiveUserByEmail(email) {
      if (!email) return { ok: false, status: 400, error: "Email required" };
      const user = await usersCollection.findOne({ email });
      if (!user) return { ok: false, status: 404, error: "User not found" };
      if (user.status === "blocked") {
        return {
          ok: false,
          status: 403,
          error: "Your account has been blocked. Please contact support.",
        };
      }
      return { ok: true, user };
    }

    // ─── Products ─────────────────────────────────────────────────────────────

    // Replace the existing /api/products route
    // Replace the existing /api/products route
    app.get("/api/products", async (req, res) => {
      const {
        category,
        condition,
        search,
        sort,
        page = 1,
        limit = 10,
      } = req.query;
      const query = {
        status: "available",
        moderationStatus: "approved",
      };
      if (category) query.category = category;
      if (condition) query.condition = condition;
      if (search) query.title = { $regex: search, $options: "i" };

      let sortOption = { createdAt: -1 };
      if (sort === "price_asc") sortOption = { price: 1 };
      if (sort === "price_desc") sortOption = { price: -1 };

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.max(1, parseInt(limit));
      const skip = (pageNum - 1) * limitNum;

      const [result, total] = await Promise.all([
        sellerCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        sellerCollection.countDocuments(query),
      ]);

      res.json({
        products: result,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      });
    });

    app.get("/api/products/:id", async (req, res) => {
      const result = await sellerCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.send(result);
    });

    // ─── Seller Products ──────────────────────────────────────────────────────

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
      try {
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

        const check = await requireActiveUserByEmail(sellerInfo?.email);
        if (!check.ok)
          return res.status(check.status).json({ error: check.error });

        const result = await sellerCollection.insertOne({
          title,
          description,
          category,
          condition,
          price: Number(price),
          quantity: Number(quantity),
          images,
          sellerInfo,
          status: "pending", // ← not visible publicly until approved
          moderationStatus: "pending", // ← admin must approve
          isReported: false,
          createdAt: new Date(),
        });
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
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

        if (userEmail) {
          const check = await requireActiveUserByEmail(userEmail);
          if (!check.ok) {
            return res.status(check.status).json({ error: check.error });
          }
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

    // ─── Stripe Checkout ──────────────────────────────────────────────────────

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
        // Block check: a blocked user should not be able to spin up a new
        // Stripe checkout session even if they still hold a valid cookie.
        const check = await requireActiveUserByEmail(buyerEmail);
        if (!check.ok) {
          return res.status(check.status).json({ error: check.error });
        }

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
          orderStatus: "pending",
          stripeSessionId: sessionId,
          createdAt: new Date(),
        };
        const orderResult = await ordersCollection.insertOne(order);
        const orderId = orderResult.insertedId.toString();
        await paymentsCollection.insertOne({
          orderId,
          transactionId: session.payment_intent,
          amount: session.amount_total / 100,
          paymentStatus: "paid",
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
          {
            $set: {
              orderStatus: "cancelled",
              paymentStatus: "refunded",
              updatedAt: new Date(),
            },
          },
        );
        let refundResult = null;
        try {
          refundResult = await issueRefund(
            order._id.toString(),
            paymentsCollection,
            ordersCollection,
          );
        } catch (refundErr) {
          console.error(
            "Auto-refund failed (buyer cancel):",
            refundErr.message,
          );
        }
        await sellerCollection.updateOne(
          { _id: new ObjectId(order.productId) },
          { $set: { status: "available" } },
        );
        res.json({ success: true, refund: refundResult });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

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
        if (!TRANSITIONS[order.orderStatus]?.includes(status)) {
          return res.status(400).json({
            error: `Cannot move from "${order.orderStatus}" to "${status}"`,
          });
        }
        const updateFields = { orderStatus: status, updatedAt: new Date() };
        if (status === "cancelled") updateFields.paymentStatus = "refunded";
        await ordersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: updateFields },
        );
        let refundResult = null;
        if (status === "cancelled") {
          try {
            refundResult = await issueRefund(
              order._id.toString(),
              paymentsCollection,
              ordersCollection,
            );
          } catch (refundErr) {
            console.error(
              "Auto-refund failed (seller cancel):",
              refundErr.message,
            );
          }
          await sellerCollection.updateOne(
            { _id: new ObjectId(order.productId) },
            { $set: { status: "available" } },
          );
        }
        res.json({ success: true, orderStatus: status, refund: refundResult });
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
          let paymentStatus = payment.paymentStatus;
          if (order) {
            if (order.orderStatus === "cancelled") {
              paymentStatus = "refunded";
            } else if (
              ["pending", "accepted", "shipped", "delivered"].includes(
                order.orderStatus,
              )
            ) {
              paymentStatus = "paid";
            }
          }
          return {
            ...payment,
            paymentStatus,
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

    // ─── Seller Analytics ─────────────────────────────────────────────────────

    app.get("/api/seller/analytics/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const orders = await ordersCollection
          .find({
            "sellerInfo.email": email,
            orderStatus: { $in: ["delivered", "shipped", "accepted"] },
          })
          .toArray();
        const totalRevenue = orders.reduce((sum, o) => sum + (o.price || 0), 0);
        const totalOrders = orders.length;
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

    // ─── Admin Overview ───────────────────────────────────────────────────────

    app.get("/api/admin/overview", async (req, res) => {
      try {
        const [totalUsers, totalProducts, totalOrders] = await Promise.all([
          usersCollection.countDocuments(),
          sellerCollection.countDocuments(),
          ordersCollection.countDocuments(),
        ]);
        res.json({ totalUsers, totalProducts, totalOrders });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Admin Users ──────────────────────────────────────────────────────────

    app.get("/api/admin/users", async (req, res) => {
      try {
        const users = await usersCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json(users);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ✅ Block/unblock user — wipes active sessions when blocking.
    //
    // FIXED: this user collection has NO separate `id` field — only `_id`.
    // better-auth's session.userId stores the Mongo _id as a string, so the
    // session-wipe query must match on that, not on a nonexistent `user.id`.
    app.patch("/api/admin/users/:id/status", async (req, res) => {
      try {
        const { status } = req.body; // "active" or "blocked"
        const userObjectId = new ObjectId(req.params.id);

        // 1. Update the user's status
        await usersCollection.updateOne(
          { _id: userObjectId },
          { $set: { status, updatedAt: new Date() } },
        );

        // 2. If blocking, delete all of this user's active sessions so any
        // existing logged-in tab/device is kicked out immediately, not just
        // blocked from creating *new* sessions.
        if (status === "blocked") {
          await sessionsCollection.deleteMany({
            userId: req.params.id, // session.userId is the _id as a string
          });
        }

        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete("/api/admin/users/:id", async (req, res) => {
      try {
        const userObjectId = new ObjectId(req.params.id);
        const result = await usersCollection.deleteOne({ _id: userObjectId });
        // Clean up any lingering sessions for a deleted user too.
        await sessionsCollection.deleteMany({ userId: req.params.id });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Admin Product Moderation ─────────────────────────────────────────────

    // GET all products for admin (all statuses, all moderation states)
    app.get("/api/admin/products", async (req, res) => {
      try {
        const { moderation, search } = req.query;
        const query = {};
        if (moderation) query.moderationStatus = moderation;
        if (search) query.title = { $regex: search, $options: "i" };
        const result = await sellerCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PATCH — approve or reject a product
    app.patch("/api/admin/products/:id/moderate", async (req, res) => {
      try {
        const { moderationStatus } = req.body; // "approved" | "rejected"
        const ALLOWED = ["approved", "rejected", "pending"];
        if (!ALLOWED.includes(moderationStatus)) {
          return res.status(400).json({ error: "Invalid moderationStatus" });
        }

        // If approved → set status available; if rejected → set status unavailable
        const statusMap = {
          approved: "available",
          rejected: "rejected",
          pending: "pending",
        };

        await sellerCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: {
              moderationStatus,
              status: statusMap[moderationStatus],
              moderatedAt: new Date(),
            },
          },
        );
        res.json({ success: true, moderationStatus });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // DELETE — admin hard deletes a product
    app.delete("/api/admin/products/:id", async (req, res) => {
      try {
        const result = await sellerCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Reports ──────────────────────────────────────────────────────────────

    // POST — buyer reports a product
    app.post("/api/reports", async (req, res) => {
      try {
        const reportsCollection = db.collection("reports");
        const { productId, productTitle, reporterEmail, reason, details } =
          req.body;
        if (!productId || !reporterEmail || !reason) {
          return res.status(400).json({
            error: "productId, reporterEmail and reason are required",
          });
        }

        // Prevent duplicate reports from same user
        const existing = await reportsCollection.findOne({
          productId,
          reporterEmail,
        });
        if (existing) {
          return res
            .status(409)
            .json({ error: "You have already reported this product" });
        }

        const result = await reportsCollection.insertOne({
          productId,
          productTitle: productTitle || "",
          reporterEmail,
          reason,
          details: details || "",
          status: "open", // open | reviewed | dismissed
          createdAt: new Date(),
        });

        // Flag the product as reported
        await sellerCollection.updateOne(
          { _id: new ObjectId(productId) },
          { $set: { isReported: true } },
        );

        res.json({ success: true, insertedId: result.insertedId });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET all reports (admin)
    app.get("/api/reports", async (req, res) => {
      try {
        const reportsCollection = db.collection("reports");
        const result = await reportsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PATCH — admin updates report status
    app.patch("/api/reports/:id", async (req, res) => {
      try {
        const reportsCollection = db.collection("reports");
        const { status } = req.body; // "reviewed" | "dismissed"
        await reportsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status, reviewedAt: new Date() } },
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET all orders (admin)
    app.get("/api/admin/orders", async (req, res) => {
      try {
        const { status, search } = req.query;
        const query = {};
        if (status) query.orderStatus = status;
        if (search) {
          query.$or = [
            { productTitle: { $regex: search, $options: "i" } },
            { "buyerInfo.email": { $regex: search, $options: "i" } },
            { "sellerInfo.email": { $regex: search, $options: "i" } },
          ];
        }
        const result = await ordersCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PATCH — admin force-updates any order to any status + optional refund
    app.patch("/api/admin/orders/:id/resolve", async (req, res) => {
      try {
        const { orderStatus, issueRefundNow } = req.body;

        const ALLOWED = [
          "pending",
          "accepted",
          "shipped",
          "delivered",
          "cancelled",
        ];
        if (!ALLOWED.includes(orderStatus)) {
          return res.status(400).json({ error: "Invalid status" });
        }

        const order = await ordersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!order) return res.status(404).json({ error: "Order not found" });

        // Admin can force any transition — no TRANSITIONS check
        await ordersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: {
              orderStatus,
              updatedAt: new Date(),
              adminResolved: true,
              ...(orderStatus === "cancelled" && { paymentStatus: "refunded" }),
            },
          },
        );

        // Restore product if cancelled
        if (orderStatus === "cancelled") {
          await sellerCollection.updateOne(
            { _id: new ObjectId(order.productId) },
            { $set: { status: "available" } },
          );
        }

        // Issue refund if requested
        let refundResult = null;
        if (issueRefundNow) {
          try {
            refundResult = await issueRefund(
              order._id.toString(),
              paymentsCollection,
              ordersCollection,
            );
          } catch (err) {
            console.error("Admin refund failed:", err.message);
            refundResult = { skipped: true, reason: err.message };
          }
        }

        res.json({ success: true, orderStatus, refund: refundResult });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/admin/analytics", async (req, res) => {
      try {
        const now = new Date();

        // ── Monthly data (last 6 months) ──────────────────────────────────────
        const monthly = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const nextMonth = new Date(
            now.getFullYear(),
            now.getMonth() - i + 1,
            1,
          );
          const label = d.toLocaleString("en-US", {
            month: "short",
            year: "2-digit",
          });

          const [newUsers, newOrders] = await Promise.all([
            usersCollection.countDocuments({
              createdAt: { $gte: d, $lt: nextMonth },
            }),
            ordersCollection.countDocuments({
              createdAt: { $gte: d, $lt: nextMonth },
            }),
          ]);

          const revenueOrders = await ordersCollection
            .find({
              createdAt: { $gte: d, $lt: nextMonth },
              orderStatus: "delivered",
            })
            .toArray();

          monthly.push({
            month: label,
            users: newUsers,
            orders: newOrders,
            revenue: revenueOrders.reduce((sum, o) => sum + (o.price || 0), 0),
          });
        }

        // ── Category performance ───────────────────────────────────────────────
        const allProducts = await sellerCollection.find({}).toArray();
        const categoryMap = {};
        allProducts.forEach((p) => {
          const cat = p.category || "Uncategorized";
          if (!categoryMap[cat])
            categoryMap[cat] = { category: cat, products: 0, sold: 0 };
          categoryMap[cat].products += 1;
          if (p.status === "sold") categoryMap[cat].sold += 1;
        });
        const categoryPerformance = Object.values(categoryMap)
          .sort((a, b) => b.products - a.products)
          .slice(0, 6);

        // ── Platform summary ───────────────────────────────────────────────────
        const [totalUsers, totalProducts, totalOrders] = await Promise.all([
          usersCollection.countDocuments(),
          sellerCollection.countDocuments(),
          ordersCollection.countDocuments(),
        ]);

        const allOrders = await ordersCollection.find({}).toArray();
        const totalRevenue = allOrders
          .filter((o) => o.orderStatus === "delivered")
          .reduce((sum, o) => sum + (o.price || 0), 0);

        const orderStatusBreakdown = allOrders.reduce((acc, o) => {
          const s = o.orderStatus || "pending";
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});

        // ── User roles breakdown ───────────────────────────────────────────────
        const allUsers = await usersCollection.find({}).toArray();
        const userRoles = allUsers.reduce((acc, u) => {
          const r = u.role || "buyer";
          acc[r] = (acc[r] || 0) + 1;
          return acc;
        }, {});

        res.json({
          monthly,
          categoryPerformance,
          totalUsers,
          totalProducts,
          totalOrders,
          totalRevenue,
          orderStatusBreakdown,
          userRoles,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/admin/payments", async (req, res) => {
      try {
        const { status, search } = req.query;

        // Get all payments
        let payments = await paymentsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        // Enrich each payment with order + user info
        const orderIds = payments.map((p) => p.orderId);
        const orders = await ordersCollection
          .find({
            _id: {
              $in: orderIds
                .map((id) => {
                  try {
                    return new ObjectId(id);
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean),
            },
          })
          .toArray();

        const enriched = payments.map((payment) => {
          const order = orders.find(
            (o) => o._id.toString() === payment.orderId,
          );
          return {
            ...payment,
            productTitle: order?.productTitle || "Unknown product",
            orderStatus: order?.orderStatus || "—",
            buyerInfo: order?.buyerInfo || null,
            sellerInfo: order?.sellerInfo || null,
          };
        });

        // Filter by status
        let filtered = enriched;
        if (status)
          filtered = filtered.filter((p) => p.paymentStatus === status);

        // Search by product, buyer email, seller email, transactionId
        if (search) {
          const s = search.toLowerCase();
          filtered = filtered.filter(
            (p) =>
              p.productTitle?.toLowerCase().includes(s) ||
              p.buyerInfo?.email?.toLowerCase().includes(s) ||
              p.sellerInfo?.email?.toLowerCase().includes(s) ||
              p.transactionId?.toLowerCase().includes(s),
          );
        }

        // Summary stats
        const totalRevenue = enriched
          .filter((p) => p.paymentStatus === "paid")
          .reduce((sum, p) => sum + (p.amount || 0), 0);
        const totalRefunded = enriched
          .filter((p) => p.paymentStatus === "refunded")
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        res.json({
          payments: filtered,
          stats: {
            total: enriched.length,
            paid: enriched.filter((p) => p.paymentStatus === "paid").length,
            refunded: enriched.filter((p) => p.paymentStatus === "refunded")
              .length,
            totalRevenue,
            totalRefunded,
          },
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
