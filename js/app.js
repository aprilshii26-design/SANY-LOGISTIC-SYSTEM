/**
 * SANY LOGISTIC SYSTEM
 * FRONTEND v3.1.0
 * Batch Processing + IndexedDB
 * Self Pickup tetap menggunakan transaksi lama
 */

// ==================================================
// 1. KONFIGURASI
// ==================================================

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzTJ49IkTUY5jvLxD2tvGrZKEAKjDfVNlAEi8xbeMptxy5UxLHFPqQDs8vhi2MdDjDQ/exec";

const menus = [
  { id: "regular", title: "Administrasi Regular" },
  { id: "trucking", title: "Administrasi Trucking" },
  { id: "selfpickup", title: "Administrasi Self Pickup" },
  { id: "return-regular", title: "Return DO Regular" },
  { id: "return-trucking", title: "Return DO Trucking" }
];

const BATCH_MENUS = [
  "regular",
  "trucking",
  "return-regular",
  "return-trucking"
];

const DB_NAME = "SANY_LOGISTIC_BATCH";
const DB_VERSION = 1;
const DB_STORE = "batches";

const MAX_ATTACHMENTS = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
];


// ==================================================
// 2. GLOBAL STATE
// ==================================================

let scanner = null;
let inputMethod = "MANUAL";
let selectedAttachments = [];
let currentUser = null;
let currentMenu = null;
let currentStep = "scan";
let cameraStarting = false;
let qrCameraId = null;
let submitting = false;

let batchDatabase = null;
let activeBatch = null;
let batchSaving = false;

const main = document.querySelector("main");

if (!main) {
  throw new Error("Elemen main tidak ditemukan.");
}

const originalDashboard = main.innerHTML;

const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});


// ==================================================
// 3. ID BATCH
// ==================================================

function createBatchId() {
  return "SANY-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}


// ==================================================
// 4. KOMUNIKASI APPS SCRIPT
// ==================================================

function callAppsScript(payload) {
  return new Promise((resolve, reject) => {

    const requestId =
      Date.now().toString(36) + "_" +
      Math.random().toString(36).slice(2);

    const requestPayload = {
      ...payload,
      requestId
    };

    const iframe = document.createElement("iframe");
    const form = document.createElement("form");
    const input = document.createElement("input");

    const frameName = "sany_api_" + requestId;

    iframe.name = frameName;
    iframe.style.display = "none";

    form.method = "POST";
    form.action = APPS_SCRIPT_URL;
    form.target = frameName;
    form.style.display = "none";

    input.type = "hidden";
    input.name = "payload";
    input.value = JSON.stringify(requestPayload);

    form.appendChild(input);
    document.body.append(iframe, form);

    let completed = false;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      form.remove();
      iframe.remove();
      clearTimeout(timeout);
    };

    const finish = (callback, value) => {
      if (completed) return;

      completed = true;
      cleanup();
      callback(value);
    };

    const onMessage = event => {
      let result = event.data;

      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch (error) {
          return;
        }
      }

      if (!result || result.requestId !== requestId) return;

      finish(resolve, result);
    };

    window.addEventListener("message", onMessage);

    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Server tidak memberikan respons. " +
          "Periksa status transaksi sebelum mencoba ulang."
        )
      );
    }, 180000);

    form.submit();
  });
}


// ==================================================
// 5. DATABASE LOKAL INDEXEDDB
// ==================================================

function openBatchDatabase() {

  if (batchDatabase) {
    return Promise.resolve(batchDatabase);
  }

  if (!window.indexedDB) {
    return Promise.reject(
      new Error("Browser tidak mendukung IndexedDB.")
    );
  }

  return new Promise((resolve, reject) => {

    const request = indexedDB.open(
      DB_NAME,
      DB_VERSION
    );

    request.onupgradeneeded = event => {

      const db = event.target.result;

      if (!db.objectStoreNames.contains(DB_STORE)) {

        const store = db.createObjectStore(
          DB_STORE,
          { keyPath: "menu" }
        );

        store.createIndex(
          "updatedAt",
          "updatedAt",
          { unique: false }
        );
      }
    };

    request.onsuccess = () => {

      batchDatabase = request.result;

      batchDatabase.onversionchange = () => {
        batchDatabase.close();
        batchDatabase = null;
      };

      resolve(batchDatabase);
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error("Database lokal gagal dibuka.")
      );
    };
  });
}


// ==================================================
// 6. SIMPAN BATCH KE INDEXEDDB
// ==================================================

async function saveLocalBatch(batch) {

  const db = await openBatchDatabase();

  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      DB_STORE,
      "readwrite"
    );

    const store = transaction.objectStore(DB_STORE);

    store.put(batch);

    transaction.oncomplete = () => resolve(true);

    transaction.onerror = () => {
      reject(
        transaction.error ||
        new Error("Gagal menyimpan arsip lokal.")
      );
    };

    transaction.onabort = () => {
      reject(
        transaction.error ||
        new Error("Penyimpanan arsip dibatalkan.")
      );
    };
  });
}


// ==================================================
// 7. AMBIL BATCH DARI INDEXEDDB
// ==================================================

async function getLocalBatch(menu) {

  const db = await openBatchDatabase();

  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      DB_STORE,
      "readonly"
    );

    const request = transaction
      .objectStore(DB_STORE)
      .get(menu);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error("Gagal membaca arsip lokal.")
      );
    };
  });
}


// ==================================================
// 8. HAPUS BATCH LOKAL
// ==================================================

async function deleteLocalBatch(menu) {

  const db = await openBatchDatabase();

  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      DB_STORE,
      "readwrite"
    );

    transaction.objectStore(DB_STORE).delete(menu);

    transaction.oncomplete = () => resolve(true);

    transaction.onerror = () => {
      reject(
        transaction.error ||
        new Error("Gagal menghapus arsip lokal.")
      );
    };
  });
}


// ==================================================
// 9. AMBIL / BUAT BATCH AKTIF
// ==================================================

async function getOrCreateBatch(menu) {

  if (!BATCH_MENUS.includes(menu)) {
    throw new Error("Menu tidak mendukung Batch Processing.");
  }

  const saved = await getLocalBatch(menu);

  if (saved) {

    if (typeof saved.logisticName !== "string") {
      saved.logisticName = "";
    }

    if (!Array.isArray(saved.items)) {
      saved.items = [];
    }

    // Batch selesai atau ditolak tidak boleh digunakan kembali.
    if (
      saved.status === "COMPLETED" ||
      saved.status === "REJECTED"
    ) {

      console.log(
        "Batch sebelumnya sudah selesai:",
        saved.batchId
      );

      const newBatch = {
        batchId: createBatchId(),
        menu: menu,
        picEmail: currentUser.email,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "DRAFT",
        logisticName: "",
        items: []
      };

      await saveLocalBatch(newBatch);

      activeBatch = newBatch;

      return newBatch;
    }

    // Batch yang terputus saat ekspor perlu pemeriksaan,
    // bukan otomatis dianggap aman untuk dikirim ulang.
    if (saved.status === "EXPORTING") {

      saved.recoveryRequired = true;

      saved.updatedAt = new Date().toISOString();

      await saveLocalBatch(saved);

    }

    activeBatch = saved;

    return saved;
  }

  const batch = {
    batchId: createBatchId(),
    menu: menu,
    picEmail: currentUser.email,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "DRAFT",
    logisticName: "",
    items: []
  };

  await saveLocalBatch(batch);

  activeBatch = batch;

  return batch;
}

// ==================================================
// 10. NOTIFIKASI
// ==================================================

function showToast(message, type = "success") {

  let toast = document.getElementById("sanyToast");

  if (!toast) {

    toast = document.createElement("div");

    toast.id = "sanyToast";

    toast.style.cssText = `
      position:fixed;
      left:50%;
      bottom:30px;
      transform:translateX(-50%);
      z-index:99999;
      padding:14px 22px;
      border-radius:10px;
      color:white;
      font-weight:bold;
      font-size:14px;
      max-width:90%;
      text-align:center;
      box-shadow:0 4px 15px #0003;
    `;

    document.body.appendChild(toast);
  }

  toast.style.background =
    type === "success" ? "#218838" : "#C62828";

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    toast.style.display = "none";
  }, 3000);
}


// ==================================================
// 11. LOGIN
// ==================================================

function showLogin(message = "") {

  stopScanner();
  clearSelectedAttachments();

  main.innerHTML = `
    <section style="
      max-width:420px;
      margin:60px auto;
      padding:30px;
      background:white;
      border-radius:12px;
      text-align:center;
    ">

      <h2>SANY LOGISTIC SYSTEM</h2>

      <p>Login menggunakan akun Google terdaftar.</p>

      <button id="googleLogin">
        LOGIN WITH GOOGLE
      </button>

      <p
        style="color:#C62828"
        id="loginMessage"
      ></p>

    </section>
  `;

  document.getElementById("loginMessage").textContent = message;

  document.getElementById("googleLogin").onclick = async () => {

    try {
      await auth.signInWithPopup(googleProvider);

    } catch (error) {

      showLogin("Login gagal: " + error.message);
    }
  };
}


// ==================================================
// 12. VERIFIKASI AKSES
// ==================================================

async function verifyAccess(user) {

  try {

    const token = await user.getIdToken();

    const result = await callAppsScript({
      action: "AUTH_ME",
      idToken: token
    });

    if (!result.success) {
      throw new Error(
        result.message || "Akses ditolak."
      );
    }

    currentUser = result.user;

    showDashboard();

  } catch (error) {

    console.error("Verifikasi akses:", error);

    await auth.signOut();

    showLogin(error.message);
  }
}


// ==================================================
// 13. DASHBOARD
// ==================================================

