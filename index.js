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

    //Seller products api

    //Get All products added by seller:
    app.get("/api/sellerProducts/:email", async (req, res) => {
      const email = req.params.email;
      const query = { sellerEmail: email };
      const result = await sellerCollection.find(query).toArray();
      res.send(result);
    });

    //added product for seller
    app.post("/api/addedProduct", async (req, res) => {
      const {
        productImage,
        productTitle,
        description,
        category,
        price,
        condition,
        quantity,
        sellerEmail,
      } = req.body;
      const addData = {
        productImage,
        productTitle,
        description,
        category,
        condition,
        price,
        quantity,
        sellerEmail,
        createdAt: new Date(),
      };
      const result = await sellerCollection.insertOne(addData);
      res.send(result);
    });

    // UPDATE a product by _id
    app.put("/api/sellerProducts/:id", async (req, res) => {
      const id = req.params.id;
      const {
        productTitle,
        category,
        condition,
        price,
        quantity,
        description,
      } = req.body;

      const updatedFields = {
        $set: {
          productTitle,
          category,
          condition,
          price: Number(price),
          quantity: Number(quantity),
          description,
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
