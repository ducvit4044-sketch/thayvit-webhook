const express = require("express");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { PayOS } = require("@payos/node");

// ---------------------------------------------------------------
// 1. FIREBASE ADMIN
//    Ưu tiên: biến FIREBASE_SERVICE_ACCOUNT (JSON) -> Secret File của Render
//    -> GOOGLE_APPLICATION_CREDENTIALS -> file serviceAccountKey.json cạnh server.js (chỉ để chạy local)
// ---------------------------------------------------------------
function loadServiceAccount() {
  let sa = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    const candidates = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      "/etc/secrets/serviceAccountKey.json", // Secret File trên Render
      path.join(__dirname, "serviceAccountKey.json"), // local
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log("Đọc service account từ:", p);
        sa = JSON.parse(fs.readFileSync(p, "utf8"));
        break;
      }
    }
  }

  if (!sa) {
    throw new Error(
      "Không tìm thấy service account. Hãy tạo Secret File 'serviceAccountKey.json' hoặc biến FIREBASE_SERVICE_ACCOUNT trên Render."
    );
  }
  if (sa.private_key) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  return sa;
}

const serviceAccount = loadServiceAccount();
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
console.log("Firebase project:", serviceAccount.project_id);
const db = admin.firestore();

// Kiểm tra kết nối Firestore ngay lúc khởi động để thấy lỗi xác thực sớm trong log
db.collection("payment_orders")
  .limit(1)
  .get()
  .then(() => console.log("Firestore: kết nối OK"))
  .catch((e) => console.error("Firestore: KẾT NỐI LỖI ->", e.message));

// ---------------------------------------------------------------
// 2. PAYOS (khoá lấy từ biến môi trường trên Render, KHÔNG viết vào code)
// ---------------------------------------------------------------
const { PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY } = process.env;
if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY || !PAYOS_CHECKSUM_KEY) {
  console.error(
    "THIẾU biến môi trường PayOS: PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY"
  );
}
const payos = new PayOS({
  clientId: PAYOS_CLIENT_ID,
  apiKey: PAYOS_API_KEY,
  checksumKey: PAYOS_CHECKSUM_KEY,
});

const APP_URL = process.env.APP_URL || "https://thayvit-webhook.onrender.com";
const PRICE = 2000;

const app = express();
app.use(cors());
app.use(express.json());

function generateUniqueVipCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "VIP_";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

app.get("/", (req, res) => {
  res.send("Thay Vit Webhook Server is running!");
});

// ---------------------------------------------------------------
// 3. APP GỌI ĐỂ TẠO ĐƠN VÀ LẤY MÃ QR
// ---------------------------------------------------------------
app.post("/create-payment-order", async (req, res) => {
  const { userId, userEmail, transferNote } = req.body || {};
  const orderCode = Number(String(Date.now()).slice(-9));

  // Bước A: tạo link thanh toán PayOS
  let link;
  try {
    // Mô tả phải ngắn, không dấu (tối đa 9 ký tự nếu tài khoản không liên kết qua payOS, 25 nếu có)
    const desc = String(transferNote || `TV${orderCode}`)
      .replace(/[^A-Za-z0-9 ]/g, "")
      .slice(0, 25);

    link = await payos.paymentRequests.create({
      orderCode,
      amount: PRICE,
      description: desc,
      cancelUrl: APP_URL,
      returnUrl: APP_URL,
    });
  } catch (error) {
    console.error("[PAYOS] Lỗi tạo link thanh toán:", error);
    return res.status(500).json({ error: "PAYOS: " + error.message });
  }

  // QR dùng đúng thông tin tài khoản + nội dung do PayOS trả về,
  // để PayOS nhận diện được giao dịch và gọi webhook.
  const qrImage =
    `https://img.vietqr.io/image/${link.bin}-${link.accountNumber}-compact2.png` +
    `?amount=${link.amount}&addInfo=${encodeURIComponent(link.description)}` +
    `&accountName=${encodeURIComponent(link.accountName || "")}`;

  // Bước B: lưu đơn vào Firestore
  try {
    const docId = String(transferNote || `TV${orderCode}`).replace(/[^A-Za-z0-9_-]/g, "");
    await db.collection("payment_orders").doc(docId).set({
      orderCode,
      userId: userId || "",
      userEmail: userEmail || "",
      amount: PRICE,
      status: "PENDING",
      qrCodeUrl: qrImage,
      paymentLinkId: link.paymentLinkId || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      orderCode,
      qrCodeUrl: qrImage,
      checkoutUrl: link.checkoutUrl || "",
      qrCode: link.qrCode || "",
    });
  } catch (error) {
    console.error("[FIRESTORE] Lỗi lưu đơn hàng:", error);
    return res.status(500).json({ error: "FIRESTORE: " + error.message });
  }
});