function showDashboard() {

  stopScanner();
  clearSelectedAttachments();

  currentMenu = null;
  activeBatch = null;

  main.innerHTML = originalDashboard;

  const userBar = document.createElement("div");

  userBar.style.cssText = `
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:10px;
    flex-wrap:wrap;
    padding:12px;
    background:#f5f5f5;
    border-radius:8px;
    margin:15px auto;
    max-width:1000px;
  `;

  const userInfo = document.createElement("span");

  userInfo.textContent =
    currentUser.email + " | " + currentUser.role;

  const logout = document.createElement("button");

  logout.textContent = "LOGOUT";

  logout.onclick = async () => {

    await stopScanner();

    await auth.signOut();
  };

  userBar.append(userInfo, logout);

  main.insertBefore(userBar, main.firstChild);
}


// ==================================================
// 14. STATUS LOGIN
// ==================================================

auth.onAuthStateChanged(user => {

  if (user) {

    main.innerHTML =
      "<p style='text-align:center;padding:50px'>" +
      "Memeriksa akses...</p>";

    verifyAccess(user);

  } else {

    currentUser = null;

    showLogin();
  }
});


// ==================================================
// AKHIR BAGIAN 1 DARI 6
// ==================================================
// ==================================================
// BAGIAN 2 DARI 6
// PEMBUKAAN MENU DAN INPUT BATCH
// ==================================================


// ==================================================
// 15. BUKA MENU
// ==================================================

async function openMenu(id) {

  if (!currentUser) {
    showLogin("Silakan login terlebih dahulu.");
    return;
  }

  if (!menus.find(item => item.id === id)) return;

  await stopScanner();

  clearSelectedAttachments();

  currentMenu = id;
  currentStep = "scan";
  inputMethod = "MANUAL";
  qrCameraId = null;
  activeBatch = null;

  try {

    if (BATCH_MENUS.includes(id)) {

      await getOrCreateBatch(id);

      renderBatchScreen();

      await startScanner();

      const input = document.getElementById("doNumber");

      if (input) input.focus();

    } else {

      // Self Pickup tetap menggunakan alur lama.
      renderScanScreen();

      await startScanner();

      const input = document.getElementById("doNumber");

      if (input) input.focus();
    }

  } catch (error) {

    console.error("Buka menu:", error);

    showToast(
      "Gagal membuka menu: " + error.message,
      "error"
    );
  }
}


// ==================================================
// 16. NORMALISASI DO
// ==================================================

function normalizeDONumber(value) {

  return String(value || "")
    .trim()
    .toUpperCase();
}


// ==================================================
// 17. ESCAPE HTML
// ==================================================

function escapeHTML(value) {

  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}


// ==================================================
// 18. TAMPILAN BATCH
// ==================================================

function renderBatchScreen() {

  if (!activeBatch || !currentMenu) return;

  const menu = menus.find(item => item.id === currentMenu);

  if (!menu) return;

  currentStep = "batch";

  const total = activeBatch.items.length;

  const scanCount = activeBatch.items.filter(
    item => item.inputMethod === "SCAN"
  ).length;

  const manualCount = activeBatch.items.filter(
    item => item.inputMethod === "MANUAL"
  ).length;

  main.innerHTML = `
    <section
      class="form-scan"
      style="
        max-width:650px;
        margin:auto;
        padding:15px;
      "
    >

      <button
        type="button"
        onclick="goHome()"
      >
        ← Kembali
      </button>

      <h2>${escapeHTML(menu.title)}</h2>

      <div
        style="
          background:#e8f5e9;
          padding:12px;
          border-radius:8px;
          margin:12px 0;
          color:#216b32;
          font-weight:bold;
        "
      >
        BATCH MODE AKTIF
      </div>

      <div
        style="
          background:#f3f6fa;
          padding:12px;
          border-radius:8px;
          margin-bottom:15px;
        "
      >

        <div style="font-size:12px;color:#666">
          ID BATCH
        </div>

        <strong>${escapeHTML(activeBatch.batchId)}</strong>

        ${
          currentMenu === "trucking"
            ? `
              <div style="margin-top:15px">
                <label for="batchLogisticName">
                  Logistic Name *
                </label>

                <input
                  type="text"
                  id="batchLogisticName"
                  value="${escapeHTML(activeBatch.logisticName || "")}"
                  placeholder="Nama logistic / pengangkut"
                  autocomplete="off"
                  style="
                    width:100%;
                    box-sizing:border-box;
                    padding:12px;
                    margin-top:7px;
                  "
                >
              </div>
            `
            : ""
        }

        <div
          style="
            display:flex;
            gap:10px;
            flex-wrap:wrap;
            margin-top:12px;
          "
        >

          <div
            style="
              flex:1;
              min-width:100px;
              background:white;
              padding:12px;
              border-radius:7px;
            "
          >
            <div style="font-size:12px;color:#666">
              TOTAL DO
            </div>

            <strong
              id="batchTotal"
              style="font-size:24px"
            >${total}</strong>
          </div>

          <div
            style="
              flex:1;
              min-width:100px;
              background:white;
              padding:12px;
              border-radius:7px;
            "
          >
            <div style="font-size:12px;color:#666">
              HASIL SCAN
            </div>

            <strong
              id="batchScanCount"
              style="font-size:24px"
            >${scanCount}</strong>
          </div>

          <div
            style="
              flex:1;
              min-width:100px;
              background:white;
              padding:12px;
              border-radius:7px;
            "
          >
            <div style="font-size:12px;color:#666">
              INPUT MANUAL
            </div>

            <strong
              id="batchManualCount"
              style="font-size:24px"
            >${manualCount}</strong>
          </div>

        </div>
      </div>

      <div
        id="reader"
        style="
          width:100%;
          max-width:350px;
          margin:15px auto;
          min-height:200px;
        "
      ></div>

      <p style="text-align:center">
        Arahkan kamera ke QR Code DO atau gunakan
        tombol scanner fisik PDA.
      </p>

      <label for="doNumber">
        DO Number
      </label>

      <input
        type="text"
        id="doNumber"
        placeholder="Scan barcode atau ketik DO Number"
        autocomplete="off"
        autocapitalize="characters"
        style="
          width:100%;
          box-sizing:border-box;
          padding:13px;
          font-size:16px;
          margin:8px 0;
        "
      >

      <label for="batchRemarks">
        Remarks
      </label>

      <textarea
        id="batchRemarks"
        placeholder="Catatan tambahan untuk DO ini (opsional)"
        maxlength="1000"
        rows="2"
        style="
          width:100%;
          box-sizing:border-box;
          padding:12px;
          margin:8px 0;
          font-family:inherit;
          resize:vertical;
        "
      ></textarea>

      <div
        style="
          display:flex;
          gap:8px;
          margin-top:8px;
        "
      >

        <button
          type="button"
          id="batchScanModeButton"
          style="flex:1;padding:12px"
        >
          MODE SCAN
        </button>

        <button
          type="button"
          id="batchManualModeButton"
          style="flex:1;padding:12px"
        >
          MODE MANUAL
        </button>

      </div>

      <button
        type="button"
        id="addBatchDOButton"
        style="
          width:100%;
          padding:14px;
          margin-top:12px;
          background:#174ea6;
          color:white;
          border:0;
          border-radius:7px;
          font-weight:bold;
        "
      >
        TAMBAHKAN DO
      </button>

      <p
        id="batchInputStatus"
        style="
          text-align:center;
          color:#555;
          font-size:13px;
        "
      >
        Metode input: MANUAL
      </p>

      <div
        style="
          margin-top:22px;
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:8px;
        "
      >

        <h3 style="margin:0">
          Daftar DO Batch
        </h3>

        <button
          type="button"
          id="refreshBatchButton"
        >
          PERBARUI
        </button>

      </div>

      <div
        id="batchList"
        style="margin-top:12px"
      ></div>

      <div
        style="
          margin-top:20px;
          padding:12px;
          background:#fff8e1;
          border-radius:8px;
          color:#795900;
          font-size:13px;
        "
      >
        DO tersimpan sementara di perangkat ini.
        Transaksi belum masuk Spreadsheet sampai
        proses ekspor dilakukan.
      </div>

      <button
        type="button"
        id="reviewBatchButton"
        style="
          width:100%;
          padding:15px;
          margin-top:15px;
          background:#218838;
          color:white;
          border:0;
          border-radius:7px;
          font-weight:bold;
        "
      >
        REVIEW DAN SIMPAN SEMUA
      </button>

      <p
        id="batchSaveStatus"
        style="text-align:center"
      ></p>

    </section>
  `;

  bindBatchScreenEvents();

  renderBatchList();
}


// ==================================================
// 19. EVENT TAMPILAN BATCH
// ==================================================

function bindBatchScreenEvents() {

  const input = document.getElementById("doNumber");

  const addButton = document.getElementById(
    "addBatchDOButton"
  );

  const scanButton = document.getElementById(
    "batchScanModeButton"
  );

  const manualButton = document.getElementById(
    "batchManualModeButton"
  );

  const reviewButton = document.getElementById(
    "reviewBatchButton"
  );

  const refreshButton = document.getElementById(
    "refreshBatchButton"
  );

  if (!input) return;

  // Keyboard wedge PDA biasanya mengirim Enter.
  input.addEventListener("keydown", event => {

    if (event.key !== "Enter") return;

    event.preventDefault();

    if (currentStep !== "batch") return;

    if (!input.value.trim()) return;

    if (inputMethod === "MANUAL") {
      addBatchDO("MANUAL");
    } else {
      addBatchDO("SCAN");
    }
  });

  addButton.onclick = () => {

    addBatchDO(inputMethod);
  };

  scanButton.onclick = async () => {

    inputMethod = "SCAN";

    updateBatchInputStatus();

    input.focus();

    await startScanner();
  };

  manualButton.onclick = async () => {

    inputMethod = "MANUAL";

    updateBatchInputStatus();

    input.focus();
  };

  refreshButton.onclick = () => {

    renderBatchList();
  };

  reviewButton.onclick = () => {

    reviewBatch();
  };

  updateBatchInputStatus();
}


