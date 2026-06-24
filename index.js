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


    app.post("/api/addedProduct", async (req, res) => {
      const {
        productImage,
        productTitle,
        description,
        category,
   
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

        quantity,
        sellerEmail,
        createdAt: new Date(),
      }
      const result = await sellerCollection.insertOne(addData);
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