// App hỏi trạng thái đơn (dùng song song với webhook)
app.get("/order-status/:orderCode", async (req, res) => {
  try {
    const snap = await db
      .collection("payment_orders")
      .where("orderCode", "==", Number(req.params.orderCode))
      .limit(1)
      .get();
    if (snap.empty) return res.status(404).json({ error: "Không thấy đơn" });
    const d = snap.docs[0].data();
    return res.json({ status: d.status, code: d.status === "PAID" ? d.generatedCode : null });
  } catch (error) {
    console.error("[ORDER-STATUS]", error);
    return res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------
// 4. WEBHOOK NHẬN KẾT QUẢ THANH TOÁN TỪ PAYOS
// ---------------------------------------------------------------
app.post("/payos-webhook", async (req, res) => {
  // Xác thực chữ ký: chặn người lạ giả mạo webhook để lấy mã VIP miễn phí
  let data;
  try {
    if (payos.webhooks && typeof payos.webhooks.verify === "function") {
      data = await payos.webhooks.verify(req.body);
    } else {
      data = payos.verifyPaymentWebhookData(req.body);
    }
  } catch (error) {
    console.error("[WEBHOOK] Chữ ký không hợp lệ:", error.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    if (req.body.code !== "00") {
      return res.status(200).json({ message: "Bỏ qua giao dịch chưa hoàn tất" });
    }

    const { description, amount, orderCode } = data;
    if (amount < PRICE) {
      return res.status(200).json({ message: "Số tiền chưa đủ" });
    }

    // Tìm đơn: ưu tiên theo orderCode (đáng tin nhất), sau đó theo nội dung chuyển khoản
    let orderRef = null;
    const byCode = await db
      .collection("payment_orders")
      .where("orderCode", "==", orderCode)
      .limit(1)
      .get();
    if (!byCode.empty) {
      orderRef = byCode.docs[0].ref;
    } else {
      const clean = String(description || "").replace(/\s+/g, "").toUpperCase();
      const match = clean.match(/TV[A-Z0-9]+/);
      if (match) {
        const ref = db.collection("payment_orders").doc(match[0]);
        if ((await ref.get()).exists) orderRef = ref;
      }
    }

    if (!orderRef) {
      return res.status(200).json({ message: "Không tìm thấy đơn hàng trên hệ thống" });
    }

    // Dùng transaction để webhook gọi trùng không tạo 2 mã VIP
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(orderRef);
      if (snap.data().status === "PAID") {
        return { already: true, code: snap.data().generatedCode };
      }
      const newVipCode = generateUniqueVipCode();
      t.set(db.collection("vip_codes").doc(newVipCode), {
        code: newVipCode,
        isUsed: false,
        usedBy: "",
        orderNote: snap.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      t.update(orderRef, {
        status: "PAID",
        generatedCode: newVipCode,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { already: false, code: newVipCode };
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("[WEBHOOK] Lỗi xử lý:", error);
    return res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy trên cổng ${PORT}`));