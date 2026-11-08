require("dotenv").config();

const express = require("express");
const path = require("path");
const { google } = require("googleapis");
const { Readable } = require("stream");
const multer = require("multer");
const crypto = require("crypto");

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const {
  getDriveAuthUrl,
  saveDriveToken,
  getDriveClient
} = require("./config/drive-auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const SHEETS = {
  regular: "SCAN_REGULAR",
  trucking: "SCAN_TRUCKING",
  selfpickup: "SCAN_SELFPICKUP",
  "return-regular": "RETURN_DO_REGULAR",
  "return-trucking": "RETURN_DO_TRUCKING"
};

// VALIDASI KONFIGURASI
if (
  !SPREADSHEET_ID ||
  !DRIVE_FOLDER_ID ||
  !process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  !process.env.FIREBASE_SERVICE_ACCOUNT ||
  !process.env.FIREBASE_PROJECT_ID
) {
  throw new Error("Konfigurasi .env belum lengkap.");
}

// GOOGLE SHEETS AUTHENTICATION
const googleKeyPath = path.resolve(
  __dirname,
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

const googleAuth = new google.auth.GoogleAuth({
  keyFile: googleKeyPath,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

async function getSheets() {
  const client = await googleAuth.getClient();

  return google.sheets({
    version: "v4",
    auth: client
  });
}

// FIREBASE ADMIN
const firebaseKeyPath = path.resolve(
  __dirname,
  process.env.FIREBASE_SERVICE_ACCOUNT
);

const firebaseServiceAccount = require(firebaseKeyPath);

if (
  firebaseServiceAccount.project_id !==
  process.env.FIREBASE_PROJECT_ID
) {
  throw new Error("Firebase Project ID tidak sesuai.");
}

initializeApp({
  credential: cert(firebaseServiceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

// MULTER UPLOAD CONFIGURATION
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error("Format foto harus JPG, PNG, atau WEBP.")
      );
    }

    cb(null, true);
  }
});

// FIREBASE TOKEN + USER ACCESS VERIFICATION
async function requireActiveUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token login tidak ditemukan."
      });
    }

    const token = authHeader.substring(7);
    const decoded = await getAuth().verifyIdToken(token);

    const email = (decoded.email || "").toLowerCase();

    if (!email || decoded.email_verified !== true) {
      return res.status(403).json({
        success: false,
        message: "Email belum terverifikasi."
      });
    }

    const sheets = await getSheets();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "USER_ACCESS!A2:C"
    });

    const rows = result.data.values || [];

    const user = rows.find(row =>
      (row[0] || "").trim().toLowerCase() === email
    );

    if (
      !user ||
      (user[2] || "").trim().toUpperCase() !== "ACTIVE"
    ) {
      return res.status(403).json({
        success: false,
        message: "Akun belum memiliki akses aktif."
      });
    }

    const role = (user[1] || "").trim().toUpperCase();

    if (!["ADMIN", "PIC"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Role akun tidak valid."
      });
    }

    req.user = {
      email,
      role
    };

    next();

  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Verifikasi login gagal."
    });
  }
}

// UPLOAD FOTO KE GOOGLE DRIVE ADMIN
async function uploadFotoDrive(file, doNumber) {
  const drive = getDriveClient();

  const safeName = String(doNumber).replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );

  const extension = file.mimetype.split("/")[1];

  const response = await drive.files.create({
    requestBody: {
      name: `DO_${safeName}_${Date.now()}.${extension}`,
      parents: [DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer)
    },
    fields: "id, name, webViewLink"
  });

  return {
    id: response.data.id,
    url:
      response.data.webViewLink ||
      `https://drive.google.com/file/d/${response.data.id}/view`
  };
}

// HAPUS FOTO JIKA TRANSAKSI GAGAL
async function deleteFotoDrive(fileId) {
  if (!fileId) return;

  const drive = getDriveClient();

  await drive.files.delete({
    fileId
  });
}

// HALAMAN UTAMA
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// GOOGLE DRIVE OAUTH
let driveOAuthState = null;

app.get(
  "/api/drive/auth",
  requireActiveUser,
  (req, res) => {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({
        success: false,
        message: "Akses hanya untuk ADMIN."
      });
    }

    try {
      driveOAuthState = crypto.randomBytes(24).toString("hex");

      const authUrl = getDriveAuthUrl();
      const url = new URL(authUrl);

      url.searchParams.set("state", driveOAuthState);

      res.json({
        success: true,
        authUrl: url.toString()
      });

    } catch (error) {
      console.error("Drive OAuth URL error:", error.message);

      res.status(500).json({
        success: false,
        message: "Gagal membuat URL autentikasi Google Drive."
      });
    }
  }
);

// GOOGLE OAUTH CALLBACK
app.get("/oauth2callback", async (req, res) => {
  try {
    if (
      !driveOAuthState ||
      req.query.state !== driveOAuthState
    ) {
      return res.status(403).send("OAuth state tidak valid.");
    }

    if (!req.query.code) {
      return res.status(400).send("Kode OAuth tidak ditemukan.");
    }

    await saveDriveToken(req.query.code);

    driveOAuthState = null;

    res.send(
      "Google Drive berhasil terhubung! Silakan kembali ke aplikasi."
    );

  } catch (error) {
    console.error("OAuth Drive Error:", error.message);

    res.status(500).send(
      "Gagal menghubungkan Google Drive. Periksa konfigurasi OAuth."
    );
  }
});