// ==================================================
// 20. STATUS METODE INPUT
// ==================================================

function updateBatchInputStatus() {

  const status = document.getElementById(
    "batchInputStatus"
  );

  if (!status) return;

  status.textContent =
    "Metode input: " +
    (inputMethod === "SCAN" ? "SCAN" : "MANUAL");
}


// ==================================================
// 21. TAMBAHKAN DO KE BATCH
// ==================================================

async function addBatchDO(method = "MANUAL", value = null) {

  if (batchSaving) return;

  if (!activeBatch) {
    showToast("Batch belum tersedia.", "error");
    return;
  }

  if (activeBatch.status !== "DRAFT") {
    showToast("Batch sedang diproses dan tidak dapat diubah.", "error");
    return;
  }

  const input = document.getElementById("doNumber");
  const remarksInput = document.getElementById("batchRemarks");

  const rawValue = value !== null
    ? value
    : input ? input.value : "";

  const doNumber = String(rawValue || "").trim();

  if (!doNumber) {
    showToast("DO Number wajib diisi.", "error");
    if (input) input.focus();
    return;
  }

  if (doNumber.length > 80) {
    showToast("DO Number maksimal 80 karakter.", "error");
    return;
  }

  const normalized = normalizeDONumber(doNumber);

  const duplicate = activeBatch.items.some(item =>
    normalizeDONumber(item.doNumber) === normalized
  );

  if (duplicate) {
    showToast("DO " + doNumber + " sudah ada dalam batch ini.", "error");
    if (input && value === null) {
      input.select();
      input.focus();
    }
    return;
  }

  // Ambil Remarks langsung dari textarea.
  const remarks = remarksInput
    ? String(remarksInput.value || "").trim()
    : "";

  if (remarks.length > 1000) {
    showToast("Remarks maksimal 1000 karakter.", "error");
    return;
  }

  let logisticName = "";

  if (activeBatch.menu === "trucking") {

    const logisticInput = document.getElementById("batchLogisticName");

    logisticName = logisticInput
      ? logisticInput.value.trim()
      : (activeBatch.logisticName || "");

    if (!logisticName) {
      showToast("Logistic Name wajib diisi.", "error");
      if (logisticInput) logisticInput.focus();
      return;
    }

    activeBatch.logisticName = logisticName;
  }

  batchSaving = true;

  try {

    const item = {
      itemId: createBatchId(),
      batchId: activeBatch.batchId,
      sequence: activeBatch.items.length + 1,
      doNumber: doNumber,
      normalizedDO: normalized,
      inputMethod: method === "SCAN" ? "SCAN" : "MANUAL",
      remarks: remarks,
      createdAt: new Date().toISOString(),
      status: "PENDING"
    };

    // Debug: pastikan Remarks masuk ke item.
    console.log("BATCH REMARKS CHECK:", {
      doNumber: item.doNumber,
      remarks: item.remarks,
      remarksLength: item.remarks.length
    });

    activeBatch.items.push(item);

    activeBatch.updatedAt = new Date().toISOString();

    await saveLocalBatch(activeBatch);

    if (input) {
      input.value = "";
      input.focus();
    }

    if (remarksInput) {
      remarksInput.value = "";
    }

    renderBatchList();
    updateBatchCounters();

    showToast(
      remarks
        ? "DO dan Remarks berhasil ditambahkan: " + doNumber
        : "DO berhasil ditambahkan: " + doNumber,
      "success"
    );

  } catch (error) {

    console.error("Tambah DO batch:", error);

    showToast(
      "Gagal menyimpan DO: " + error.message,
      "error"
    );

  } finally {

    batchSaving = false;
  }
}

// ==================================================
// 22. HASIL SCAN QR / PDA
// ==================================================

async function handleDOScanned(value) {

  const doNumber = String(value || "").trim();

  if (!doNumber) return;

  if (BATCH_MENUS.includes(currentMenu)) {

    if (currentStep !== "batch") return;

    inputMethod = "SCAN";

    const input = document.getElementById("doNumber");

    if (input) {
      input.value = doNumber;
    }

    updateBatchInputStatus();

    await addBatchDO("SCAN", doNumber);

    return;
  }

  // Self Pickup menggunakan alur transaksi lama.
  if (currentStep !== "scan") return;

  const oldInput = document.getElementById("doNumber");

  if (oldInput) {
    oldInput.value = doNumber;
  }

  inputMethod = "SCAN";

  await stopScanner();

  const method = document.getElementById("inputMethod");

  if (method) {
    method.textContent = "Metode input: SCAN";
  }

  if (currentMenu === "selfpickup") {

    openSelfPickupDocumentation();

  } else {

    showToast(
      "DO berhasil terbaca: " + doNumber
    );
  }
}


// ==================================================
// 23. TAMPILKAN DAFTAR DO
// ==================================================

function renderBatchList() {

  const container = document.getElementById("batchList");

  if (!container || !activeBatch) return;

  const items = activeBatch.items || [];

  if (items.length === 0) {

    container.innerHTML = `
      <div
        style="
          padding:25px 12px;
          text-align:center;
          color:#777;
          background:#f7f7f7;
          border-radius:8px;
        "
      >
        Belum ada DO dalam batch.
        <br>
        Silakan scan atau input DO.
      </div>
    `;

    updateBatchCounters();

    return;
  }

  container.innerHTML = "";

  items.forEach((item, index) => {

    const card = document.createElement("div");

    card.style.cssText = `
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
      padding:12px;
      margin-bottom:8px;
      border:1px solid #ddd;
      border-radius:8px;
      background:white;
    `;

    const info = document.createElement("div");

    info.style.cssText = `
      min-width:0;
      flex:1;
      overflow-wrap:anywhere;
    `;

    const number = document.createElement("strong");

    number.textContent =
      (index + 1) + ". " + item.doNumber;

    const metadata = document.createElement("div");

    metadata.style.cssText = `
      font-size:12px;
      color:#777;
      margin-top:5px;
    `;

    metadata.textContent =
      item.inputMethod +
      " | " +
      new Date(item.createdAt).toLocaleTimeString("id-ID") +
      (item.remarks ? " | Remarks: " + item.remarks : "");

    const status = document.createElement("div");

    status.style.cssText = `
      font-size:11px;
      color:#218838;
      margin-top:4px;
    `;

    status.textContent = item.status || "PENDING";

    info.append(number, metadata, status);

    const remove = document.createElement("button");

    remove.type = "button";
    remove.textContent = "HAPUS";

    remove.style.cssText = `
      padding:8px 10px;
      color:white;
      background:#C62828;
      border:0;
      border-radius:5px;
      flex-shrink:0;
    `;

    remove.onclick = () => {

      removeBatchDO(item.itemId);
    };

    card.append(info, remove);

    container.appendChild(card);
  });

  updateBatchCounters();
}


// ==================================================
// 24. PERBARUI COUNTER
// ==================================================

function updateBatchCounters() {

  if (!activeBatch) return;

  const items = activeBatch.items || [];

  const total = items.length;

  const scanCount = items.filter(
    item => item.inputMethod === "SCAN"
  ).length;

  const manualCount = items.filter(
    item => item.inputMethod === "MANUAL"
  ).length;

  const totalElement = document.getElementById(
    "batchTotal"
  );

  const scanElement = document.getElementById(
    "batchScanCount"
  );

  const manualElement = document.getElementById(
    "batchManualCount"
  );

  if (totalElement) totalElement.textContent = total;

  if (scanElement) scanElement.textContent = scanCount;

  if (manualElement) manualElement.textContent = manualCount;
}


// ==================================================
// 25. HAPUS DO DARI BATCH
// ==================================================

async function removeBatchDO(itemId) {

  if (!activeBatch) return;

  if (activeBatch.status !== "DRAFT") {
    showToast(
      "Batch sedang diproses dan tidak dapat diubah.",
      "error"
    );
    return;
  }

  const index = activeBatch.items.findIndex(
    item => item.itemId === itemId
  );

  if (index < 0) return;

  const item = activeBatch.items[index];

  const confirmed = window.confirm(
    "Hapus DO " + item.doNumber + " dari batch?"
  );

  if (!confirmed) return;

  try {

    activeBatch.items.splice(index, 1);

    // Susun ulang nomor urut.
    activeBatch.items.forEach((entry, i) => {
      entry.sequence = i + 1;
    });

    activeBatch.updatedAt = new Date().toISOString();

    await saveLocalBatch(activeBatch);

    renderBatchList();

    showToast(
      "DO berhasil dihapus dari batch."
    );

  } catch (error) {

    console.error("Hapus DO batch:", error);

    showToast(
      "Gagal menghapus DO: " + error.message,
      "error"
    );
  }
}


// ==================================================
// AKHIR BAGIAN 2 DARI 6
// ==================================================
// BAGIAN 3 DARI 6
// REVIEW DAN VALIDASI BATCH
// ==================================================


// ==================================================
// 26. HALAMAN REVIEW BATCH
// ==================================================

function reviewBatch() {

  if (!activeBatch) {
    showToast("Batch belum tersedia.", "error");
    return;
  }

  if (activeBatch.status !== "DRAFT") {
    showToast("Batch tidak dalam status DRAFT.", "error");
    return;
  }

  if (!activeBatch.items || activeBatch.items.length === 0) {
    showToast("Belum ada DO untuk diperiksa.", "error");
    return;
  }

  stopScanner();

  currentStep = "review";

  renderBatchReview();
}


