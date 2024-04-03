const express = require("express");
const router = express.Router();
const { redirectToOutlookConsent, outlookCallback, readAndWriteMails } = require("../controllers/outlookControllers");


router.get("/",redirectToOutlookConsent);
router.get("/oauth/outlook/callback",outlookCallback);
router.get("/automate",readAndWriteMails);

module.exports = router;