// STATUS SERVER
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "SANY LOGISTIC SYSTEM aktif",
    version: "1.3.0"
  });
});

// TES GOOGLE SHEETS
app.get("/api/database-test", async (req, res) => {
  try {
    const sheets = await getSheets();

    const result = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });

    res.json({
      success: true,
      message: "Database Google Sheets terhubung.",
      spreadsheet: result.data.properties.title
    });

  } catch (error) {
    console.error("Database error:", error.message);

    res.status(500).json({
      success: false,
      message: "Koneksi database gagal."
    });
  }
});

// TES IDENTITAS DAN AKSES PIC
app.get("/api/auth/me", requireActiveUser, (req, res) => {
  res.json({
    success: true,
    message: "Login dan akses berhasil.",
    user: req.user
  });
});

// PENYIMPANAN TRANSAKSI
app.post(
  "/api/scan",
  requireActiveUser,
  upload.single("fotoDO"),
  async (req, res) => {
    let uploadedPhoto = null;

    try {
      const {
        menu,
        doNumber,
        remarks,
        logisticName,
        inputMethod
      } = req.body;

      if (!SHEETS[menu]) {
        return res.status(400).json({
          success: false,
          message: "Menu transaksi tidak valid."
        });
      }

      const cleanDO = (doNumber || "").trim();

      if (!cleanDO || cleanDO.length > 80) {
        return res.status(400).json({
          success: false,
          message: "DO Number wajib diisi dan maksimal 80 karakter."
        });
      }

      const cleanRemarks = (remarks || "").trim();

      if (cleanRemarks.length > 1000) {
        return res.status(400).json({
          success: false,
          message: "Remarks maksimal 1000 karakter."
        });
      }

      const method = (inputMethod || "").toUpperCase();

      if (!["SCAN", "MANUAL"].includes(method)) {
        return res.status(400).json({
          success: false,
          message: "Metode input tidak valid."
        });
      }

      const cleanLogistic = (logisticName || "").trim();

      if (
        menu === "trucking" &&
        !cleanLogistic
      ) {
        return res.status(400).json({
          success: false,
          message: "Logistic Name wajib diisi."
        });
      }

      if (
        menu === "selfpickup" &&
        !req.file
      ) {
        return res.status(400).json({
          success: false,
          message: "Foto DO Self Pickup wajib dilampirkan."
        });
      }

      if (
        menu !== "selfpickup" &&
        req.file
      ) {
        return res.status(400).json({
          success: false,
          message: "Upload foto hanya tersedia untuk Self Pickup."
        });
      }

      const timestamp = new Date().toLocaleString("sv-SE", {
        timeZone: "Asia/Jakarta"
      });

      // UPLOAD FOTO SELF PICKUP
      if (menu === "selfpickup") {
        uploadedPhoto = await uploadFotoDrive(
          req.file,
          cleanDO
        );
      }

      // SUSUN DATA SESUAI KOLOM SPREADSHEET
      let values;

      switch (menu) {
        case "regular":
          values = [
            timestamp,
            cleanDO,
            cleanRemarks,
            req.user.email,
            method
          ];
          break;

        case "trucking":
          values = [
            timestamp,
            cleanDO,
            cleanLogistic,
            cleanRemarks,
            req.user.email,
            method
          ];
          break;

        case "selfpickup":
          values = [
            timestamp,
            cleanDO,
            uploadedPhoto.url,
            cleanRemarks,
            req.user.email,
            method
          ];
          break;

        case "return-regular":
        case "return-trucking":
          values = [
            timestamp,
            cleanDO,
            cleanRemarks,
            req.user.email,
            method
          ];
          break;
      }

      // SIMPAN KE GOOGLE SHEETS
      const sheets = await getSheets();

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEETS[menu]}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [values]
        }
      });

      console.log(
        `Transaksi berhasil: ${menu} | ${cleanDO} | ${req.user.email}`
      );

      return res.json({
        success: true,
        message: "Transaksi berhasil disimpan.",
        menu,
        doNumber: cleanDO,
        photoId: uploadedPhoto?.id || null,
        photoUrl: uploadedPhoto?.url || null,
        picEmail: req.user.email,
        timestamp
      });

    } catch (error) {
      console.error("Transaction error:", error.message);

      if (uploadedPhoto?.id) {
        try {
          await deleteFotoDrive(uploadedPhoto.id);
          console.log("Foto gagal transaksi berhasil dibersihkan.");
        } catch (cleanupError) {
          console.error(
            "Foto cleanup error:",
            cleanupError.message
          );
        }
      }

      return res.status(500).json({
        success: false,
        message: "Transaksi gagal disimpan. Silakan coba kembali."
      });
    }
  }
);

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("Upload error:", error.message);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Ukuran foto maksimal 8 MB."
          : "Upload foto gagal."
    });
  }

  res.status(400).json({
    success: false,
    message: error.message || "Terjadi kesalahan."
  });
});

// JALANKAN SERVER
app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("SANY LOGISTIC SYSTEM");
  console.log("Server aktif di port " + PORT);
  console.log("Buka: http://localhost:" + PORT);
  console.log("================================");
});