const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Hàm sinh mã ngẫu nhiên 6 ký tự độc nhất (VD: VIP_9A8B2C)
function generateUniqueVipCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "VIP_";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Webhook lắng nghe PayOS gọi sang khi có biến động số dư thành công
exports.payosWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const webhookData = req.body;

    // 1. Kiểm tra trạng thái giao dịch từ PayOS
    if (webhookData.code !== "00" || !webhookData.data) {
      return res.status(200).json({ message: "Bỏ qua giao dịch chưa hoàn tất" });
    }

    const { description, amount } = webhookData.data;

    // 2. Kiểm tra số tiền chuyển có đủ từ 49.000đ hay không
    if (amount < 49000) {
      return res.status(200).json({ message: "Số tiền chuyển chưa đủ 49.000đ" });
    }

    // 3. Trích xuất mã đơn hàng dạng TV... từ nội dung chuyển tiền
    const cleanDesc = description.replace(/\s+/g, "").toUpperCase();
    const match = cleanDesc.match(/TV[A-Z0-9]+/i);
    if (!match) {
      return res.status(200).json({ message: "Không tìm thấy mã đơn TV... trong nội dung" });
    }

    const orderNote = match[0];

    // 4. Kiểm tra đơn hàng trong Firestore collection 'payment_orders'
    const orderRef = db.collection("payment_orders").doc(orderNote);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(200).json({ message: "Không tìm thấy đơn hàng trên hệ thống" });
    }

    if (orderDoc.data().status === "PAID") {
      return res.status(200).json({ message: "Đơn hàng này đã được kích hoạt trước đó" });
    }

    // 5. Sinh mã VIP duy nhất và cập nhật Firestore qua transaction
    const newVipCode = generateUniqueVipCode();
    const batch = db.batch();

    // Lưu mã mới vào vip_codes (đặt isUsed: false để dùng 1 lần)
    const codeRef = db.collection("vip_codes").doc(newVipCode);
    batch.set(codeRef, {
      code: newVipCode,
      isUsed: false,
      usedBy: "",
      orderNote: orderNote,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Cập nhật đơn hàng thành PAID kèm mã code để app tự động bắt realtime
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