// ==================================================
// 27. TAMPILKAN HALAMAN REVIEW
// ==================================================

function renderBatchReview() {

  if (!activeBatch) return;

  const menu = menus.find(
    item => item.id === activeBatch.menu
  );

  if (!menu) return;

  const items = activeBatch.items || [];

  const total = items.length;

  const scanCount = items.filter(
    item => item.inputMethod === "SCAN"
  ).length;

  const manualCount = items.filter(
    item => item.inputMethod === "MANUAL"
  ).length;

  main.innerHTML = `
    <section
      style="
        max-width:700px;
        margin:auto;
        padding:15px;
      "
    >

      <button
        type="button"
        id="backToBatchButton"
      >
        ← Kembali ke daftar DO
      </button>

      <h2>Review Batch</h2>

      <p>${escapeHTML(menu.title)}</p>

      <div
        style="
          padding:14px;
          background:#f3f6fa;
          border-radius:8px;
          margin:15px 0;
        "
      >

        <div style="font-size:12px;color:#666">
          ID BATCH
        </div>

        <strong>${escapeHTML(activeBatch.batchId)}</strong>

        <div
          style="
            display:grid;
            grid-template-columns:repeat(3,minmax(0,1fr));
            gap:8px;
            margin-top:15px;
          "
        >

          <div style="background:white;padding:10px;border-radius:7px">
            <div style="font-size:11px;color:#777">TOTAL DO</div>
            <strong style="font-size:22px">${total}</strong>
          </div>

          <div style="background:white;padding:10px;border-radius:7px">
            <div style="font-size:11px;color:#777">SCAN</div>
            <strong style="font-size:22px">${scanCount}</strong>
          </div>

          <div style="background:white;padding:10px;border-radius:7px">
            <div style="font-size:11px;color:#777">MANUAL</div>
            <strong style="font-size:22px">${manualCount}</strong>
          </div>

        </div>

      </div>

      <div
        style="
          background:#fff8e1;
          padding:12px;
          border-radius:8px;
          margin-bottom:15px;
          color:#795900;
          font-size:13px;
        "
      >
        Periksa kembali nomor DO sebelum mengekspor
        seluruh batch ke Spreadsheet.
      </div>

      <label for="reviewSearch">
        Cari DO
      </label>

      <input
        type="search"
        id="reviewSearch"
        placeholder="Masukkan nomor DO..."
        style="
          width:100%;
          box-sizing:border-box;
          padding:12px;
          margin:8px 0 15px;
        "
      >

      <div
        style="
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:10px;
        "
      >
        <h3>Daftar DO</h3>
        <span id="reviewVisibleCount"></span>
      </div>

      <div id="reviewBatchList"></div>

      <div
        style="
          display:flex;
          gap:10px;
          flex-wrap:wrap;
          margin-top:20px;
        "
      >

        <button
          type="button"
          id="reviewBackButton"
          style="
            flex:1;
            min-width:130px;
            padding:14px;
          "
        >
          TAMBAH DO LAGI
        </button>

        <button
          type="button"
          id="exportBatchButton"
          style="
            flex:1;
            min-width:160px;
            padding:14px;
            background:#218838;
            color:white;
            border:0;
            border-radius:7px;
            font-weight:bold;
          "
        >
          EKSPOR SEMUA
        </button>

      </div>

      <p
        id="reviewStatus"
        style="text-align:center;margin-top:15px"
      ></p>

    </section>
  `;

  document.getElementById("backToBatchButton").onclick =
    returnToBatchScreen;

  document.getElementById("reviewBackButton").onclick =
    returnToBatchScreen;

  document.getElementById("exportBatchButton").onclick =
    confirmBatchExport;

  document.getElementById("reviewSearch").addEventListener(
    "input",
    event => {
      renderReviewList(event.target.value);
    }
  );

  renderReviewList();
}


// ==================================================
// 28. TAMPILKAN DAFTAR REVIEW
// ==================================================

function renderReviewList(search = "") {

  const container = document.getElementById(
    "reviewBatchList"
  );

  const counter = document.getElementById(
    "reviewVisibleCount"
  );

  if (!container || !activeBatch) return;

  const keyword = normalizeDONumber(search);

  const items = activeBatch.items.filter(item =>
    normalizeDONumber(item.doNumber).includes(keyword)
  );

  container.innerHTML = "";

  if (items.length === 0) {

    container.innerHTML = `
      <div
        style="
          padding:25px;
          text-align:center;
          color:#777;
          background:#f7f7f7;
          border-radius:8px;
        "
      >
        Tidak ada DO yang cocok.
      </div>
    `;

    if (counter) counter.textContent = "0 DO";

    return;
  }

  items.forEach(item => {

    const card = document.createElement("div");

    card.style.cssText = `
      padding:12px;
      border:1px solid #ddd;
      border-radius:8px;
      margin-bottom:8px;
      background:white;
    `;

    const number = document.createElement("strong");

    number.textContent = item.doNumber;

    const metadata = document.createElement("div");

    metadata.style.cssText = `
      font-size:12px;
      color:#777;
      margin-top:5px;
    `;

    metadata.textContent =
      "Metode: " + item.inputMethod +
      " | Status: " + (item.status || "PENDING") +
      (item.remarks ? " | Remarks: " + item.remarks : "");

    const sequence = document.createElement("div");

    sequence.style.cssText = `
      font-size:11px;
      color:#999;
      margin-top:4px;
    `;

    sequence.textContent =
      "Urutan DO: " + item.sequence;

    card.append(number, metadata, sequence);

    container.appendChild(card);
  });

  if (counter) {
    counter.textContent = items.length + " DO";
  }
}


// ==================================================
// 29. KEMBALI KE HALAMAN BATCH
// ==================================================

async function returnToBatchScreen() {

  if (!activeBatch) return;

  if (activeBatch.status !== "DRAFT") {
    showToast(
      "Batch sedang diproses.",
      "error"
    );
    return;
  }

  currentStep = "batch";

  renderBatchScreen();

  await startScanner();

  const input = document.getElementById("doNumber");

  if (input) input.focus();
}


// ==================================================
// 30. KONFIRMASI EKSPOR
// ==================================================

function confirmBatchExport() {

  if (!activeBatch) {
    showToast("Batch tidak ditemukan.", "error");
    return;
  }

  const items = activeBatch.items || [];

  if (items.length === 0) {
    showToast("Tidak ada DO untuk diekspor.", "error");
    return;
  }

  if (activeBatch.status !== "DRAFT") {
    showToast(
      "Batch sedang diproses atau sudah selesai.",
      "error"
    );
    return;
  }

  const confirmed = window.confirm(
    "KONFIRMASI EKSPOR BATCH\n\n" +
    "ID Batch: " + activeBatch.batchId + "\n" +
    "Menu: " + activeBatch.menu + "\n" +
    "Total DO: " + items.length + "\n\n" +
    "Pastikan seluruh nomor DO sudah benar.\n\n" +
    "Lanjutkan proses ekspor?"
  );

  if (!confirmed) return;

  // Proses ekspor akan dihubungkan ke backend
  // pada bagian selanjutnya.

  if (typeof exportBatchToServer !== "function") {

    showToast(
      "Modul ekspor belum tersedia. Tunggu revisi berikutnya.",
      "error"
    );

    return;
  }

  exportBatchToServer();
}


// ==================================================
// 31. VALIDASI STRUKTUR BATCH
// ==================================================

function validateBatchStructure(batch) {

  if (!batch || typeof batch !== "object") {
    throw new Error("Data batch tidak valid.");
  }

  if (!batch.batchId) {
    throw new Error("ID Batch tidak ditemukan.");
  }

  if (!BATCH_MENUS.includes(batch.menu)) {
    throw new Error("Menu batch tidak valid.");
  }

  if (!Array.isArray(batch.items) || batch.items.length === 0) {
    throw new Error("Batch belum memiliki DO.");
  }

  if (batch.menu === "trucking" &&
      !String(batch.logisticName || "").trim()) {
    throw new Error("Logistic Name wajib diisi untuk batch Trucking.");
  }

  const seen = new Set();

  for (const item of batch.items) {

    const doNumber = String(item.doNumber || "").trim();

    if (!doNumber) {
      throw new Error("Ditemukan DO Number kosong.");
    }

    if (doNumber.length > 80) {
      throw new Error(
        "DO " + doNumber + " melebihi 80 karakter."
      );
    }

    const normalized = normalizeDONumber(doNumber);

    if (seen.has(normalized)) {
      throw new Error(
        "Terdapat DO duplikat: " + doNumber
      );
    }

    seen.add(normalized);

    if (!["SCAN", "MANUAL"].includes(item.inputMethod)) {
      throw new Error(
        "Metode input DO " + doNumber + " tidak valid."
      );
    }

    if (String(item.remarks || "").length > 1000) {
      throw new Error("Remarks DO " + doNumber + " melebihi 1000 karakter.");
    }
  }

  return true;
}


// ==================================================
// 32. SIMPAN PERUBAHAN TERAKHIR SEBELUM EKSPOR
// ==================================================

async function prepareBatchForExport() {

  if (!activeBatch) {
    throw new Error("Batch tidak ditemukan.");
  }

  validateBatchStructure(activeBatch);

  activeBatch.updatedAt = new Date().toISOString();

  await saveLocalBatch(activeBatch);

  return {
    batchId: activeBatch.batchId,
    menu: activeBatch.menu,
    picEmail: activeBatch.picEmail,
    logisticName: activeBatch.menu === "trucking"
      ? String(activeBatch.logisticName || "").trim()
      : "",
    createdAt: activeBatch.createdAt,
    updatedAt: activeBatch.updatedAt,
    items: activeBatch.items.map(item => ({
      itemId: item.itemId,
      sequence: item.sequence,
      doNumber: item.doNumber,
      inputMethod: item.inputMethod,
      remarks: item.remarks || "",
      createdAt: item.createdAt,
      status: item.status
    }))
  };
}


