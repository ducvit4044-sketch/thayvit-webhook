const express = require("express");
const admin = require("firebase-admin");
const path = require("path");

// Khởi tạo Firebase Admin bằng file khóa bảo mật
const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(express.json());

// Hàm sinh mã VIP ngẫu nhiên 6 ký tự độc nhất
function generateUniqueVipCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "VIP_";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Endpoint kiểm tra server còn sống
app.get("/", (req, res) => {
  res.send("Thay Vit Webhook Server is running!");
});

// Endpoint nhận Webhook từ PayOS
app.post("/payos-webhook", async (req, res) => {
  try {
    const webhookData = req.body;

    // 1. Kiểm tra trạng thái giao dịch
    if (webhookData.code !== "00" || !webhookData.data) {
      return res.status(200).json({ message: "Bỏ qua giao dịch chưa hoàn tất" });
    }

    const { description, amount } = webhookData.data;

    // 2. Kiểm tra số tiền chuyển (tối thiểu 49.000đ)
    if (amount < 49000) {
      return res.status(200).json({ message: "Số tiền chuyển chưa đủ 49.000đ" });
    }

    // 3. Trích xuất mã đơn hàng TV...
    const cleanDesc = description.replace(/\s+/g, "").toUpperCase();
    const match = cleanDesc.match(/TV[A-Z0-9]+/i);
    if (!match) {
      return res.status(200).json({ message: "Không tìm thấy mã đơn TV... trong nội dung" });
    }

    const orderNote = match[0];

    // 4. Kiểm tra đơn hàng trong Firestore
    const orderRef = db.collection("payment_orders").doc(orderNote);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(200).json({ message: "Không tìm thấy đơn hàng trên hệ thống" });
    }

    if (orderDoc.data().status === "PAID") {
      return res.status(200).json({ message: "Đơn hàng này đã được kích hoạt trước đó" });
    }

    // 5. Sinh mã VIP duy nhất và cập nhật Firestore
    const newVipCode = generateUniqueVipCode();
    const batch = db.batch();

    const codeRef = db.collection("vip_codes").doc(newVipCode);
    batch.set(codeRef, {
      code: newVipCode,
      isUsed: false,
      usedBy: "",
      orderNote: orderNote,
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
    console.error("Lỗi xử lý Webhook:", error);
    return res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy trên cổng ${PORT}`);
});