const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzTJ49IkTUY5jvLxD2tvGrZKEAKjDfVNlAEi8xbeMptxy5UxLHFPqQDs8vhi2MdDjDQ/exec";

const menus = [
  { id: "regular", title: "Administrasi Regular" },
  { id: "trucking", title: "Administrasi Trucking" },
  { id: "selfpickup", title: "Administrasi Self Pickup" },
  { id: "return-regular", title: "Return DO Regular" },
  { id: "return-trucking", title: "Return DO Trucking" }
];

let scanner = null;
let inputMethod = "MANUAL";
let selectedPhotos = [];
let currentUser = null;

const main = document.querySelector("main");
const originalDashboard = main.innerHTML;
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

googleProvider.setCustomParameters({ prompt: "select_account" });

// KOMUNIKASI APPS SCRIPT
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
        new Error("Server tidak memberikan respons. Silakan coba lagi.")
      );
    }, 120000);

    form.submit();
  });
}

// NOTIFIKASI OTOMATIS
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

  toast.style.background = type === "success" ? "#218838" : "#C62828";
  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toast.style.display = "none";
  }, 2500);
}

// LOGIN
function showLogin(message = "") {
  stopScanner();

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

// VERIFIKASI AKSES
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

// DASHBOARD
function showDashboard() {
  main.innerHTML = originalDashboard;

  const userBar = document.createElement("div");

  userBar.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;background:#f5f5f5;border-radius:8px;margin:15px auto;max-width:1000px;";

  const userInfo = document.createElement("span");
  userInfo.textContent = currentUser.email + " | " + currentUser.role;

  const logout = document.createElement("button");
  logout.textContent = "LOGOUT";

  logout.onclick = async () => {
    stopScanner();
    await auth.signOut();
  };

  userBar.append(userInfo, logout);
  main.insertBefore(userBar, main.firstChild);
}

// STATUS LOGIN
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

// BUKA MENU
function openMenu(id) {
  if (!currentUser) {
    showLogin("Silakan login terlebih dahulu.");
    return;
  }

  const menu = menus.find(item => item.id === id);
  if (!menu) return;

  stopScanner();
  clearSelectedPhotos();

  inputMethod = "MANUAL";

  main.innerHTML = `
    <section class="form-scan">

      <button onclick="goHome()">← Kembali</button>

      <h2>${menu.title}</h2>

      <label>DO Number</label>
      <input type="text" id="doNumber"
        placeholder="Scan QR atau ketik DO Number"
        autocomplete="off">

      ${id === "trucking" ? `
        <label>Logistic Name (Opsional)</label>
        <input type="text" id="logisticName"
          placeholder="Nama logistik (boleh dikosongkan)">
      ` : ""}

      ${id === "selfpickup" ? `
        <label>Foto DO (Maksimal 10 foto)</label>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">

          <label style="background:#C62828;color:white;padding:12px;border-radius:7px;cursor:pointer">
            KAMERA
            <input type="file" id="cameraPhoto"
              accept="image/jpeg,image/png,image/webp"
              capture="environment" multiple hidden>
          </label>

          <label style="background:#444;color:white;padding:12px;border-radius:7px;cursor:pointer">
            GALERI
            <input type="file" id="galleryPhoto"
              accept="image/jpeg,image/png,image/webp"
              multiple hidden>
          </label>

        </div>

        <div id="photoPreviewList"
          style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
        </div>

        <p id="photoStatus">Belum ada foto dipilih (0/10).</p>
      ` : ""}

      <label>Remarks</label>
      <textarea id="remarks"
        placeholder="Keterangan (opsional)"></textarea>

      <div id="reader"
        style="width:100%;max-width:350px;margin:15px 0"></div>

      <button onclick="startScanner()">SCAN QR CODE</button>
      <button onclick="stopScanner()">TUTUP KAMERA</button>

      <p id="inputMethod">Metode input: MANUAL</p>

      <button id="saveButton" onclick="submitScan('${id}')">
        SIMPAN
      </button>

      <p id="saveStatus"></p>

    </section>
  `;

  document.getElementById("doNumber").addEventListener("input", () => {
    inputMethod = "MANUAL";
    document.getElementById("inputMethod").textContent =
      "Metode input: MANUAL";
  });

  if (id === "selfpickup") {
    document.getElementById("cameraPhoto").addEventListener(
      "change", handlePhoto
    );

    document.getElementById("galleryPhoto").addEventListener(
      "change", handlePhoto
    );
  }
}

// BERSIHKAN FOTO
function clearSelectedPhotos() {
  selectedPhotos.forEach(photo => {
    URL.revokeObjectURL(photo.previewUrl);
  });

  selectedPhotos = [];
}

// PILIH FOTO
function handlePhoto(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";

  if (!files.length) return;

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  for (const file of files) {
    if (!allowedTypes.includes(file.type)) {
      showToast("Format foto harus JPG, PNG, atau WEBP.", "error");
      continue;
    }

    if (file.size > 8 * 1024 * 1024) {
      showToast("Ukuran setiap foto maksimal 8 MB.", "error");
      continue;
    }

    if (selectedPhotos.length >= 10) {
      showToast("Maksimal 10 foto per transaksi.", "error");
      break;
    }

    selectedPhotos.push({
      file,
      previewUrl: URL.createObjectURL(file)
    });
  }

  renderPhotoPreviews();
}

// TAMPILKAN PREVIEW
function renderPhotoPreviews() {
  const container = document.getElementById("photoPreviewList");
  const status = document.getElementById("photoStatus");

  if (!container || !status) return;

  container.innerHTML = "";

  selectedPhotos.forEach((photo, index) => {
    const card = document.createElement("div");
    card.style.cssText =
      "position:relative;border:1px solid #ddd;border-radius:8px;padding:5px;";

    const img = document.createElement("img");
    img.src = photo.previewUrl;
    img.style.cssText =
      "width:100%;height:120px;object-fit:cover;border-radius:5px;";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "HAPUS";
    remove.style.cssText =
      "width:100%;margin:5px 0 0;padding:7px;";

    remove.onclick = () => removePhoto(index);

    card.append(img, remove);
    container.appendChild(card);
  });

  status.textContent =
    `Foto dipilih: ${selectedPhotos.length}/10`;
}

// HAPUS FOTO
function removePhoto(index) {
  const photo = selectedPhotos[index];
  if (!photo) return;

  URL.revokeObjectURL(photo.previewUrl);
  selectedPhotos.splice(index, 1);
  renderPhotoPreviews();
}

// KOMPRES FOTO KE JPEG BASE64
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
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise(resolve => {
    canvas.toBlob(resolve, "image/jpeg", 0.72);
  });

  if (!blob) {
    throw new Error("Gagal mengompres foto.");
  }

  if (blob.size > 1024 * 1024) {
    throw new Error(
      "Foto " + file.name + " masih terlalu besar setelah kompresi."
    );
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(String(reader.result).split(",")[1]);
    };

    reader.onerror = () => reject(
      new Error("Gagal membaca hasil kompresi foto.")
    );

    reader.readAsDataURL(blob);
  });
}

