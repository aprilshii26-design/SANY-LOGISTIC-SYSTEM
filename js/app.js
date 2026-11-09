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

// LOGIN
function showLogin(message = "") {
  stopScanner();

  main.innerHTML = `
    <section style="max-width:420px;margin:60px auto;padding:30px;background:white;border-radius:12px;text-align:center;">
      <h2>SANY LOGISTIC SYSTEM</h2>
      <p>Login menggunakan akun Google terdaftar.</p>
      <button id="googleLogin">LOGIN WITH GOOGLE</button>
      <p style="color:#C62828">${message}</p>
    </section>
  `;

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

    const response = await fetch("/api/auth/me", {
      headers: {
        Authorization: "Bearer " + token
      }
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || "Akses ditolak.");
    }

    currentUser = result.user;
    showDashboard();

  } catch (error) {
    console.error(error);
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

  const actionGroup = document.createElement("div");
  actionGroup.style.cssText =
    "display:flex;gap:8px;flex-wrap:wrap;";

  // KHUSUS ADMIN
  if (currentUser.role === "ADMIN") {
    const driveButton = document.createElement("button");

    driveButton.textContent = "HUBUNGKAN GOOGLE DRIVE";

    driveButton.onclick = async () => {
      try {
        driveButton.disabled = true;
        driveButton.textContent = "MENGHUBUNGKAN...";

        const token = await auth.currentUser.getIdToken();

        const response = await fetch("/api/drive/auth", {
          headers: {
            Authorization: "Bearer " + token
          }
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(
            result.message || "Gagal menghubungkan Google Drive."
          );
        }

        window.location.href = result.authUrl;

      } catch (error) {
        alert(error.message);

        driveButton.disabled = false;
        driveButton.textContent = "HUBUNGKAN GOOGLE DRIVE";
      }
    };

    actionGroup.appendChild(driveButton);
  }

  // LOGOUT
  const logout = document.createElement("button");
  logout.textContent = "LOGOUT";

  logout.onclick = async () => {
    stopScanner();
    await auth.signOut();
  };

  actionGroup.appendChild(logout);

  userBar.append(userInfo, actionGroup);
  main.insertBefore(userBar, main.firstChild);
}

// FIREBASE AUTH STATE
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
              accept="image/*"
              capture="environment"
              hidden
            >
          </label>

          <label style="background:#444;color:white;padding:12px;border-radius:7px;cursor:pointer">
            GALERI
            <input
              type="file"
              id="galleryPhoto"
              accept="image/*"
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

  preview.src = URL.createObjectURL(file);
  preview.style.display = "block";

  document.getElementById("photoStatus").textContent =
    "Foto siap diunggah: " + file.name;
}

// QR SCANNER
function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    alert("Library QR Scanner belum berhasil dimuat.");
    return;
  }

  scanner = new Html5Qrcode("reader");

  scanner.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: {
        width: 250,
        height: 250
      }
    },
    decodedText => {
      document.getElementById("doNumber").value =
        decodedText;

      inputMethod = "SCAN";

      document.getElementById("inputMethod").textContent =
        "Metode input: SCAN";

      stopScanner();
    },
    () => {}
  ).catch(error => {
    alert("Kamera gagal dibuka: " + error);
  });
}

// TUTUP SCANNER
function stopScanner() {
  if (scanner) {
    const currentScanner = scanner;
    scanner = null;

    currentScanner.stop()
      .then(() => currentScanner.clear())
      .catch(() => {});
  }
}

// KEMBALI KE DASHBOARD
async function goHome() {
  stopScanner();

  const user = auth.currentUser;

  if (user) {
    await verifyAccess(user);
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

  if (id === "selfpickup" && !selectedPhoto) {
    alert("Foto DO wajib dilampirkan!");
    return;
  }

  const formData = new FormData();

  formData.append("menu", id);
  formData.append("doNumber", doNumber);
  formData.append("remarks", remarks);
  formData.append("inputMethod", inputMethod);

  if (id === "trucking") {
    const logisticName =
      document.getElementById("logisticName").value.trim();

    if (!logisticName) {
      alert("Nama logistik wajib diisi!");
      return;
    }

    formData.append("logisticName", logisticName);
  }

  if (id === "selfpickup") {
    formData.append("fotoDO", selectedPhoto);
  }

  try {
    button.disabled = true;
    button.textContent = "MENYIMPAN...";
    status.textContent = "Mengirim transaksi...";

    const token = await auth.currentUser.getIdToken();

    const response = await fetch("/api/scan", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token
      },
      body: formData
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(
        result.message || "Penyimpanan gagal."
      );
    }

    status.textContent = "Transaksi berhasil disimpan.";

    openMenu(id);

  } catch (error) {
    console.error(error);

    status.textContent = error.message;

    alert("Gagal menyimpan: " + error.message);

  } finally {
    button.disabled = false;
    button.textContent = "SIMPAN";
  }
}