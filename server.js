const express = require("express");
const admin = require("firebase-admin");
const path = require("path");
const cors = require("cors");
const PayOS = require("@payos/node");

// Khởi tạo Firebase Admin an toàn
const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Khởi tạo PayOS SDK theo cấu trúc Object chuẩn
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

    // Gọi PayOS tạo Payment Link
    const paymentLinkRes = await payos.createPaymentLink(paymentData);

    // Lưu đơn hàng vào Firestore với Document ID là transferNote để app lắng nghe
    await db.collection("payment_orders").doc(transferNote).set({
      orderCode: orderCode,
      userId: userId || "",
      userEmail: userEmail || "",
      amount: 2000,
      status: "PENDING",
      qrCodeUrl: paymentLinkRes.qrCode, // Chuỗi QR VietQR Pro từ PayOS
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      orderCode: orderCode,
      qrCodeUrl: paymentLinkRes.qrCode
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