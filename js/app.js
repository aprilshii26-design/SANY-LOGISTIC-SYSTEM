const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzTJ49IkTUY5jvLxD2tvGrZKEAKjDfVNlAEi8xbeMptxy5UxLHFPqQDs8vhi2MdDjDQ/exec";

const menus = [
  { id: "regular", title: "Administrasi Regular" },
  { id: "trucking", title: "Administrasi Trucking" },
  { id: "selfpickup", title: "Administrasi Self Pickup" },
  { id: "return-regular", title: "Return DO Regular" },
  { id: "return-trucking", title: "Return DO Trucking" }
];

const MAX_ATTACHMENTS = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
];

let scanner = null;
let inputMethod = "MANUAL";
let selectedAttachments = [];
let currentUser = null;
let currentMenu = null;
let currentStep = "scan";
let cameraStarting = false;
let documentationStream = null;
let qrCameraId = null;
let submitting = false;

const main = document.querySelector("main");
const originalDashboard = main.innerHTML;
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

googleProvider.setCustomParameters({ prompt: "select_account" });


// ==================================================
// KOMUNIKASI APPS SCRIPT
// ==================================================

function callAppsScript(payload) {
  return new Promise((resolve, reject) => {
    const requestId =
      Date.now().toString(36) + "_" +
      Math.random().toString(36).slice(2);

    const requestPayload = { ...payload, requestId };

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
        new Error("Server tidak memberikan respons. Silakan periksa transaksi sebelum mencoba ulang.")
      );
    }, 180000);

    form.submit();
  });
}


// ==================================================
// NOTIFIKASI
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
// LOGIN
// ==================================================

