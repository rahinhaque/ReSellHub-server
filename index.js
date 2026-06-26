const { ObjectId } = require("mongodb"); // add this import at the top of server.js
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

//MongoDB=========================================================================================
const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    //db
    const db = client.db("reselll_hub_db");

    //collections
    const sellerCollection = db.collection("sellerProducts");
    const wishlistCollection = db.collection("wishlist");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    // GET all products (for public browse page)
    app.get("/api/products", async (req, res) => {
      const { category, condition, search, sort } = req.query;

      const query = { status: "available" };

      if (category) query.category = category;
      if (condition) query.condition = condition;
      if (search) query.title = { $regex: search, $options: "i" };

      let sortOption = { createdAt: -1 }; // newest first by default
      if (sort === "price_asc") sortOption = { price: 1 };
      if (sort === "price_desc") sortOption = { price: -1 };

      const result = await sellerCollection
        .find(query)
        .sort(sortOption)
        .toArray();
      res.send(result);
    });
    // GET single product by id (public)
    app.get("/api/products/:id", async (req, res) => {
      const id = req.params.id;
      const result = await sellerCollection.findOne({ _id: new ObjectId(id) });
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.send(result);
    });

    //Seller products api

    //Get All products added by seller:
    app.get("/api/sellerProducts/:email", async (req, res) => {
      const email = req.params.email;
      const query = { "sellerInfo.email": email }; // ← nested field query
      const result = await sellerCollection.find(query).toArray();
      res.send(result);
    });

    // GET single product by id
    app.get("/api/sellerProducts/product/:id", async (req, res) => {
      const id = req.params.id;
      const result = await sellerCollection.findOne({ _id: new ObjectId(id) });
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.send(result);
    });

    //added product for seller
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

      const addData = {
        title,
        description,
        category,
        condition,
        price: Number(price),
        quantity: Number(quantity),
        images, // array of image URLs
        sellerInfo, // { userId, name, email, phone }
        status: "available",
        createdAt: new Date(),
      };

      const result = await sellerCollection.insertOne(addData);
      res.send(result);
    });

    // UPDATE a product by _id
    app.put("/api/sellerProducts/:id", async (req, res) => {
      const id = req.params.id;
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

      const updatedFields = {
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
      };

      const result = await sellerCollection.updateOne(
        { _id: new ObjectId(id) },
        updatedFields,
      );
      res.send(result);
    });

    // DELETE a product by _id
    app.delete("/api/sellerProducts/:id", async (req, res) => {
      const id = req.params.id;
      const result = await sellerCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //buyer dashbaord api-----------------------
    // Add to wishlist
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
          return res.status(400).json({
            error: "productId and userId or userEmail are required",
          });
        }

        const existing = await wishlistCollection.findOne({
          productId,
          $or: [
            userId ? { userId } : null,
            userEmail ? { userEmail } : null,
          ].filter(Boolean),
        });

        if (existing) {
          return res.status(409).json({ error: "Already in wishlist" });
        }

        const item = {
          productId,
          userId: userId || "",
          userEmail: userEmail || "",
          title: title || "",
          price: Number(price) || 0,
          image: image || "",
          sellerInfo: sellerInfo || null,
          createdAt: new Date(),
        };

        const result = await wishlistCollection.insertOne(item);
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get wishlist by email
    app.get("/api/wishlist/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await wishlistCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get wishlist by userId
    app.get("/api/wishlist/user/:userId", async (req, res) => {
      try {
        const userId = req.params.userId;
        const result = await wishlistCollection
          .find({ userId })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Remove wishlist item
    app.delete("/api/wishlist/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await wishlistCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //stripe
    // POST /api/create-checkout-session
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

    // POST /api/orders/confirm
    app.post("/api/orders/confirm", async (req, res) => {
      const { sessionId } = req.body;

      try {
        // 1. Verify payment with Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).json({ error: "Payment not completed" });
        }

        // 2. Idempotency guard — prevent duplicate orders on refresh
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

        // 3. Save order
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
          orderStatus: "processing",
          stripeSessionId: sessionId,
          createdAt: new Date(),
        };

        const orderResult = await ordersCollection.insertOne(order);
        const orderId = orderResult.insertedId.toString();

        // 4. Save payment
        const payment = {
          orderId,
          transactionId: session.payment_intent,
          amount: session.amount_total / 100,
          paymentStatus: "success",
          stripeSessionId: sessionId,
          createdAt: new Date(),
        };

        await paymentsCollection.insertOne(payment);

        // 5. Mark product as sold
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

    // GET orders by buyer email
    app.get("/api/orders/buyer/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await ordersCollection
          .find({ "buyerInfo.email": email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET single order by id
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

    // PATCH cancel order — only if orderStatus is "processing"
    app.patch("/api/orders/:id/cancel", async (req, res) => {
      try {
        const order = await ordersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (!order) return res.status(404).json({ error: "Order not found" });

        if (order.orderStatus !== "processing") {
          return res.status(400).json({
            error: `Cannot cancel an order with status: ${order.orderStatus}`,
          });
        }

        // Cancel order + restore product to available
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

    // GET payments by buyer email (joins with orders to filter by buyer)
    app.get("/api/payments/buyer/:email", async (req, res) => {
      try {
        const email = req.params.email;

        // 1. Get all orders for this buyer
        const buyerOrders = await ordersCollection
          .find({ "buyerInfo.email": email })
          .toArray();

        if (buyerOrders.length === 0) return res.json([]);

        // 2. Get orderIds as strings
        const orderIds = buyerOrders.map((o) => o._id.toString());

        // 3. Get all payments matching those orderIds
        const payments = await paymentsCollection
          .find({ orderId: { $in: orderIds } })
          .sort({ createdAt: -1 })
          .toArray();

        // 4. Attach productTitle and buyerInfo from the matching order
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

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    //  await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
