const express = require("express");
const router = express.Router();
const { redirectToGoogleConsent, googleCallback } = require("../controllers/googleControllers");


router.get("/",redirectToGoogleConsent);
router.get("/oauth/google/callback",googleCallback);

module.exports = router;