// ==================================================
// AKHIR BAGIAN 3 DARI 6
// BAGIAN 4 DARI 6
// MESIN EKSPOR DAN PEMULIHAN BATCH
// ==================================================


// ==================================================
// 33. STATUS EKSPOR
// ==================================================

let batchExporting = false;


// ==================================================
// 34. TAMPILAN PROGRES EKSPOR
// ==================================================

function renderExportProgress(message, percentage = 0) {

  const status = document.getElementById("reviewStatus");

  const button = document.getElementById(
    "exportBatchButton"
  );

  if (status) {

    status.innerHTML = `
      <div style="margin:15px 0;text-align:left">

        <strong>${escapeHTML(message)}</strong>

        <div style="
          width:100%;
          height:10px;
          background:#e5e5e5;
          border-radius:10px;
          overflow:hidden;
          margin-top:10px;
        ">

          <div style="
            width:${Math.max(0, Math.min(100, percentage))}%;
            height:100%;
            background:#218838;
            transition:width .2s;
          "></div>

        </div>

        <p style="font-size:12px;color:#777">
          ${Math.round(percentage)}%
        </p>

      </div>
    `;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "SEDANG MENGEKSPOR...";
  }
}


// ==================================================
// 35. AKTIFKAN KEMBALI TOMBOL EKSPOR
// ==================================================

function restoreExportButton() {

  const button = document.getElementById(
    "exportBatchButton"
  );

  if (button) {
    button.disabled = false;
    button.textContent = "EKSPOR SEMUA";
  }
}


// ==================================================
// 36. KUNCI BATCH LOKAL
// ==================================================

async function lockBatchForExport() {

  if (!activeBatch) {
    throw new Error("Batch tidak ditemukan.");
  }

  if (activeBatch.status !== "DRAFT") {
    throw new Error(
      "Batch tidak dalam status DRAFT."
    );
  }

  validateBatchStructure(activeBatch);

  activeBatch.status = "EXPORTING";

  activeBatch.exportStartedAt = new Date().toISOString();

  activeBatch.updatedAt = new Date().toISOString();

  await saveLocalBatch(activeBatch);

  return activeBatch;
}


// ==================================================
// 37. BUKA KUNCI JIKA EKSPOR GAGAL
// ==================================================

async function unlockBatchAfterFailure() {

  if (!activeBatch) return;

  // Jangan menghapus status item yang sudah berhasil.
  activeBatch.status = "DRAFT";

  activeBatch.lastExportErrorAt = new Date().toISOString();

  activeBatch.updatedAt = new Date().toISOString();

  await saveLocalBatch(activeBatch);
}


// ==================================================
// 38. KIRIM BATCH KE APPS SCRIPT
// ==================================================

async function sendBatchToServer(batchPayload) {

  if (!auth.currentUser) {
    throw new Error("Sesi login sudah berakhir.");
  }

  const token = await auth.currentUser.getIdToken();

  const request = {
    action: "BATCH_EXPORT",
    idToken: token,
    batchId: batchPayload.batchId,
    menu: batchPayload.menu,
    picEmail: batchPayload.picEmail,
    logisticName: batchPayload.logisticName || "",
    createdAt: batchPayload.createdAt,
    items: batchPayload.items.map(item => ({
      itemId: item.itemId,
      sequence: item.sequence,
      doNumber: item.doNumber,
      inputMethod: item.inputMethod,
      remarks: item.remarks || "",
      createdAt: item.createdAt
    }))
  };

  const result = await callAppsScript(request);

  if (!result || result.success !== true) {

    throw new Error(
      result && result.message
        ? result.message
        : "Server menolak ekspor batch."
    );
  }

  return result;
}


// ==================================================
// 39. VALIDASI RESPONS SERVER
// ==================================================

function validateBatchServerResponse(result) {

  if (!result || result.success !== true) {
    throw new Error("Respons server tidak valid.");
  }

  if (!result.batchId) {
    throw new Error("ID Batch tidak terdapat dalam respons.");
  }

  if (!activeBatch || result.batchId !== activeBatch.batchId) {
    throw new Error("ID Batch server tidak cocok.");
  }

  if (!Array.isArray(result.results)) {
    throw new Error(
      "Server tidak memberikan rincian hasil DO."
    );
  }

  const expectedIds = new Set(
    activeBatch.items.map(item => item.itemId)
  );

  const returnedIds = new Set();

  result.results.forEach(item => {

    if (!item.itemId || !expectedIds.has(item.itemId)) {
      throw new Error(
        "Respons server berisi item yang tidak dikenal."
      );
    }

    if (!["EXPORTED", "REJECTED", "NEEDS_REVIEW", "PREPARED"].includes(item.status)) {
      throw new Error(
        "Status hasil server tidak dikenal untuk DO " +
        (item.doNumber || item.itemId) + "."
      );
    }

    if (returnedIds.has(item.itemId)) {
      throw new Error(
        "Respons server memiliki item duplikat."
      );
    }

    returnedIds.add(item.itemId);
  });

  if (returnedIds.size !== expectedIds.size) {
    throw new Error(
      "Respons server belum mencakup seluruh DO batch."
    );
  }

  return true;
}


// ==================================================
// 40. SINKRONISASI HASIL SERVER KE LOKAL
// ==================================================

async function synchronizeBatchResult(result) {

  validateBatchServerResponse(result);

  const serverItems = new Map(
    result.results.map(item => [
      item.itemId,
      item
    ])
  );

  activeBatch.items.forEach(item => {

    const serverItem = serverItems.get(item.itemId);

    item.status = serverItem.status || "PENDING";

    if (serverItem.message) {
      item.serverMessage = serverItem.message;
    }

    if (serverItem.exportedAt) {
      item.exportedAt = serverItem.exportedAt;
    }

    if (serverItem.recovered === true) {
      item.recovered = true;
    }

    if (serverItem.idempotentReplay === true) {
      item.idempotentReplay = true;
    }
  });

  const statuses = activeBatch.items.map(item => item.status);

  activeBatch.serverSummary = {
    total: Number.isFinite(Number(result.total))
      ? Number(result.total)
      : activeBatch.items.length,
    success: Number.isFinite(Number(result.successCount))
      ? Number(result.successCount)
      : statuses.filter(status => status === "EXPORTED").length,
    duplicate: Number.isFinite(Number(result.duplicateCount))
      ? Number(result.duplicateCount)
      : 0,
    failed: Number.isFinite(Number(result.failedCount))
      ? Number(result.failedCount)
      : statuses.filter(status => ["REJECTED", "NEEDS_REVIEW"].includes(status)).length
  };

  activeBatch.updatedAt = new Date().toISOString();

  await saveLocalBatch(activeBatch);

  return activeBatch.serverSummary;
}


// ==================================================
// 41. CEK STATUS HASIL EKSPOR
// ==================================================

function isBatchFullyExported() {

  if (!activeBatch || !activeBatch.items.length) {
    return false;
  }

  return activeBatch.items.every(item =>
    item.status === "EXPORTED"
  );
}


// ==================================================
// 42. MESIN EKSPOR UTAMA
// ==================================================

async function exportBatchToServer() {

  if (batchExporting) return;

  if (!activeBatch) {
    showToast("Batch tidak ditemukan.", "error");
    return;
  }

  if (activeBatch.status !== "DRAFT") {
    showToast(
      "Batch sedang diproses.",
      "error"
    );
    return;
  }

  batchExporting = true;

  let serverConfirmed = false;

  try {

    const reviewButton = document.getElementById(
      "reviewBackButton"
    );

    if (reviewButton) {
      reviewButton.disabled = true;
    }

    renderExportProgress(
      "Memvalidasi data batch...",
      10
    );

    const payload = await prepareBatchForExport();

    renderExportProgress(
      "Mengunci batch lokal...",
      25
    );

    await lockBatchForExport();

    renderExportProgress(
      "Mengirim data ke server...",
      45
    );

    const result = await sendBatchToServer(payload);

    serverConfirmed = true;

    renderExportProgress(
      "Memeriksa hasil penyimpanan server...",
      75
    );

    await synchronizeBatchResult(result);

    renderExportProgress(
      "Memastikan seluruh hasil tersimpan...",
      90
    );

    if (isBatchFullyExported()) {

      activeBatch.status = "COMPLETED";

      activeBatch.completedAt = new Date().toISOString();

      activeBatch.updatedAt = new Date().toISOString();

      await saveLocalBatch(activeBatch);

      renderExportProgress(
        "Seluruh DO berhasil diekspor.",
        100
      );

      showToast(
        "Batch berhasil disimpan ke Spreadsheet."
      );

      setTimeout(() => {
        showBatchExportResult();
      }, 700);

    } else {

      activeBatch.status = "DRAFT";

      activeBatch.updatedAt = new Date().toISOString();

      await saveLocalBatch(activeBatch);

      renderExportProgress(
        "Sebagian DO belum berhasil diekspor.",
        100
      );

      showToast(
        "Ada DO yang gagal atau duplikat. Periksa hasilnya.",
        "error"
      );

      setTimeout(() => {
        renderBatchReview();
      }, 1000);
    }

  } catch (error) {

    console.error("Batch export:", error);

    if (serverConfirmed) {

      // Respons server sudah diterima.
      // Jangan menghapus data lokal.
      // Jangan mengirim ulang tanpa verifikasi.

      if (activeBatch) {
        activeBatch.status = "EXPORTING";

        activeBatch.recoveryRequired = true;

        activeBatch.updatedAt = new Date().toISOString();

        await saveLocalBatch(activeBatch);
      }

      showToast(
        "Respons server sudah diterima, tetapi sinkronisasi lokal bermasalah. Jangan ekspor ulang dulu.",
        "error"
      );

    } else {

      // Tidak ada konfirmasi server.
      // Batch tetap dipertahankan untuk pemulihan.

      try {
        await unlockBatchAfterFailure();
      } catch (localError) {
        console.error("Pemulihan batch:", localError);
      }

      showToast(
        "Ekspor belum terkonfirmasi: " + error.message,
        "error"
      );
    }

    const status = document.getElementById("reviewStatus");

    if (status) {
      status.textContent = error.message;
    }

    restoreExportButton();

  } finally {

    batchExporting = false;
  }
}


