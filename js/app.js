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
let selectedPhoto = null;
let currentUser = null;

const main = document.querySelector("main");
const originalDashboard = main.innerHTML;
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});

// KOMUNIKASI GITHUB PAGES KE APPS SCRIPT
function callAppsScript(payload) {
  return new Promise((resolve, reject) => {
    const requestId =
      Date.now().toString(36) + "_" +
      Math.random().toString(36).slice(2);

    const requestPayload = {
      ...payload,
      requestId: requestId
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
        new Error("Server tidak memberikan respons. Silakan coba lagi.")
      );
    }, 120000);

    form.submit();
  });
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

  userInfo.textContent =
    currentUser.email + " | " + currentUser.role;

  const logout = document.createElement("button");

  logout.textContent = "LOGOUT";

  logout.onclick = async () => {
    stopScanner();
    await auth.signOut();
  };

  userBar.append(userInfo, logout);
  main.insertBefore(userBar, main.firstChild);
}

// STATUS LOGIN FIREBASE
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

  inputMethod = "MANUAL";
  selectedPhoto = null;

  main.innerHTML = `
    <section class="form-scan">

      <button onclick="goHome()">← Kembali</button>

      <h2>${menu.title}</h2>

      <label>DO Number</label>
      <input
        type="text"
        id="doNumber"
        placeholder="Scan QR atau ketik DO Number"
        autocomplete="off"
      >

      ${id === "trucking" ? `
        <label>Logistic Name</label>
        <input
          type="text"
          id="logisticName"
          placeholder="Nama logistik"
        >
      ` : ""}

      ${id === "selfpickup" ? `
        <label>Foto DO</label>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">

          <label style="background:#C62828;color:white;padding:12px;border-radius:7px;cursor:pointer">
            KAMERA
            <input
              type="file"
              id="cameraPhoto"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              hidden
            >
          </label>

          <label style="background:#444;color:white;padding:12px;border-radius:7px;cursor:pointer">
            GALERI
            <input
              type="file"
              id="galleryPhoto"
              accept="image/jpeg,image/png,image/webp"
              hidden
            >
          </label>

        </div>

        <img
          id="photoPreview"
          style="display:none;width:100%;max-width:350px;border-radius:8px;margin:10px 0"
        >

        <p id="photoStatus">Belum ada foto dipilih.</p>
      ` : ""}

      <label>Remarks</label>

      <textarea
        id="remarks"
        placeholder="Keterangan (opsional)"
      ></textarea>

      <div
        id="reader"
        style="width:100%;max-width:350px;margin:15px 0"
      ></div>

      <button onclick="startScanner()">SCAN QR CODE</button>
      <button onclick="stopScanner()">TUTUP KAMERA</button>

      <p id="inputMethod">Metode input: MANUAL</p>

      <button id="saveButton" onclick="submitScan('${id}')">
        SIMPAN
      </button>

      <p id="saveStatus"></p>

    </section>
  `;

  document.getElementById("doNumber").addEventListener(
    "input",
    () => {
      inputMethod = "MANUAL";

      document.getElementById("inputMethod").textContent =
        "Metode input: MANUAL";
    }
  );

  if (id === "selfpickup") {
    document.getElementById("cameraPhoto").addEventListener(
      "change",
      handlePhoto
    );

    document.getElementById("galleryPhoto").addEventListener(
      "change",
      handlePhoto
    );
  }
}

// FOTO SELF PICKUP
function handlePhoto(event) {
  const file = event.target.files[0];

  if (!file) return;

  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type)
  ) {
    alert("Format foto harus JPG, PNG, atau WEBP.");
    event.target.value = "";
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    alert("Ukuran foto maksimal 8 MB.");
    event.target.value = "";
    return;
  }

  selectedPhoto = file;

  const preview = document.getElementById("photoPreview");

  if (preview.dataset.objectUrl) {
    URL.revokeObjectURL(preview.dataset.objectUrl);
  }

  const objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  preview.dataset.objectUrl = objectUrl;
  preview.style.display = "block";

  document.getElementById("photoStatus").textContent =
    "Foto siap diunggah: " + file.name;
}

// KONVERSI FOTO KE BASE64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.split(",")[1]);
    };

    reader.onerror = () => {
      reject(new Error("Gagal membaca foto."));
    };

    reader.readAsDataURL(file);
  });
}

// QR SCANNER
async function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    alert("Library QR Scanner belum berhasil dimuat.");
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

        if (method) {
          method.textContent = "Metode input: SCAN";
        }

        stopScanner();
      },
      () => {}
    );
  } catch (error) {
    scanner = null;
    alert("Kamera gagal dibuka: " + error);
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

  const user = auth.currentUser;

  if (user) {
    await verifyAccess(user);
  } else {
    showLogin();
  }
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
    alert("DO Number wajib diisi!");
    return;
  }

  if (!auth.currentUser) {
    alert("Sesi login tidak ditemukan. Silakan login kembali.");
    return;
  }

  let logisticName = "";

  if (id === "trucking") {
    logisticName =
      document.getElementById("logisticName").value.trim();

    if (!logisticName) {
      alert("Nama logistik wajib diisi!");
      return;
    }
  }

  if (id === "selfpickup" && !selectedPhoto) {
    alert("Foto DO wajib dilampirkan!");
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
      doNumber: doNumber,
      logisticName: logisticName,
      remarks: remarks,
      inputMethod: inputMethod
    };

    if (id === "selfpickup") {
      status.textContent = "Membaca foto...";

      payload.photoBase64 = await fileToBase64(selectedPhoto);
      payload.photoMimeType = selectedPhoto.type;
    }

    status.textContent = "Mengirim transaksi ke server...";

    const result = await callAppsScript(payload);

    if (!result.success) {
      throw new Error(result.message || "Penyimpanan gagal.");
    }

    status.textContent =
      result.message || "Transaksi berhasil disimpan.";

    alert("Transaksi berhasil disimpan!");

    selectedPhoto = null;
    stopScanner();
    await goHome();

  } catch (error) {
    console.error("Simpan transaksi:", error);

    status.textContent = error.message;
    alert("Gagal menyimpan: " + error.message);

  } finally {
    if (document.getElementById("saveButton")) {
      button.disabled = false;
      button.textContent = "SIMPAN";
    }
  }
}