function showLogin(message = "") {
  stopScanner();
  stopDocumentationCamera();
  clearSelectedAttachments();

  main.innerHTML = `
    <section style="max-width:420px;margin:60px auto;padding:30px;background:white;border-radius:12px;text-align:center;">
      <h2>SANY LOGISTIC SYSTEM</h2>
      <p>Login menggunakan akun Google terdaftar.</p>
      <button id="googleLogin">LOGIN WITH GOOGLE</button>
      <p style="color:#C62828" id="loginMessage"></p>
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
// VERIFIKASI AKSES
// ==================================================

async function verifyAccess(user) {
  try {
    const token = await user.getIdToken();

    const result = await callAppsScript({
      action: "AUTH_ME",
      idToken: token
    });

    if (!result.success) {
      throw new Error(result.message || "Akses ditolak.");
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
// DASHBOARD
// ==================================================

function showDashboard() {
  stopScanner();
  stopDocumentationCamera();
  clearSelectedAttachments();

  main.innerHTML = originalDashboard;

  const userBar = document.createElement("div");

  userBar.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;background:#f5f5f5;border-radius:8px;margin:15px auto;max-width:1000px;";

  const userInfo = document.createElement("span");
  userInfo.textContent = currentUser.email + " | " + currentUser.role;

  const logout = document.createElement("button");
  logout.textContent = "LOGOUT";

  logout.onclick = async () => {
    await stopScanner();
    stopDocumentationCamera();
    await auth.signOut();
  };

  userBar.append(userInfo, logout);
  main.insertBefore(userBar, main.firstChild);
}


// ==================================================
// STATUS LOGIN
// ==================================================

auth.onAuthStateChanged(user => {
  if (user) {
    main.innerHTML =
      "<p style='text-align:center;padding:50px'>Memeriksa akses...</p>";
    verifyAccess(user);
  } else {
    currentUser = null;
    showLogin();
  }
});


// ==================================================
// BUKA MENU
// ==================================================

async function openMenu(id) {
  if (!currentUser) {
    showLogin("Silakan login terlebih dahulu.");
    return;
  }

  if (!menus.find(item => item.id === id)) return;

  await stopScanner();
  await stopDocumentationCamera();
  clearSelectedAttachments();

  currentMenu = id;
  currentStep = "scan";
  inputMethod = "MANUAL";
  qrCameraId = null;

  renderScanScreen();
  await startScanner();

  const input = document.getElementById("doNumber");
  if (input) input.focus();
}


// ==================================================
// TAMPILAN SCAN
// ==================================================

function renderScanScreen() {
  const menu = menus.find(item => item.id === currentMenu);
  if (!menu) return;

  currentStep = "scan";

  main.innerHTML = `
    <section class="form-scan" style="max-width:550px;margin:auto;padding:15px">

      <button type="button" onclick="goHome()">← Kembali</button>

      <h2>${menu.title}</h2>

      <div style="background:#e8f5e9;padding:10px;border-radius:8px;margin:12px 0;color:#216b32;font-weight:bold">
        SCAN MODE AKTIF
      </div>

      <div id="reader"
        style="width:100%;max-width:350px;margin:15px auto;min-height:200px">
      </div>

      <p style="text-align:center">
        Arahkan kamera ke QR Code DO atau gunakan tombol scanner PDA.
      </p>

      <label>DO Number</label>

      <input type="text"
        id="doNumber"
        placeholder="Hasil scan barcode akan muncul di sini"
        autocomplete="off"
        style="width:100%;box-sizing:border-box;padding:12px">

      <button type="button"
        id="manualButton"
        onclick="switchToManual()"
        style="width:100%;margin-top:12px">
        INPUT MANUAL
      </button>

      ${currentMenu === "trucking" ? `
        <div style="margin-top:15px">
          <label>Logistic Name (Opsional)</label>
          <input type="text" id="logisticName"
            placeholder="Nama logistik (boleh dikosongkan)"
            style="width:100%;box-sizing:border-box;padding:12px">
        </div>
      ` : ""}

      ${currentMenu !== "selfpickup" ? `
        <div style="margin-top:15px">
          <label>Remarks</label>
          <textarea id="remarks"
            placeholder="Keterangan (opsional)"
            style="width:100%;box-sizing:border-box"></textarea>

          <button id="saveButton"
            type="button"
            onclick="submitScan('${currentMenu}')"
            style="width:100%;margin-top:15px">
            SIMPAN
          </button>

          <p id="saveStatus"></p>
        </div>
      ` : ""}

      <p id="inputMethod">Metode input: MENUNGGU SCAN</p>
    </section>
  `;

  const doInput = document.getElementById("doNumber");

  doInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();

      if (currentStep !== "scan") return;

      const value = doInput.value.trim();

      if (value && inputMethod !== "MANUAL") {
        inputMethod = "SCAN";
        handleDOScanned(value);
      }
    }
  });

  if (currentMenu === "trucking") {
    document.getElementById("logisticName").addEventListener(
      "focus",
      () => stopScanner()
    );
  }
}


// ==================================================
// MODE MANUAL
// ==================================================

function switchToManual() {
  stopScanner();

  inputMethod = "MANUAL";

  const reader = document.getElementById("reader");
  const method = document.getElementById("inputMethod");
  const button = document.getElementById("manualButton");
  const input = document.getElementById("doNumber");

  if (reader) reader.style.display = "none";

  if (method) method.textContent = "Metode input: MANUAL";

  if (input) {
    input.placeholder = "Ketik DO Number secara manual";
    input.focus();
  }

  if (button) {
    button.textContent = "KEMBALI KE SCAN";
    button.onclick = returnToScan;
  }

  if (currentMenu === "selfpickup") {
    let continueButton = document.getElementById("continuePhotoButton");

    if (!continueButton) {
      continueButton = document.createElement("button");
      continueButton.id = "continuePhotoButton";
      continueButton.type = "button";
      continueButton.textContent = "LANJUT KE FOTO";

      continueButton.style.cssText =
        "width:100%;margin-top:12px;background:#218838;color:white;padding:14px;border:0;border-radius:7px;font-weight:bold;";

      continueButton.onclick = continueManualSelfPickup;

      button.insertAdjacentElement("afterend", continueButton);
    }
  }
}


// ==================================================
// KEMBALI KE SCAN
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
// HASIL SCAN QR / PDA
// ==================================================

async function handleDOScanned(value) {
  const doNumber = String(value || "").trim();

  if (!doNumber || currentStep !== "scan") return;

  const input = document.getElementById("doNumber");
  if (input) input.value = doNumber;

  inputMethod = "SCAN";

  await stopScanner();

  const method = document.getElementById("inputMethod");
  if (method) method.textContent = "Metode input: SCAN";

  if (currentMenu === "selfpickup") {
    openSelfPickupDocumentation();
  } else {
    showToast("DO berhasil terbaca: " + doNumber);
  }
}


// ==================================================
// LANJUT MANUAL SELFPICKUP
// ==================================================

function continueManualSelfPickup() {
  const input = document.getElementById("doNumber");
  const doNumber = input ? input.value.trim() : "";

  if (!doNumber) {
    showToast("DO Number wajib diisi.", "error");
    return;
  }

  inputMethod = "MANUAL";
  openSelfPickupDocumentation();
}


// ==================================================
// DOKUMENTASI SELFPICKUP
// ==================================================

function openSelfPickupDocumentation() {
  const doInput = document.getElementById("doNumber");
  const doNumber = doInput ? doInput.value.trim() : "";

  if (!doNumber) {
    showToast("DO Number belum tersedia.", "error");
    return;
  }

  currentStep = "documentation";

  main.innerHTML = `
    <section class="form-scan" style="max-width:550px;margin:auto;padding:15px">

      <button type="button" onclick="goHome()">← Kembali</button>

      <h2>Dokumentasi Self Pickup</h2>

      <div style="background:#f5f5f5;padding:12px;border-radius:8px;margin:12px 0">
        <strong>DO Number</strong>
        <p style="font-size:18px;margin:5px 0">${escapeHTML(doNumber)}</p>
        <p>Metode input: ${inputMethod}</p>
      </div>

      <input type="hidden" id="doNumber" value="${escapeHTML(doNumber)}">

      <h3>Kamera Dokumentasi</h3>

      <video id="documentationVideo"
        autoplay playsinline muted
        style="width:100%;background:#222;border-radius:10px;min-height:200px;object-fit:contain">
      </video>

      <p id="cameraStatus">Mengaktifkan kamera...</p>

      <button type="button" id="capturePhotoButton"
        style="width:100%;background:#C62828;color:white;padding:14px;border:0;border-radius:7px;font-weight:bold">
        AMBIL FOTO
      </button>

      <div style="margin:15px 0">
        <label style="display:block;background:#444;color:white;padding:12px;border-radius:7px;cursor:pointer;text-align:center">
          UPLOAD FOTO / PDF
          <input type="file"
            id="galleryAttachment"
            accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
            multiple hidden>
        </label>
      </div>

      <div id="attachmentPreviewList"
        style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
      </div>

      <p id="attachmentStatus">Lampiran: 0/10</p>

      <label>Remarks</label>
      <textarea id="remarks"
        placeholder="Keterangan (opsional)"
        style="width:100%;box-sizing:border-box"></textarea>

      <button id="saveButton"
        type="button"
        onclick="submitScan('selfpickup')"
        style="width:100%;margin-top:15px">
        SIMPAN TRANSAKSI
      </button>

      <p id="saveStatus"></p>
    </section>
  `;

  document.getElementById("galleryAttachment").addEventListener(
    "change", handleAttachments
  );

  document.getElementById("capturePhotoButton").onclick =
    captureDocumentationPhoto;

  renderAttachmentPreviews();

  startDocumentationCamera();
}


// ==================================================
// KAMERA DOKUMENTASI: GUNAKAN KAMERA QR YANG SAMA
// ==================================================

async function startDocumentationCamera() {
  const video = document.getElementById("documentationVideo");
  const status = document.getElementById("cameraStatus");

  if (!video || !navigator.mediaDevices?.getUserMedia) {
    if (status) {
      status.textContent =
        "Kamera tidak didukung. Gunakan Upload Foto / PDF.";
    }
    return;
  }

  try {
    await stopDocumentationCamera();

    let constraints;

    if (qrCameraId) {
      constraints = {
        video: {
          deviceId: { exact: qrCameraId }
        },
        audio: false
      };
    } else {
      constraints = {
        video: {
          facingMode: { ideal: "environment" }
        },
        audio: false
      };
    }

    try {
      documentationStream =
        await navigator.mediaDevices.getUserMedia(constraints);

    } catch (cameraError) {
      console.warn(
        "Kamera QR tidak dapat dipakai kembali:",
        cameraError
      );

      // Fallback jika ID kamera tidak lagi tersedia
      documentationStream =
        await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
    }

    if (!document.getElementById("documentationVideo")) {
      await stopDocumentationCamera();
      return;
    }

    video.srcObject = documentationStream;

    const track = documentationStream.getVideoTracks()[0];
    const settings = track ? track.getSettings() : {};

    console.log("Kamera dokumentasi:", settings);

    await video.play();

    if (status) {
      status.textContent =
        "Kamera siap digunakan. Kamera QR digunakan kembali.";
    }

  } catch (error) {
    console.error("Kamera dokumentasi:", error);

    if (status) {
      status.textContent =
        "Kamera gagal dibuka. Periksa izin kamera atau gunakan Upload Foto / PDF.";
    }
  }
}


async function stopDocumentationCamera() {
  if (!documentationStream) return;

  documentationStream.getTracks().forEach(track => {
    track.stop();
  });

  documentationStream = null;
}


// ==================================================
// AMBIL FOTO
// ==================================================

async function captureDocumentationPhoto() {
  const video = document.getElementById("documentationVideo");

  if (!video || !video.videoWidth || !video.videoHeight) {
    showToast("Kamera belum siap.", "error");
    return;
  }

  if (selectedAttachments.length >= MAX_ATTACHMENTS) {
    showToast("Maksimal 10 lampiran.", "error");
    return;
  }

  const canvas = document.createElement("canvas");

  // Gunakan ukuran asli video, jangan dipaksa menjadi rasio lain.
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");

  context.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  const blob = await new Promise(resolve => {
    canvas.toBlob(resolve, "image/jpeg", 0.85);
  });

  if (!blob) {
    showToast("Gagal mengambil foto.", "error");
    return;
  }

  if (blob.size > MAX_FILE_SIZE) {
    showToast("Ukuran foto melebihi 5 MB.", "error");
    return;
  }

  const currentTotal = selectedAttachments.reduce(
    (sum, item) => sum + item.file.size,
    0
  );

  if (currentTotal + blob.size > MAX_TOTAL_SIZE) {
    showToast("Total lampiran melebihi 20 MB.", "error");
    return;
  }

  const file = new File(
    [blob],
    "DO_" + Date.now() + ".jpg",
    { type: "image/jpeg" }
  );

  selectedAttachments.push({
    file,
    previewUrl: URL.createObjectURL(file)
  });

  renderAttachmentPreviews();
  showToast("Foto berhasil ditambahkan.");
}


// ==================================================
// ESCAPE HTML
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
// BERSIHKAN LAMPIRAN
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
// PILIH FOTO / PDF
// ==================================================

function handleAttachments(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";

  if (!files.length) return;

  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      showToast("Format tidak didukung: " + file.name, "error");
      continue;
    }

    if (file.size > MAX_FILE_SIZE) {
      showToast(file.name + " melebihi batas 5 MB.", "error");
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
      showToast("Total lampiran maksimal 20 MB.", "error");
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
// PREVIEW FOTO DAN PDF
// ==================================================

function renderAttachmentPreviews() {
  const container = document.getElementById("attachmentPreviewList");
  const status = document.getElementById("attachmentStatus");

  if (!container || !status) return;

  container.innerHTML = "";

  selectedAttachments.forEach((item, index) => {
    const card = document.createElement("div");

    card.style.cssText =
      "border:1px solid #ddd;border-radius:8px;padding:7px;min-width:0;";

    if (item.file.type.startsWith("image/")) {
      const img = document.createElement("img");

      img.src = item.previewUrl;
      img.style.cssText =
        "width:100%;height:120px;object-fit:cover;border-radius:5px;";

      card.appendChild(img);

    } else {
      const pdf = document.createElement("div");

      pdf.style.cssText =
        "height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff1f1;border-radius:5px;color:#C62828;font-weight:bold;";

      pdf.innerHTML = `
        <div style="font-size:35px">PDF</div>
        <div style="font-size:12px">Dokumen PDF</div>
      `;

      card.appendChild(pdf);
    }

    const filename = document.createElement("div");
    filename.textContent = item.file.name;
    filename.style.cssText =
      "font-size:11px;overflow-wrap:anywhere;margin:5px 0;";

    const size = document.createElement("div");
    size.textContent =
      (item.file.size / 1024 / 1024).toFixed(2) + " MB";
    size.style.fontSize = "11px";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "HAPUS";
    remove.style.cssText = "width:100%;margin-top:7px;padding:7px;";
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
// HAPUS LAMPIRAN
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
// KOMPRES FOTO
// ==================================================

async function compressPhoto(file) {
  let bitmap;

  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new Error("Gagal membaca foto: " + file.name);
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
    canvas.toBlob(resolve, "image/jpeg", 0.72);
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
// BACA FILE BASE64
// ==================================================

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(String(reader.result).split(",")[1]);
    };

    reader.onerror = () => {
      reject(new Error("Gagal membaca file: " + file.name));
    };

    reader.readAsDataURL(file);
  });
}


// ==================================================
// QR SCANNER
// ==================================================

async function startScanner() {
  if (currentStep !== "scan") return;
  if (cameraStarting || scanner) return;

  if (typeof Html5Qrcode === "undefined") {
    showToast("Library QR Scanner belum dimuat.", "error");
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
        qrbox: { width: 250, height: 250 }
      },
      decodedText => {
        handleDOScanned(decodedText);
      },
      () => {}
    );

    // Simpan deviceId kamera yang benar-benar dipakai QR.
    try {
      const settings = scanner.getRunningTrackSettings();

      if (settings && settings.deviceId) {
        qrCameraId = settings.deviceId;
        console.log("QR camera ID:", qrCameraId);
      }
    } catch (cameraInfoError) {
      console.warn("Tidak bisa membaca ID kamera QR:", cameraInfoError);
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
// TUTUP SCANNER
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
// KEMBALI DASHBOARD
// ==================================================

async function goHome() {
  await stopScanner();
  await stopDocumentationCamera();

  clearSelectedAttachments();

  currentMenu = null;
  currentStep = "scan";
  qrCameraId = null;

  const user = auth.currentUser;

  if (user) {
    await verifyAccess(user);
  } else {
    showLogin();
  }
}


// ==================================================
// RESET FORM
// ==================================================

async function resetScanForm(id) {
  await stopScanner();
  await stopDocumentationCamera();

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
// SIMPAN TRANSAKSI
// ==================================================

async function submitScan(id) {
  if (submitting) return;

  const doInput = document.getElementById("doNumber");
  const doNumber = doInput ? doInput.value.trim() : "";

  const remarksInput = document.getElementById("remarks");
  const remarks = remarksInput ? remarksInput.value.trim() : "";

  const status = document.getElementById("saveStatus");
  const button = document.getElementById("saveButton");

  if (!doNumber) {
    showToast("DO Number wajib diisi!", "error");
    return;
  }

  if (!auth.currentUser) {
    showToast("Sesi login tidak ditemukan.", "error");
    return;
  }

  if (id === "selfpickup" && selectedAttachments.length === 0) {
    showToast("Minimal satu lampiran wajib disertakan!", "error");
    return;
  }

  if (id === "selfpickup" && selectedAttachments.length > MAX_ATTACHMENTS) {
    showToast("Maksimal 10 lampiran.", "error");
    return;
  }

  let logisticName = "";

  if (id === "trucking") {
    const logisticInput = document.getElementById("logisticName");
    logisticName = logisticInput ? logisticInput.value.trim() : "";
  }

  submitting = true;

  const clientStartedAt = performance.now();

  try {
    button.disabled = true;
    button.textContent = "MENYIAPKAN...";

    if (status) status.textContent = "Menyiapkan transaksi...";

    const token = await auth.currentUser.getIdToken();

    const payload = {
      action: "SCAN",
      idToken: token,
      menu: id,
      doNumber,
      logisticName,
      remarks,
      inputMethod
    };

    let preparationMs = 0;

    if (id === "selfpickup") {
      const preparationStartedAt = performance.now();
      const attachments = [];

      for (let i = 0; i < selectedAttachments.length; i++) {
        const item = selectedAttachments[i];
        const file = item.file;

        if (status) {
          status.textContent =
            `Menyiapkan lampiran ${i + 1}/${selectedAttachments.length}...`;
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
          throw new Error("Format lampiran tidak didukung.");
        }

        const fileBase64 = await readFileBase64(blob);

        attachments.push({
          fileBase64,
          mimeType
        });
      }

      const totalBytes = attachments.reduce(
        (sum, item) =>
          sum + Math.floor(item.fileBase64.length * 0.75),
        0
      );

      if (totalBytes > MAX_TOTAL_SIZE) {
        throw new Error("Total lampiran melebihi 20 MB.");
      }

      payload.attachments = attachments;

      preparationMs = performance.now() - preparationStartedAt;
    }

    if (status) status.textContent = "Mengirim transaksi ke server...";

    button.textContent = "MENGIRIM...";

    const serverStartedAt = performance.now();

    const result = await callAppsScript(payload);

    const serverRoundTripMs = performance.now() - serverStartedAt;
    const totalClientMs = performance.now() - clientStartedAt;

    if (!result.success) {
      throw new Error(result.message || "Penyimpanan gagal.");
    }

    console.log("SANY TRANSACTION PERFORMANCE", {
      menu: id,
      doNumber,
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

    console.log(
      "Transaksi berhasil. Waktu respons server:",
      (serverRoundTripMs / 1000).toFixed(2),
      "detik"
    );

  } catch (error) {
    console.error("Simpan transaksi:", error);

    if (status) status.textContent = error.message;

    showToast("Gagal menyimpan: " + error.message, "error");

    if (button) {
      button.disabled = false;
      button.textContent = "SIMPAN TRANSAKSI";
    }

  } finally {
    submitting = false;
  }
}