// QR SCANNER
async function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    showToast("Library QR Scanner belum dimuat.", "error");
    return;
  }

  if (scanner) return;

  scanner = new Html5Qrcode("reader");

  try {
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 }
      },
      decodedText => {
        const input = document.getElementById("doNumber");

        if (input) input.value = decodedText;

        inputMethod = "SCAN";

        const method = document.getElementById("inputMethod");
        if (method) method.textContent = "Metode input: SCAN";

        stopScanner();
      },
      () => {}
    );
  } catch (error) {
    scanner = null;
    showToast("Kamera gagal dibuka: " + error, "error");
  }
}

// TUTUP SCANNER
function stopScanner() {
  if (!scanner) return;

  const currentScanner = scanner;
  scanner = null;

  currentScanner.stop()
    .then(() => currentScanner.clear())
    .catch(error => console.warn("Scanner:", error));
}

// KEMBALI KE DASHBOARD
async function goHome() {
  stopScanner();

  clearSelectedPhotos();

  const user = auth.currentUser;

  if (user) {
    await verifyAccess(user);
  } else {
    showLogin();
  }
}

// RESET FORM SETELAH SIMPAN
function resetScanForm(id) {
  document.getElementById("doNumber").value = "";

  document.getElementById("remarks").value = "";

  const logistic = document.getElementById("logisticName");
  if (logistic) logistic.value = "";

  clearSelectedPhotos();

  const preview = document.getElementById("photoPreviewList");
  if (preview) preview.innerHTML = "";

  const photoStatus = document.getElementById("photoStatus");
  if (photoStatus) photoStatus.textContent = "Belum ada foto dipilih (0/10).";

  inputMethod = "MANUAL";

  const method = document.getElementById("inputMethod");
  if (method) method.textContent = "Metode input: MANUAL";

  const status = document.getElementById("saveStatus");
  if (status) status.textContent = "";

  const button = document.getElementById("saveButton");
  if (button) {
    button.disabled = false;
    button.textContent = "SIMPAN";
  }

  document.getElementById("doNumber").focus();
}

// SIMPAN TRANSAKSI
async function submitScan(id) {
  const doNumber =
    document.getElementById("doNumber").value.trim();

  const remarks =
    document.getElementById("remarks").value.trim();

  const status =
    document.getElementById("saveStatus");

  const button =
    document.getElementById("saveButton");

  if (!doNumber) {
    showToast("DO Number wajib diisi!", "error");
    return;
  }

  if (!auth.currentUser) {
    showToast("Sesi login tidak ditemukan.", "error");
    return;
  }

  let logisticName = "";

  if (id === "trucking") {
    const logisticInput = document.getElementById("logisticName");
    logisticName = logisticInput
      ? logisticInput.value.trim()
      : "";
  }

  if (id === "selfpickup" && selectedPhotos.length === 0) {
    showToast("Minimal satu foto DO wajib dilampirkan!", "error");
    return;
  }

  try {
    button.disabled = true;
    button.textContent = "MENYIMPAN...";
    status.textContent = "Menyiapkan transaksi...";

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

    if (id === "selfpickup") {
      if (selectedPhotos.length > 10) {
        throw new Error("Maksimal 10 foto.");
      }

      status.textContent =
        `Mengompres ${selectedPhotos.length} foto...`;

      const photos = [];

      for (const photo of selectedPhotos) {
        const photoBase64 = await compressPhoto(photo.file);

        photos.push({
          photoBase64,
          photoMimeType: "image/jpeg"
        });
      }

      const totalBytes = photos.reduce(
        (total, photo) =>
          total + Math.ceil(photo.photoBase64.length * 0.75),
        0
      );

      if (totalBytes > 8 * 1024 * 1024) {
        throw new Error(
          "Total ukuran foto melebihi 8 MB. Kurangi jumlah atau ukuran foto."
        );
      }

      payload.photos = photos;
    }

    status.textContent = "Mengirim transaksi...";

    const result = await callAppsScript(payload);

    if (!result.success) {
      throw new Error(result.message || "Penyimpanan gagal.");
    }

    resetScanForm(id);

    showToast(
      result.message || "Transaksi berhasil disimpan.",
      "success"
    );

  } catch (error) {
    console.error("Simpan transaksi:", error);

    status.textContent = error.message;

    showToast("Gagal menyimpan: " + error.message, "error");

    button.disabled = false;
    button.textContent = "SIMPAN";
  }
}
