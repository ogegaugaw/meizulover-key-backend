require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const serviceAccount = require("./ogekeyl4m-service-account.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

function randomString(length = 9) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars[
            crypto.randomInt(0, chars.length)
        ];
    }

    return result;
}

function generateKey() {
    return "meizulover_" + randomString(9);
}

function generateSession() {
    return crypto.randomBytes(24).toString("hex");
}	

app.post("/create", async (req, res) => {
    try {
        const session = generateSession();
        const key = generateKey();

        const now = Date.now();
        const expiresAt = now + (30 * 60 * 1000);

        const destination =
            `${process.env.BASE_URL}/get-key.html?session=${encodeURIComponent(session)}`;

        // Lưu session
        await db.ref("sessions/" + session).set({
            key: key,
            claimed: false,
            createdAt: now,
            expiresAt: expiresAt
        });

        // Lưu key
        await db.ref("keys/" + key).set({
            session: session,
            used: false,
            createdAt: now,
            expiresAt: expiresAt
        });

        // Tạo Link4M
        const apiUrl =
            "https://link4m.co/api-shorten/v2" +
            "?api=" +
            encodeURIComponent(process.env.LINK4M_API_KEY) +
            "&url=" +
            encodeURIComponent(destination);

        console.log("Dang tao Link4M...");

        const response = await fetch(apiUrl);
        const responseText = await response.text();

        console.log("Link4M HTTP:", response.status);
        console.log("Link4M RAW:", responseText);

        if (!response.ok) {
            throw new Error(
                "Link4M HTTP " + response.status + " | " + responseText
            );
        }

        let data;

        try {
            data = JSON.parse(responseText);
        } catch (e) {
            throw new Error(
                "Link4M khong tra JSON: " + responseText
            );
        }

        if (data.status !== "success") {
            throw new Error(
                "Link4M failed: " +
                (data.message || responseText)
            );
        }

        if (!data.shortenedUrl) {
            throw new Error(
                "Link4M khong co shortenedUrl"
            );
        }

        const shortUrl = data.shortenedUrl;

        // Lưu link rút gọn
        await db.ref("sessions/" + session).update({
            link4m: shortUrl
        });

        await db.ref("keys/" + key).update({
            link4m: shortUrl
        });

        // Không trả key về client
        res.json({
            success: true,
            session: session,
            shortUrl: shortUrl
        });

    } catch (error) {
        console.error("CREATE ERROR:", error);

        res.status(500).json({
            success: false,
            error: "CREATE_FAILED"
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

        const snapshot =
            await db.ref("keys/" + key).once("value");

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

        if (Date.now() > data.expiresAt) {
            return res.json({
                success: false,
                error: "KEY_EXPIRED"
            });
        }

        res.json({
            success: true
        });

    } catch (error) {

        console.error(error);

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

        const result = await ref.transaction((data) => {

            if (!data) {
                return;
            }

            if (data.used === true) {
                return;
            }

            if (Date.now() > data.expiresAt) {
                return;
            }

            data.used = true;
            data.usedAt = Date.now();

            return data;
        });

        if (!result.committed) {

            return res.json({
                success: false,
                error: "INVALID_OR_USED"
            });

        }

        res.json({
            success: true
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: "CONSUME_FAILED"
        });

    }

});
app.post("/session-info", async (req, res) => {
  try {
    const session = String(req.body.session || "").trim();

    if (!session) {
      return res.json({
        success: false,
        error: "MISSING_SESSION"
      });
    }

    const snapshot = await db
      .ref("sessions/" + session)
      .once("value");

    if (!snapshot.exists()) {
      return res.json({
        success: false,
        error: "INVALID_SESSION"
      });
    }

    const data = snapshot.val();

    if (!data.expiresAt || Date.now() > data.expiresAt) {
      return res.json({
        success: false,
        error: "SESSION_EXPIRED"
      });
    }

    res.json({
      success: true,
      claimed: data.claimed === true,
      expiresAt: data.expiresAt
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
    const session = String(req.body.session || "").trim();

    if (!session) {
      return res.json({
        success: false,
        error: "MISSING_SESSION"
      });
    }

    const sessionRef = db.ref("sessions/" + session);

    /*
     * Transaction giúp chống 2 thiết bị
     * cùng claim một session.
     */
    const result = await sessionRef.transaction((data) => {

      if (!data) {
        return;
      }

      // Session đã được claim
      if (data.claimed === true) {
        return;
      }

      // Session hết hạn
      if (!data.expiresAt || Date.now() > data.expiresAt) {
        return;
      }

      // Không có Key
      if (!data.key) {
        return;
      }

      data.claimed = true;
      data.claimedAt = Date.now();

      return data;
    });

    if (!result.committed) {

      const snapshot =
        await sessionRef.once("value");

      if (!snapshot.exists()) {
        return res.json({
          success: false,
          error: "INVALID_SESSION"
        });
      }

      const data = snapshot.val();

      if (data.claimed === true) {
        return res.json({
          success: false,
          error: "KEY_ALREADY_CLAIMED"
        });
      }

      if (
        !data.expiresAt ||
        Date.now() > data.expiresAt
      ) {
        return res.json({
          success: false,
          error: "SESSION_EXPIRED"
        });
      }

      return res.json({
        success: false,
        error: "CLAIM_FAILED"
      });
    }

    const data = result.snapshot.val();

    const key = data.key;

    // Kiểm tra Key trong Firebase
    const keyRef = db.ref("keys/" + key);

    const keySnapshot =
      await keyRef.once("value");

    if (!keySnapshot.exists()) {
      return res.json({
        success: false,
        error: "KEY_NOT_FOUND"
      });
    }

    const keyData = keySnapshot.val();

    if (keyData.used === true) {
      return res.json({
        success: false,
        error: "KEY_USED"
      });
    }

    if (
      !keyData.expiresAt ||
      Date.now() > keyData.expiresAt
    ) {
      return res.json({
        success: false,
        error: "KEY_EXPIRED"
      });
    }

    res.json({
      success: true,
      key: key,
      expiresAt: keyData.expiresAt
    });

  } catch (error) {

    console.error("CLAIM ERROR:", error);

    res.status(500).json({
      success: false,
      error: "CLAIM_FAILED"
    });
  }
});
app.listen(process.env.PORT, () => {
    console.log(
        `Server running on port ${process.env.PORT}`
    );
});
function randomString(length = 9) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let result = "";

  for (let i = 0; i < length; i++) {
    result += chars.charAt(
      crypto.randomInt(0, chars.length)
    );
  }

  return result;
}

function generateKey() {
  return "meizulover_" + randomString(9);
}

function generateSession() {
  return crypto.randomBytes(24).toString("hex");
}
