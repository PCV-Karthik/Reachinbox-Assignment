const express = require("express");
const googleRoutes = require("./routes/googleRoutes");

const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();

app.use(cors());
app.use("/", googleRoutes);
// app.use("/outlook",outlookRoutes);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
