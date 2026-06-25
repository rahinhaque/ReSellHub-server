const { ObjectId } = require("mongodb"); // add this import at the top of server.js
const express = require("express");
const app = express();
const dotenv = require("dotenv");
dotenv.config();
const cors = require("cors");
const port = process.env.PORT || 5000;

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