// ==================================================
// 43. HALAMAN HASIL EKSPOR
// ==================================================

function showBatchExportResult() {

  if (!activeBatch) return;

  const summary = activeBatch.serverSummary || {};

  main.innerHTML = `
    <section style="
      max-width:550px;
      margin:40px auto;
      padding:20px;
      text-align:center;
    ">

      <div style="
        width:70px;
        height:70px;
        margin:auto;
        border-radius:50%;
        background:#e8f5e9;
        color:#218838;
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:40px;
      ">
        ✓
      </div>

      <h2>Batch Selesai</h2>

      <p>Seluruh DO berhasil dikirim ke Spreadsheet.</p>

      <div style="
        padding:15px;
        background:#f3f6fa;
        border-radius:8px;
        text-align:left;
        margin:20px 0;
      ">

        <p>
          <strong>ID Batch:</strong>
          ${escapeHTML(activeBatch.batchId)}
        </p>

        <p>
          <strong>Total DO:</strong>
          ${summary.total || activeBatch.items.length}
        </p>

        <p>
          <strong>Berhasil:</strong>
          ${summary.success || activeBatch.items.length}
        </p>

      </div>

      <button
        type="button"
        id="newBatchButton"
        style="
          width:100%;
          padding:14px;
          background:#218838;
          color:white;
          border:0;
          border-radius:7px;
          font-weight:bold;
        "
      >
        MULAI BATCH BARU
      </button>

      <button
        type="button"
        id="returnDashboardButton"
        style="
          width:100%;
          padding:12px;
          margin-top:10px;
        "
      >
        KEMBALI KE DASHBOARD
      </button>

    </section>
  `;

  document.getElementById("newBatchButton").onclick =
    createNextBatch;

  document.getElementById("returnDashboardButton").onclick =
    goHome;
}


// ==================================================
// 44. BUAT BATCH BARU
// ==================================================

async function createNextBatch() {

  if (!activeBatch || activeBatch.status !== "COMPLETED") {
    showToast(
      "Batch sebelumnya belum selesai.",
      "error"
    );
    return;
  }

  const menu = activeBatch.menu;

  try {

    await deleteLocalBatch(menu);

    activeBatch = null;

    await getOrCreateBatch(menu);

    currentMenu = menu;
    currentStep = "batch";
    inputMethod = "MANUAL";

    renderBatchScreen();

    await startScanner();

    const input = document.getElementById("doNumber");

    if (input) input.focus();

    showToast("Batch baru berhasil dibuat.");

  } catch (error) {

    showToast(
      "Gagal membuat batch baru: " + error.message,
      "error"
    );
  }
}


// ==================================================
// AKHIR BAGIAN 4 DARI 6
// BAGIAN 5 DARI 6
// SELF PICKUP, QR SCANNER, DAN NAVIGASI
// ==================================================


// ==================================================
// 45. MODE MANUAL SELF PICKUP
// ==================================================

function switchToManual() {

  stopScanner();

  inputMethod = "MANUAL";

  const reader = document.getElementById("reader");
  const method = document.getElementById("inputMethod");
  const button = document.getElementById("manualButton");
  const input = document.getElementById("doNumber");

  if (reader) reader.style.display = "none";

  if (method) {
    method.textContent = "Metode input: MANUAL";
  }

  if (input) {
    input.placeholder = "Ketik DO Number secara manual";
    input.focus();
  }

  if (button) {
    button.textContent = "KEMBALI KE SCAN";
    button.onclick = returnToScan;
  }

  if (currentMenu === "selfpickup") {
    renderManualSelfPickupControls();
  }
}


// ==================================================
// 46. DOKUMENTASI SELF PICKUP MODE MANUAL
// ==================================================

function renderManualSelfPickupControls() {

  if (
    document.getElementById("manualSelfPickupControls")
  ) return;

  const manualButton = document.getElementById("manualButton");

  if (!manualButton) return;

  const section = document.createElement("div");

  section.id = "manualSelfPickupControls";

  section.style.cssText = `
    margin-top:20px;
    padding-top:15px;
    border-top:1px solid #ddd;
  `;

  section.innerHTML = `
    <h3>Dokumentasi DO</h3>

    <p>
      Ambil foto menggunakan kamera bawaan HP
      atau pilih foto/PDF dari perangkat.
    </p>

    <input
      type="file"
      id="cameraAttachment"
      accept="image/*"
      capture="environment"
      style="display:none"
    >

    <button
      type="button"
      id="capturePhotoButton"
      style="
        display:block;
        width:100%;
        box-sizing:border-box;
        background:#C62828;
        color:white;
        padding:14px;
        border:0;
        border-radius:7px;
        font-weight:bold;
        margin:12px 0;
      "
    >
      AMBIL FOTO
    </button>

    <label
      style="
        display:flex;
        align-items:center;
        justify-content:center;
        width:100%;
        min-height:50px;
        box-sizing:border-box;
        background:#444;
        color:white;
        padding:14px;
        border-radius:7px;
        cursor:pointer;
        text-align:center;
        font-weight:bold;
        margin:12px 0;
      "
    >
      UPLOAD FOTO / PDF

      <input
        type="file"
        id="galleryAttachment"
        accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
        multiple
        hidden
      >
    </label>

    <p id="cameraStatus" style="color:#555">
      Kamera akan dibuka melalui aplikasi kamera bawaan HP.
    </p>

    <div
      id="attachmentPreviewList"
      style="
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:10px;
      "
    ></div>

    <p id="attachmentStatus">Lampiran: 0/10</p>

    <label>Remarks</label>

    <textarea
      id="remarks"
      placeholder="Keterangan (opsional)"
      style="width:100%;box-sizing:border-box"
    ></textarea>

    <button
      id="saveButton"
      type="button"
      style="width:100%;margin-top:15px"
    >
      SIMPAN TRANSAKSI
    </button>

    <p id="saveStatus"></p>
  `;

  manualButton.insertAdjacentElement("afterend", section);

  document.getElementById("cameraAttachment").addEventListener(
    "change",
    handleAttachments
  );

  document.getElementById("galleryAttachment").addEventListener(
    "change",
    handleAttachments
  );

  document.getElementById("capturePhotoButton").onclick = () => {

    if (selectedAttachments.length >= MAX_ATTACHMENTS) {
      showToast("Maksimal 10 lampiran.", "error");
      return;
    }

    document.getElementById("cameraAttachment").click();
  };

  document.getElementById("saveButton").onclick = () => {
    submitScan("selfpickup");
  };

  renderAttachmentPreviews();
}


// ==================================================
// 47. KEMBALI KE SCAN SELF PICKUP
// ==================================================

async function returnToScan() {

  await stopScanner();

  const input = document.getElementById("doNumber");

  if (input) input.value = "";

  inputMethod = "MANUAL";

  renderScanScreen();

  await startScanner();

  const doInput = document.getElementById("doNumber");

  if (doInput) doInput.focus();
}


// ==================================================
// 48. HALAMAN DOKUMENTASI SELF PICKUP
// ==================================================

function openSelfPickupDocumentation() {

  const doInput = document.getElementById("doNumber");

  const doNumber = doInput
    ? doInput.value.trim()
    : "";

  if (!doNumber) {
    showToast("DO Number belum tersedia.", "error");
    return;
  }

  currentStep = "documentation";

  main.innerHTML = `
    <section
      class="form-scan"
      style="max-width:550px;margin:auto;padding:15px"
    >

      <button
        type="button"
        onclick="goHome()"
      >
        ← Kembali
      </button>

      <h2>Dokumentasi Self Pickup</h2>

      <div
        style="
          background:#f5f5f5;
          padding:12px;
          border-radius:8px;
          margin:12px 0;
        "
      >
        <strong>DO Number</strong>

        <p style="font-size:18px;margin:5px 0">
          ${escapeHTML(doNumber)}
        </p>

        <p>Metode input: ${inputMethod}</p>
      </div>

      <input
        type="hidden"
        id="doNumber"
        value="${escapeHTML(doNumber)}"
      >

      <h3>Dokumentasi DO</h3>

      <p>
        Ambil foto menggunakan kamera bawaan HP
        atau pilih foto/PDF dari perangkat.
      </p>

      <input
        type="file"
        id="cameraAttachment"
        accept="image/*"
        capture="environment"
        style="display:none"
      >

      <button
        type="button"
        id="capturePhotoButton"
        style="
          display:block;
          width:100%;
          box-sizing:border-box;
          background:#C62828;
          color:white;
          padding:14px;
          border:0;
          border-radius:7px;
          font-weight:bold;
          margin:12px 0;
        "
      >
        AMBIL FOTO
      </button>

      <label
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          width:100%;
          min-height:50px;
          box-sizing:border-box;
          background:#444;
          color:white;
          padding:14px;
          border-radius:7px;
          cursor:pointer;
          text-align:center;
          font-weight:bold;
          margin:12px 0;
        "
      >
        UPLOAD FOTO / PDF

        <input
          type="file"
          id="galleryAttachment"
          accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
          multiple
          hidden
        >
      </label>

      <p id="cameraStatus" style="color:#555">
        Kamera akan dibuka melalui aplikasi kamera bawaan HP.
      </p>

      <div
        id="attachmentPreviewList"
        style="
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:10px;
        "
      ></div>

      <p id="attachmentStatus">Lampiran: 0/10</p>

      <label>Remarks</label>

      <textarea
        id="remarks"
        placeholder="Keterangan (opsional)"
        style="width:100%;box-sizing:border-box"
      ></textarea>

      <button
        id="saveButton"
        type="button"
        style="width:100%;margin-top:15px"
      >
        SIMPAN TRANSAKSI
      </button>

      <p id="saveStatus"></p>

    </section>
  `;

  document.getElementById("cameraAttachment").addEventListener(
    "change",
    handleAttachments
  );

  document.getElementById("galleryAttachment").addEventListener(
    "change",
    handleAttachments
  );

  document.getElementById("capturePhotoButton").onclick = () => {

    if (selectedAttachments.length >= MAX_ATTACHMENTS) {
      showToast("Maksimal 10 lampiran.", "error");
      return;
    }

    document.getElementById("cameraAttachment").click();
  };

  document.getElementById("saveButton").onclick = () => {
    submitScan("selfpickup");
  };

  renderAttachmentPreviews();
}


