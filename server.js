const express = require("express");
const admin = require("firebase-admin");
const path = require("path");
const cors = require("cors");

// 1. SỬA IMPORT: Destructuring trực tiếp class PayOS từ package
const { PayOS } = require("@payos/node");

// Khởi tạo Firebase Admin an toàn (Ưu tiên đọc từ biến môi trường FIREBASE_SERVICE_ACCOUNT trên Render)
if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
    } catch (e) {
      console.error("Lỗi parse FIREBASE_SERVICE_ACCOUNT từ biến môi trường:", e);
    }
  }

  // Fallback đọc file nếu chạy ở máy cá nhân (Local)
  if (!credential) {
    try {
      const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));
      credential = admin.credential.cert(serviceAccount);
    } catch (e) {
      console.error("Không tìm thấy file serviceAccountKey.json local:", e);
    }
  }

  admin.initializeApp({
    credential: credential
  });
}
const db = admin.firestore();

// 2. KHỞI TẠO: Bọc 3 khóa vào một Object { clientId, apiKey, checksumKey }
const payos = new PayOS({
  clientId: "f4b1e039-f6f9-4ed2-ac76-f8cb608983be",
  apiKey: "ab7a7692-1cb3-4a5f-92e8-845fe82c6fe0",
  checksumKey: "e992a7ea872e073eebf6001915f02ec3e059d7c26bf3767bd9a7feac9385df72"
});

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

// 1. API CHO APP GỌI ĐỂ TẠO ĐƠN VÀ LẤY MÃ VIETQR CHUẨN PAYOS
app.post("/create-payment-order", async (req, res) => {
  try {
    const { userId, userEmail, transferNote } = req.body;

    // PayOS yêu cầu orderCode là số nguyên dương duy nhất (tối đa 9007199254740991)
    const orderCode = Number(String(Date.now()).slice(-9)); 

    const paymentData = {
      orderCode: orderCode,
      amount: 2000, // Đổi thành 49000 khi đưa vào sản xuất
      description: (transferNote || "THAYVIT").slice(0, 25), // Tối đa 25 ký tự
      cancelUrl: "https://thayvit-webhook.onrender.com",
      returnUrl: "https://thayvit-webhook.onrender.com"
    };

    // ĐÃ SỬA: Gọi API tương thích với các phiên bản của SDK PayOS
    let paymentLinkRes;
    if (payos.paymentRequests && typeof payos.paymentRequests.create === "function") {
      paymentLinkRes = await payos.paymentRequests.create(paymentData);
    } else if (typeof payos.createPaymentLink === "function") {
      paymentLinkRes = await payos.createPaymentLink(paymentData);
    } else {
      throw new Error("Không tìm thấy hàm tạo link trên PayOS SDK instance");
    }

    // Tạo link ảnh VietQR để app Android hiển thị qua AsyncImage
    const qrImage = `https://api.vietqr.io/image/970422-0933203356-compact2.png?amount=2000&addInfo=${transferNote}&accountName=DO%20THANH%20DANH`;

    // Lưu đơn hàng vào Firestore với Document ID là transferNote để app lắng nghe
    await db.collection("payment_orders").doc(transferNote).set({
      orderCode: orderCode,
      userId: userId || "",
      userEmail: userEmail || "",
      amount: 2000,
      status: "PENDING",
      qrCodeUrl: qrImage,
      paymentLinkId: paymentLinkRes.paymentLinkId || paymentLinkRes.id || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      orderCode: orderCode,
      qrCodeUrl: qrImage
    });
  } catch (error) {
    console.error("Lỗi tạo link thanh toán PayOS:", error);
    return res.status(500).json({ error: error.message });
  }
});

// 2. WEBHOOK NHẬN KẾT QUẢ THANH TOÁN TỪ PAYOS
app.post("/payos-webhook", async (req, res) => {
  try {
    const webhookData = req.body;

    if (webhookData.code !== "00" || !webhookData.data) {
      return res.status(200).json({ message: "Bỏ qua giao dịch chưa hoàn tất" });
    }

    const { description, amount, orderCode } = webhookData.data;

    if (amount < 2000) {
      return res.status(200).json({ message: "Số tiền chưa đủ" });
    }

    // Trích xuất mã đơn TV...
    const cleanDesc = description.replace(/\s+/g, "").toUpperCase();
    const match = cleanDesc.match(/TV[A-Z0-9]+/i);
    let orderDoc = null;
    let orderRef = null;

    if (match) {
      orderRef = db.collection("payment_orders").doc(match[0]);
      orderDoc = await orderRef.get();
    }

    // Dự phòng tìm theo orderCode nếu nội dung ngân hàng bị cắt bớt
    if (!orderDoc || !orderDoc.exists) {
      const querySnapshot = await db.collection("payment_orders")
        .where("orderCode", "==", orderCode)
        .limit(1)
        .get();
      if (!querySnapshot.empty) {
        orderDoc = querySnapshot.docs[0];
        orderRef = orderDoc.ref;
      }
    }

    if (!orderDoc || !orderDoc.exists) {
      return res.status(200).json({ message: "Không tìm thấy đơn hàng trên hệ thống" });
    }

    if (orderDoc.data().status === "PAID") {
      return res.status(200).json({ message: "Đơn hàng đã được thanh toán trước đó" });
    }

    // Sinh mã VIP duy nhất
    const newVipCode = generateUniqueVipCode();
    const batch = db.batch();

    const codeRef = db.collection("vip_codes").doc(newVipCode);
    batch.set(codeRef, {
      code: newVipCode,
      isUsed: false,
      usedBy: "",
      orderNote: orderDoc.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    batch.update(orderRef, {
      status: "PAID",
      generatedCode: newVipCode,
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    return res.status(200).json({ success: true, code: newVipCode });
  } catch (error) {
    console.error("Lỗi Webhook:", error);
    return res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy trên cổng ${PORT}`));