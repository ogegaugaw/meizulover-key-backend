const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require("./ogekeyl4m-service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

function randomString(length = 9) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[crypto.randomInt(0, chars.length)];
  }
  return result;
}

function generateKey() {
  return "lovemeizu_" + randomString(9);
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "meizulover-key-system"
  });
});

app.post("/create", async (req, res) => {
  try {
    const key = generateKey();
    const token = generateToken();
    const createdAt = Date.now();

    const destination =
      `${process.env.BASE_URL}/get-key.html?token=${encodeURIComponent(token)}`;

    const keyRef = db.ref("keys/" + key);

    await keyRef.set({
      created_at: createdAt,
      Link4m: "",
      token: token,
      used: false
    });

    const apiUrl =
      "https://link4m.co/api-shorten/v2" +
      "?api=" + encodeURIComponent(process.env.LINK4M_API_KEY) +
      "&url=" + encodeURIComponent(destination);

    const response = await fetch(apiUrl);
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        "Link4M HTTP " + response.status + " | " + responseText
      );
    }

    const data = JSON.parse(responseText);

    if (data.status !== "success" || !data.shortenedUrl) {
      throw new Error("Link4M failed");
    }

    await keyRef.update({
      Link4m: data.shortenedUrl
    });

    res.json({
      success: true,
      token: token,
      shortUrl: data.shortenedUrl
    });

  } catch (error) {
    console.error("CREATE ERROR:", error);
    res.status(500).json({
      success: false,
      error: "CREATE_FAILED"
    });
  }
});

async function findKeyByToken(token) {
  const snapshot = await db
    .ref("keys")
    .orderByChild("token")
    .equalTo(token)
    .once("value");

  if (!snapshot.exists()) return null;

  const data = snapshot.val();
  const names = Object.keys(data);

  if (!names.length) return null;

  return {
    key: names[0],
    data: data[names[0]]
  };
}

app.post("/session-info", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();

    if (!token) {
      return res.json({
        success: false,
        error: "MISSING_TOKEN"
      });
    }

    const result = await findKeyByToken(token);

    if (!result) {
      return res.json({
        success: false,
        error: "INVALID_TOKEN"
      });
    }

    res.json({
      success: true,
      used: result.data.used === true
    });

  } catch (error) {
    console.error("SESSION INFO ERROR:", error);
    res.status(500).json({
      success: false,
      error: "SESSION_INFO_FAILED"
    });
  }
});

app.post("/claim", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();

    if (!token) {
      return res.json({
        success: false,
        error: "MISSING_TOKEN"
      });
    }

    const result = await findKeyByToken(token);

    if (!result) {
      return res.json({
        success: false,
        error: "INVALID_TOKEN"
      });
    }

    if (result.data.used === true) {
      return res.json({
        success: false,
        error: "KEY_USED"
      });
    }

    res.json({
      success: true,
      key: result.key
    });

  } catch (error) {
    console.error("CLAIM ERROR:", error);
    res.status(500).json({
      success: false,
      error: "CLAIM_FAILED"
    });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const key = String(req.body.key || "").trim();

    if (!key) {
      return res.json({
        success: false,
        error: "EMPTY_KEY"
      });
    }

    const snapshot = await db
      .ref("keys/" + key)
      .once("value");

    if (!snapshot.exists()) {
      return res.json({
        success: false,
        error: "INVALID_KEY"
      });
    }

    const data = snapshot.val();

    if (data.used === true) {
      return res.json({
        success: false,
        error: "KEY_USED"
      });
    }

    res.json({
      success: true
    });

  } catch (error) {
    console.error("VERIFY ERROR:", error);
    res.status(500).json({
      success: false,
      error: "VERIFY_FAILED"
    });
  }
});

app.post("/consume", async (req, res) => {
  try {
    const key = String(req.body.key || "").trim();

    if (!key) {
      return res.json({
        success: false,
        error: "EMPTY_KEY"
      });
    }

    const ref = db.ref("keys/" + key);
    const snapshot = await ref.once("value");

    if (!snapshot.exists()) {
      return res.json({
        success: false,
        error: "INVALID_KEY"
      });
    }

    const result = await ref.child("used").transaction((used) => {
      if (used === true) return;
      return true;
    });

    if (!result.committed) {
      return res.json({
        success: false,
        error: "KEY_ALREADY_USED"
      });
    }

    await ref.update({
      usedAt: Date.now()
    });

    res.json({
      success: true
    });

  } catch (error) {
    console.error("CONSUME ERROR:", error);
    res.status(500).json({
      success: false,
      error: "CONSUME_FAILED"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