// ==================================================
// 49. BERSIHKAN LAMPIRAN
// ==================================================

function clearSelectedAttachments() {

  selectedAttachments.forEach(item => {

    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  });

  selectedAttachments = [];
}


// ==================================================
// 50. PILIH FOTO / PDF
// ==================================================

function handleAttachments(event) {

  const files = Array.from(
    event.target.files || []
  );

  event.target.value = "";

  if (!files.length) return;

  for (const file of files) {

    if (!ALLOWED_TYPES.includes(file.type)) {

      showToast(
        "Format tidak didukung: " + file.name,
        "error"
      );

      continue;
    }

    if (file.size > MAX_FILE_SIZE) {

      showToast(
        file.name + " melebihi batas 5 MB.",
        "error"
      );

      continue;
    }

    if (selectedAttachments.length >= MAX_ATTACHMENTS) {

      showToast("Maksimal 10 lampiran.", "error");

      break;
    }

    const currentTotal = selectedAttachments.reduce(
      (sum, item) => sum + item.file.size,
      0
    );

    if (currentTotal + file.size > MAX_TOTAL_SIZE) {

      showToast(
        "Total lampiran maksimal 20 MB.",
        "error"
      );

      continue;
    }

    selectedAttachments.push({
      file,
      previewUrl: URL.createObjectURL(file)
    });
  }

  renderAttachmentPreviews();
}


// ==================================================
// 51. PREVIEW FOTO DAN PDF
// ==================================================

function renderAttachmentPreviews() {

  const container = document.getElementById(
    "attachmentPreviewList"
  );

  const status = document.getElementById(
    "attachmentStatus"
  );

  if (!container || !status) return;

  container.innerHTML = "";

  selectedAttachments.forEach((item, index) => {

    const card = document.createElement("div");

    card.style.cssText = `
      border:1px solid #ddd;
      border-radius:8px;
      padding:7px;
      min-width:0;
    `;

    if (item.file.type.startsWith("image/")) {

      const img = document.createElement("img");

      img.src = item.previewUrl;

      img.style.cssText = `
        width:100%;
        height:120px;
        object-fit:cover;
        border-radius:5px;
      `;

      card.appendChild(img);

    } else {

      const pdf = document.createElement("div");

      pdf.style.cssText = `
        height:120px;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        background:#fff1f1;
        border-radius:5px;
        color:#C62828;
        font-weight:bold;
      `;

      pdf.innerHTML = `
        <div style="font-size:35px">PDF</div>
        <div style="font-size:12px">Dokumen PDF</div>
      `;

      card.appendChild(pdf);
    }

    const filename = document.createElement("div");

    filename.textContent = item.file.name;

    filename.style.cssText = `
      font-size:11px;
      overflow-wrap:anywhere;
      margin:5px 0;
    `;

    const size = document.createElement("div");

    size.textContent =
      (item.file.size / 1024 / 1024).toFixed(2) + " MB";

    size.style.fontSize = "11px";

    const remove = document.createElement("button");

    remove.type = "button";
    remove.textContent = "HAPUS";

    remove.style.cssText = `
      width:100%;
      margin-top:7px;
      padding:7px;
    `;

    remove.onclick = () => removeAttachment(index);

    card.append(filename, size, remove);

    container.appendChild(card);
  });

  const totalSize = selectedAttachments.reduce(
    (sum, item) => sum + item.file.size,
    0
  );

  status.textContent =
    `Lampiran: ${selectedAttachments.length}/10 | Total: ` +
    (totalSize / 1024 / 1024).toFixed(2) + " MB";
}


// ==================================================
// 52. HAPUS LAMPIRAN
// ==================================================

function removeAttachment(index) {

  const item = selectedAttachments[index];

  if (!item) return;

  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }

  selectedAttachments.splice(index, 1);

  renderAttachmentPreviews();
}


// ==================================================
// 53. KOMPRES FOTO
// ==================================================

async function compressPhoto(file) {

  let bitmap;

  try {

    bitmap = await createImageBitmap(file);

  } catch (error) {

    throw new Error(
      "Gagal membaca foto: " + file.name
    );
  }

  const maxDimension = 1600;

  const scale = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height)
  );

  const canvas = document.createElement("canvas");

  canvas.width = Math.round(bitmap.width * scale);

  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext("2d");

  ctx.drawImage(
    bitmap,
    0,
    0,
    canvas.width,
    canvas.height
  );

  bitmap.close();

  const blob = await new Promise(resolve => {

    canvas.toBlob(
      resolve,
      "image/jpeg",
      0.72
    );
  });

  if (!blob) {
    throw new Error("Gagal mengompres foto.");
  }

  if (blob.size > MAX_FILE_SIZE) {

    throw new Error(
      "Foto " + file.name + " masih melebihi 5 MB."
    );
  }

  return blob;
}


// ==================================================
// 54. BACA FILE BASE64
// ==================================================

function readFileBase64(file) {

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload = () => {

      resolve(
        String(reader.result).split(",")[1]
      );
    };

    reader.onerror = () => {

      reject(
        new Error(
          "Gagal membaca file: " + file.name
        )
      );
    };

    reader.readAsDataURL(file);
  });
}


// ==================================================
// 55. QR SCANNER
// ==================================================

async function startScanner() {

  if (!["scan", "batch"].includes(currentStep)) return;

  if (cameraStarting || scanner) return;

  if (typeof Html5Qrcode === "undefined") {

    showToast(
      "Library QR Scanner belum dimuat.",
      "error"
    );

    return;
  }

  const reader = document.getElementById("reader");

  if (!reader) return;

  cameraStarting = true;

  try {

    scanner = new Html5Qrcode("reader");

    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: {
          width: 250,
          height: 250
        }
      },
      decodedText => {

        handleDOScanned(decodedText);
      },
      () => {}
    );

    try {

      const settings = scanner.getRunningTrackSettings();

      if (settings && settings.deviceId) {

        qrCameraId = settings.deviceId;

        console.log(
          "QR camera ID:",
          qrCameraId
        );
      }

    } catch (cameraInfoError) {

      console.warn(
        "Tidak bisa membaca ID kamera QR:",
        cameraInfoError
      );
    }

  } catch (error) {

    scanner = null;

    console.warn("Scanner kamera:", error);

    showToast(
      "Kamera tidak tersedia. Gunakan scanner PDA atau INPUT MANUAL.",
      "error"
    );

  } finally {

    cameraStarting = false;
  }
}


// ==================================================
// 56. TUTUP SCANNER
// ==================================================

async function stopScanner() {

  if (!scanner) return;

  const currentScanner = scanner;

  scanner = null;

  try {

    await currentScanner.stop();

    await currentScanner.clear();

  } catch (error) {

    console.warn("Scanner:", error);
  }
}


// ==================================================
// 57. KEMBALI DASHBOARD
// ==================================================

async function goHome() {

  await stopScanner();

  clearSelectedAttachments();

  currentMenu = null;
  currentStep = "scan";
  qrCameraId = null;
  activeBatch = null;

  const user = auth.currentUser;

  if (user) {

    await verifyAccess(user);

  } else {

    showLogin();
  }
}


// ==================================================
// 58. RESET FORM SELF PICKUP
// ==================================================

// Implementasi final resetScanForm berada di Bagian 6.


// ==================================================
// AKHIR BAGIAN 5 DARI 6
// BAGIAN 6 DARI 6
// FINALISASI DAN TRANSAKSI SELF PICKUP
// ==================================================


// ==================================================
// 59. TAMPILAN SCAN TRANSAKSI LAMA
// ==================================================

function renderScanScreen() {

  const menu = menus.find(
    item => item.id === currentMenu
  );

  if (!menu) return;

  currentStep = "scan";

  main.innerHTML = `
    <section
      class="form-scan"
      style="max-width:550px;margin:auto;padding:15px"
    >

      <button
        type="button"
        onclick="goHome()"
      >
        ← Kembali
      </button>

      <h2>${escapeHTML(menu.title)}</h2>

      <div
        style="
          background:#e8f5e9;
          padding:10px;
          border-radius:8px;
          margin:12px 0;
          color:#216b32;
          font-weight:bold;
        "
      >
        SCAN MODE AKTIF
      </div>

      <div
        id="reader"
        style="
          width:100%;
          max-width:350px;
          margin:15px auto;
          min-height:200px;
        "
      ></div>

      <p style="text-align:center">
        Arahkan kamera ke QR Code DO atau gunakan
        tombol scanner PDA.
      </p>

      <label for="doNumber">DO Number</label>

      <input
        type="text"
        id="doNumber"
        placeholder="Scan barcode atau input DO Number"
        autocomplete="off"
        style="
          width:100%;
          box-sizing:border-box;
          padding:12px;
        "
      >

      <button
        type="button"
        id="manualButton"
        onclick="switchToManual()"
        style="width:100%;margin-top:12px"
      >
        INPUT MANUAL
      </button>

      ${currentMenu === "trucking" ? `
        <div style="margin-top:15px">
          <label>Logistic Name (Opsional)</label>

          <input
            type="text"
            id="logisticName"
            placeholder="Nama logistik"
            style="width:100%;box-sizing:border-box;padding:12px"
          >
        </div>
      ` : ""}

      ${currentMenu !== "selfpickup" ? `
        <div style="margin-top:15px">

          <label>Remarks</label>

          <textarea
            id="remarks"
            placeholder="Keterangan (opsional)"
            style="width:100%;box-sizing:border-box"
          ></textarea>

          <button
            id="saveButton"
            type="button"
            onclick="submitScan('${currentMenu}')"
            style="width:100%;margin-top:15px"
          >
            SIMPAN
          </button>

          <p id="saveStatus"></p>

        </div>
      ` : ""}

      <p id="inputMethod">
        Metode input: MENUNGGU SCAN
      </p>

    </section>
  `;

  const doInput = document.getElementById("doNumber");

  // Keyboard wedge:
  // Scanner PDA mengirim barcode sebagai teks
  // dan biasanya diakhiri tombol Enter.
  doInput.addEventListener("keydown", event => {

    if (event.key !== "Enter") return;

    event.preventDefault();

    if (currentStep !== "scan") return;

    const value = doInput.value.trim();

    if (!value) return;

    inputMethod = "SCAN";

    handleDOScanned(value);
  });

  if (currentMenu === "trucking") {

    document.getElementById("logisticName").addEventListener(
      "focus",
      () => stopScanner()
    );
  }
}


// ==================================================
// 60. PERBAIKAN EVENT PDA BATCH
// ==================================================

// Ganti fungsi bindBatchScreenEvents dari Bagian 2.
// Setiap input barcode yang diakhiri Enter dianggap SCAN.

function bindBatchScreenEvents() {

  const input = document.getElementById("doNumber");

  const addButton = document.getElementById(
    "addBatchDOButton"
  );

  const scanButton = document.getElementById(
    "batchScanModeButton"
  );

  const manualButton = document.getElementById(
    "batchManualModeButton"
  );

  const reviewButton = document.getElementById(
    "reviewBatchButton"
  );

  const refreshButton = document.getElementById(
    "refreshBatchButton"
  );

  if (!input) return;

  input.addEventListener("keydown", event => {

    if (event.key !== "Enter") return;

    event.preventDefault();

    if (currentStep !== "batch") return;

    if (!input.value.trim()) return;

    // Enter pada kolom DO dianggap sebagai hasil scanner PDA.
    addBatchDO("SCAN");
  });

  addButton.onclick = () => {

    addBatchDO(inputMethod);
  };

  scanButton.onclick = async () => {

    inputMethod = "SCAN";

    updateBatchInputStatus();

    input.focus();

    await startScanner();
  };

  manualButton.onclick = async () => {

    inputMethod = "MANUAL";

    updateBatchInputStatus();

    input.focus();
  };

  refreshButton.onclick = () => {

    renderBatchList();
  };

  reviewButton.onclick = () => {

    reviewBatch();
  };

  updateBatchInputStatus();
}


// ==================================================
// 61. RESET FORM SETELAH SELF PICKUP
// ==================================================

async function resetScanForm(id) {

  await stopScanner();

  clearSelectedAttachments();

  currentStep = "scan";

  inputMethod = "MANUAL";

  qrCameraId = null;

  renderScanScreen();

  await startScanner();

  const input = document.getElementById("doNumber");

  if (input) input.focus();
}


// ==================================================
// 62. SIMPAN TRANSAKSI SELF PICKUP
// ==================================================

async function submitScan(id) {

  if (submitting) return;

  // Batch menu tidak boleh masuk ke transaksi satuan.
  if (BATCH_MENUS.includes(id)) {

    showToast(
      "Menu ini menggunakan Batch Processing.",
      "error"
    );

    return;
  }

  if (id !== "selfpickup") {

    showToast(
      "Menu transaksi ini tidak tersedia dalam alur lama.",
      "error"
    );

    return;
  }

  const doInput = document.getElementById("doNumber");

  const doNumber = doInput
    ? doInput.value.trim()
    : "";

  const remarksInput = document.getElementById("remarks");

  const remarks = remarksInput
    ? remarksInput.value.trim()
    : "";

  const status = document.getElementById("saveStatus");

  const button = document.getElementById("saveButton");

  if (!doNumber) {

    showToast("DO Number wajib diisi!", "error");

    return;
  }

  if (!auth.currentUser) {

    showToast(
      "Sesi login tidak ditemukan.",
      "error"
    );

    return;
  }

  if (selectedAttachments.length === 0) {

    showToast(
      "Minimal satu lampiran wajib disertakan!",
      "error"
    );

    return;
  }

  if (selectedAttachments.length > MAX_ATTACHMENTS) {

    showToast(
      "Maksimal 10 lampiran.",
      "error"
    );

    return;
  }

  if (remarks.length > 1000) {

    showToast(
      "Remarks maksimal 1000 karakter.",
      "error"
    );

    return;
  }

  submitting = true;

  const clientStartedAt = performance.now();

  try {

    button.disabled = true;

    button.textContent = "MENYIAPKAN...";

    if (status) {
      status.textContent = "Menyiapkan transaksi...";
    }

    const token = await auth.currentUser.getIdToken();

    const payload = {
      action: "SCAN",
      idToken: token,
      menu: "selfpickup",
      doNumber: doNumber,
      remarks: remarks,
      inputMethod: inputMethod
    };

    const preparationStartedAt = performance.now();

    const attachments = [];

    for (
      let i = 0;
      i < selectedAttachments.length;
      i++
    ) {

      const item = selectedAttachments[i];

      const file = item.file;

      if (status) {

        status.textContent =
          `Menyiapkan lampiran ${i + 1}/` +
          `${selectedAttachments.length}...`;
      }

      let blob;
      let mimeType;

      if (file.type.startsWith("image/")) {

        blob = await compressPhoto(file);

        mimeType = "image/jpeg";

      } else if (file.type === "application/pdf") {

        blob = file;

        mimeType = "application/pdf";

      } else {

        throw new Error(
          "Format lampiran tidak didukung."
        );
      }

      const fileBase64 = await readFileBase64(blob);

      attachments.push({
        fileBase64: fileBase64,
        mimeType: mimeType
      });
    }

    const totalBytes = attachments.reduce(
      (sum, item) =>
        sum + Math.floor(item.fileBase64.length * 0.75),
      0
    );

    if (totalBytes > MAX_TOTAL_SIZE) {

      throw new Error(
        "Total lampiran melebihi 20 MB."
      );
    }

    payload.attachments = attachments;

    const preparationMs =
      performance.now() - preparationStartedAt;

    if (status) {
      status.textContent = "Mengirim transaksi ke server...";
    }

    button.textContent = "MENGIRIM...";

    const serverStartedAt = performance.now();

    const result = await callAppsScript(payload);

    const serverRoundTripMs =
      performance.now() - serverStartedAt;

    const totalClientMs =
      performance.now() - clientStartedAt;

    if (!result.success) {

      throw new Error(
        result.message || "Penyimpanan gagal."
      );
    }

    console.log("SANY SELF PICKUP PERFORMANCE", {
      menu: id,
      doNumber: doNumber,
      preparationMs: Math.round(preparationMs),
      serverRoundTripMs: Math.round(serverRoundTripMs),
      serverDurationMs: result.durationMs,
      totalClientMs: Math.round(totalClientMs)
    });

    await resetScanForm(id);

    showToast(
      result.message || "Transaksi berhasil disimpan.",
      "success"
    );

  } catch (error) {

    console.error("Simpan Self Pickup:", error);

    if (status) {
      status.textContent = error.message;
    }

    showToast(
      "Gagal menyimpan: " + error.message,
      "error"
    );

    if (button) {

      button.disabled = false;

      button.textContent = "SIMPAN TRANSAKSI";
    }

  } finally {

    submitting = false;
  }
}


// ==================================================
// 63. PEMULIHAN BATCH SAAT HALAMAN DIMUAT
// ==================================================

async function initializeBatchStorage() {

  try {

    await openBatchDatabase();

    console.log(
      "SANY BATCH STORAGE READY"
    );

    if (navigator.storage &&
        navigator.storage.persist) {

      try {

        const persistent =
          await navigator.storage.persist();

        console.log(
          "IndexedDB persistent storage:",
          persistent
        );

      } catch (error) {

        console.warn(
          "Persistent storage tidak tersedia:",
          error
        );
      }
    }

    return true;

  } catch (error) {

    console.error(
      "Batch storage initialization:",
      error
    );

    showToast(
      "Database lokal tidak tersedia: " + error.message,
      "error"
    );

    return false;
  }
}


// ==================================================
// 64. PENUTUP DAN INFORMASI VERSI
// ==================================================

console.log(
  "SANY LOGISTIC SYSTEM FRONTEND v3.1.0 LOADED"
);

console.log(
  "BATCH MENUS:",
  BATCH_MENUS
);

console.log(
  "SELF PICKUP:",
  "LEGACY TRANSACTION MODE"
);

initializeBatchStorage();


// ==================================================
// AKHIR BAGIAN 6 DARI 6
