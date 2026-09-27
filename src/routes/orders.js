const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { notify } = require("../notifications");
const { canManageStudent } = require("../access");

// Продукты, заказы и оплаты (как в GetCourse): у заказа — график платежей (один
// платёж или рассрочка), каждый платёж отмечают оплаченным вручную. Когда заказ
// оплачен полностью, врачу автоматически открывается курс продукта (если задан).
// Поле users.payment_status (фильтры дашборда) пересчитывается из заказов.
const router = express.Router();
const STAFF = ["curator", "admin", "super_admin"];
const ADMIN = ["admin", "super_admin"];

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : NaN; }
function addMonths(iso, k) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}
// Сумма делится на равные части; копейки нет — остаток от деления в первый платёж.
function splitAmount(total, n) {
  const base = Math.floor(total / n);
  const parts = Array(n).fill(base);
  parts[0] += total - base * n;
  return parts;
}

/* ---------- Продукты ---------- */

router.get("/products", authRequired, requireRole(...STAFF), async (req, res) => {
  const r = await pool.query(
    `SELECT p.*, c.title AS course_title,
       (SELECT COUNT(*)::int FROM orders o WHERE o.product_id=p.id AND o.status!='cancelled') AS orders_count
     FROM products p LEFT JOIN courses c ON c.id=p.course_id ORDER BY p.active DESC, p.created_at`
  );
  res.json({ products: r.rows });
});

function readProduct(body) {
  const title = String((body && body.title) || "").trim();
  const price = toInt(body && body.price);
  const maxInstallments = body && body.maxInstallments !== undefined ? toInt(body.maxInstallments) : 1;
  const courseId = (body && body.courseId) || null;
  if (!title || title.length > 200) return { error: "Укажите название" };
  if (!(price >= 0) || price > 100000000) return { error: "Укажите цену" };
  if (!(maxInstallments >= 1 && maxInstallments <= 24)) return { error: "Рассрочка — от 1 до 24 платежей" };
  return { title, price, maxInstallments, courseId, active: body.active === undefined ? true : !!body.active };
}

router.post("/products", authRequired, requireRole(...ADMIN), async (req, res) => {
  const p = readProduct(req.body || {});
  if (p.error) return res.status(400).json({ error: "invalid_input", message: p.error });
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO products (id, title, price, course_id, max_installments, active) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, p.title, p.price, p.courseId, p.maxInstallments, p.active]
  );
  await logAction(req.user, "product.create", "product", id, p.title, { price: p.price }, false);
  res.json({ ok: true, id });
});

router.put("/products/:id", authRequired, requireRole(...ADMIN), async (req, res) => {
  const p = readProduct(req.body || {});
  if (p.error) return res.status(400).json({ error: "invalid_input", message: p.error });
  const r = await pool.query(
    "UPDATE products SET title=$1, price=$2, course_id=$3, max_installments=$4, active=$5 WHERE id=$6",
    [p.title, p.price, p.courseId, p.maxInstallments, p.active, req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "product.update", "product", req.params.id, p.title, { price: p.price, active: p.active }, false);
  res.json({ ok: true });
});

router.delete("/products/:id", authRequired, requireRole(...ADMIN), async (req, res) => {
  // Продукт с заказами не удаляем — история оплат должна остаться; его можно скрыть.
  const used = await pool.query("SELECT 1 FROM orders WHERE product_id=$1 LIMIT 1", [req.params.id]);
  if (used.rowCount) return res.status(409).json({ error: "in_use", message: "По продукту уже есть заказы — его можно только скрыть" });
  const r = await pool.query("DELETE FROM products WHERE id=$1 RETURNING title", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "product.delete", "product", req.params.id, r.rows[0].title, {}, false);
  res.json({ ok: true });
});

/* ---------- Заказы ---------- */

const ORDER_SELECT = `
  SELECT o.id, o.number, o.user_id, o.product_id, o.title, o.amount, o.status, o.comment, o.created_at,
    u.name AS student_name, u.email AS student_email,
    CASE WHEN u.avatar_file IS NULL THEN NULL ELSE 'api/auth/avatar/' || u.avatar_file END AS avatar_url,
    cb.name AS created_by_name, p.course_id, c.title AS course_title,
    COALESCE((SELECT SUM(amount) FROM order_payments op WHERE op.order_id=o.id AND op.paid_at IS NOT NULL), 0)::int AS paid_amount,
    (SELECT COUNT(*)::int FROM order_payments op WHERE op.order_id=o.id) AS installments,
    (SELECT COUNT(*)::int FROM order_payments op WHERE op.order_id=o.id AND op.paid_at IS NOT NULL) AS installments_paid,
    (SELECT MIN(due_date)::text FROM order_payments op WHERE op.order_id=o.id AND op.paid_at IS NULL) AS next_due,
    COALESCE((SELECT SUM(amount) FROM order_payments op WHERE op.order_id=o.id AND op.paid_at IS NULL AND op.due_date < CURRENT_DATE), 0)::int AS overdue_amount
  FROM orders o
  JOIN users u ON u.id = o.user_id
  LEFT JOIN users cb ON cb.id = o.created_by
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN courses c ON c.id = p.course_id`;

async function loadOrder(id) {
  const o = await pool.query(ORDER_SELECT + " WHERE o.id=$1", [id]);
  if (!o.rowCount) return null;
  const pays = await pool.query(
    `SELECT op.id, op.idx, op.amount, op.due_date::text AS due_date, op.paid_at, m.name AS marked_by_name
     FROM order_payments op LEFT JOIN users m ON m.id=op.marked_by WHERE op.order_id=$1 ORDER BY op.idx`, [id]
  );
  return Object.assign({}, o.rows[0], { payments: pays.rows });
}

// users.payment_status — сводка по всем действующим заказам врача. Без заказов
// оставляем то, что куратор выставил руками (так было до появления заказов).
async function syncUserPaymentStatus(userId) {
  const r = await pool.query(
    `SELECT o.status FROM orders o WHERE o.user_id=$1 AND o.status!='cancelled'`, [userId]
  );
  if (!r.rowCount) {
    // Все заказы отменены — оплаты нет (иначе врач остался бы «Оплачено»
    // по отменённому заказу). Врача без заказов вообще не трогаем.
    const any = await pool.query("SELECT 1 FROM orders WHERE user_id=$1 LIMIT 1", [userId]);
    if (any.rowCount) await pool.query("UPDATE users SET payment_status='unpaid' WHERE id=$1 AND role='student'", [userId]);
    return;
  }
  const st = r.rows.map((x) => x.status);
  const value = st.every((s) => s === "paid") ? "paid" : (st.some((s) => s === "paid" || s === "partial") ? "partial" : "unpaid");
  await pool.query("UPDATE users SET payment_status=$1 WHERE id=$2 AND role='student'", [value, userId]);
}

async function recomputeOrder(orderId, actor) {
  const o = await pool.query(
    `SELECT o.id, o.user_id, o.status, o.title, p.course_id FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id=$1`, [orderId]
  );
  if (!o.rowCount) return null;
  const ord = o.rows[0];
  if (ord.status === "cancelled") { await syncUserPaymentStatus(ord.user_id); return "cancelled"; }
  const s = await pool.query(
    "SELECT COUNT(*)::int AS total, COUNT(paid_at)::int AS paid FROM order_payments WHERE order_id=$1", [orderId]
  );
  const { total, paid } = s.rows[0];
  const status = total > 0 && paid === total ? "paid" : (paid > 0 ? "partial" : "new");
  await pool.query("UPDATE orders SET status=$1 WHERE id=$2", [status, orderId]);
  await syncUserPaymentStatus(ord.user_id);

  // Полная оплата открывает курс продукта (если врач ещё не записан на него).
  if (status === "paid" && ord.status !== "paid" && ord.course_id) {
    const ins = await pool.query(
      "INSERT INTO progress (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING RETURNING user_id",
      [ord.user_id, ord.course_id]
    );
    if (ins.rowCount) {
      const c = await pool.query("SELECT title FROM courses WHERE id=$1", [ord.course_id]);
      await notify(ord.user_id, "course_opened", "Курс открыт", `Оплата получена — вам открыт курс «${c.rows[0].title}».`);
      await logAction(actor, "course.enroll", "student", ord.user_id, null, { courseId: ord.course_id, byOrder: orderId }, false);
    }
  }
  return status;
}

router.get("/", authRequired, requireRole(...STAFF), async (req, res) => {
  const params = [];
  let where = "u.role='student'";
  if (req.user.role === "curator") {
    params.push(req.user.id);
    where += ` AND (u.assigned_curator_id=$${params.length} OR u.assigned_curator_id IS NULL)`;
  }
  if (req.query.studentId) { params.push(req.query.studentId); where += ` AND o.user_id=$${params.length}`; }
  const rows = await pool.query(ORDER_SELECT + ` WHERE ${where} ORDER BY o.created_at DESC LIMIT 500`, params);

  // Сводка — по тем же заказам, что видит сотрудник (скоуп куратора учтён).
  const orders = rows.rows;
  const active = orders.filter((o) => o.status !== "cancelled");
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const ids = active.map((o) => o.id);
  let paidThisMonth = 0;
  if (ids.length) {
    const m = await pool.query(
      "SELECT COALESCE(SUM(amount),0)::int AS s FROM order_payments WHERE order_id = ANY($1::text[]) AND paid_at >= $2",
      [ids, monthStart.toISOString()]
    );
    paidThisMonth = m.rows[0].s;
  }
  const summary = {
    received: active.reduce((s, o) => s + o.paid_amount, 0),
    receivedThisMonth: paidThisMonth,
    expected: active.reduce((s, o) => s + (o.amount - o.paid_amount), 0),
    overdue: active.reduce((s, o) => s + o.overdue_amount, 0),
    overdueOrders: active.filter((o) => o.overdue_amount > 0).length,
    ordersCount: active.length
  };
  res.json({ orders, summary });
});

router.get("/mine", authRequired, requireRole("student"), async (req, res) => {
  const r = await pool.query(ORDER_SELECT + " WHERE o.user_id=$1 AND o.status!='cancelled' ORDER BY o.created_at DESC", [req.user.id]);
  const out = [];
  for (const o of r.rows) out.push(await loadOrder(o.id));
  res.json({ orders: out.map((o) => ({
    id: o.id, number: o.number, title: o.title, amount: o.amount, status: o.status, paid_amount: o.paid_amount,
    created_at: o.created_at, next_due: o.next_due, overdue_amount: o.overdue_amount, course_title: o.course_title,
    payments: o.payments.map((p) => ({ idx: p.idx, amount: p.amount, due_date: p.due_date, paid_at: p.paid_at }))
  })) });
});

router.get("/:id", authRequired, requireRole(...STAFF), async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "not_found" });
  if (!(await canManageStudent(req.user, o.user_id))) return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  res.json({ order: o });
});

router.post("/", authRequired, requireRole(...STAFF), async (req, res) => {
  const b = req.body || {};
  const userId = b.userId;
  if (!userId) return res.status(400).json({ error: "invalid_input", message: "Выберите врача" });
  const student = await pool.query("SELECT id, name FROM users WHERE id=$1 AND role='student'", [userId]);
  if (!student.rowCount) return res.status(404).json({ error: "not_found", message: "Врач не найден" });
  if (!(await canManageStudent(req.user, userId))) return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });

  let product = null;
  if (b.productId) {
    const p = await pool.query("SELECT * FROM products WHERE id=$1", [b.productId]);
    if (!p.rowCount) return res.status(404).json({ error: "not_found", message: "Продукт не найден" });
    product = p.rows[0];
    if (!product.active) return res.status(400).json({ error: "product_inactive", message: "Продукт снят с продажи — верните его в продажу или выберите другой" });
  }
  const title = String(b.title || (product && product.title) || "").trim();
  if (!title) return res.status(400).json({ error: "invalid_input", message: "Выберите продукт или укажите название" });
  const amount = b.amount !== undefined && b.amount !== "" ? toInt(b.amount) : (product ? product.price : NaN);
  if (!(amount >= 0) || amount > 100000000) return res.status(400).json({ error: "invalid_input", message: "Укажите сумму" });
  const installments = b.installments ? toInt(b.installments) : 1;
  const maxInst = product ? product.max_installments : 24;
  if (!(installments >= 1 && installments <= maxInst)) {
    return res.status(400).json({ error: "invalid_input", message: `Рассрочка для этого продукта — не больше ${maxInst} платежей` });
  }
  const firstDue = /^\d{4}-\d{2}-\d{2}$/.test(b.firstDueDate || "") ? b.firstDueDate : new Date().toISOString().slice(0, 10);

  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO orders (id, user_id, product_id, title, amount, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, userId, product ? product.id : null, title, amount, String(b.comment || "").trim() || null, req.user.id]
  );
  const parts = splitAmount(amount, installments);
  for (let i = 0; i < parts.length; i++) {
    await pool.query(
      "INSERT INTO order_payments (id, order_id, idx, amount, due_date) VALUES ($1,$2,$3,$4,$5)",
      [crypto.randomUUID(), id, i, parts[i], addMonths(firstDue, i)]
    );
  }
  // Сразу отмеченная оплата — частый случай «оплатил при оформлении».
  if (b.paidNow) {
    await pool.query("UPDATE order_payments SET paid_at=now(), marked_by=$1 WHERE order_id=$2 AND idx=0", [req.user.id, id]);
  }
  await recomputeOrder(id, req.user);
  await logAction(req.user, "order.create", "student", userId, student.rows[0].name, { orderId: id, title, amount, installments }, false);
  res.json({ ok: true, order: await loadOrder(id) });
});

router.post("/:id/payments/:paymentId/:action(pay|unpay)", authRequired, requireRole(...STAFF), async (req, res) => {
  const o = await pool.query("SELECT o.user_id, o.status, o.title, u.name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1", [req.params.id]);
  if (!o.rowCount) return res.status(404).json({ error: "not_found" });
  if (!(await canManageStudent(req.user, o.rows[0].user_id))) return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  if (o.rows[0].status === "cancelled") return res.status(409).json({ error: "cancelled", message: "Заказ отменён" });
  const pay = req.params.action === "pay";
  const r = await pool.query(
    pay
      ? "UPDATE order_payments SET paid_at=now(), marked_by=$1 WHERE id=$2 AND order_id=$3 AND paid_at IS NULL RETURNING amount"
      : "UPDATE order_payments SET paid_at=NULL, marked_by=$1 WHERE id=$2 AND order_id=$3 AND paid_at IS NOT NULL RETURNING amount",
    [req.user.id, req.params.paymentId, req.params.id]
  );
  if (!r.rowCount) return res.status(409).json({ error: "no_change", message: pay ? "Платёж уже отмечен" : "Платёж и так не оплачен" });
  const status = await recomputeOrder(req.params.id, req.user);
  await logAction(req.user, pay ? "order.payment" : "order.payment_undo", "student", o.rows[0].user_id, o.rows[0].name,
    { orderId: req.params.id, title: o.rows[0].title, amount: r.rows[0].amount }, false);
  res.json({ ok: true, status, order: await loadOrder(req.params.id) });
});

router.post("/:id/cancel", authRequired, requireRole(...STAFF), async (req, res) => {
  const o = await pool.query("SELECT o.user_id, o.title, u.name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1", [req.params.id]);
  if (!o.rowCount) return res.status(404).json({ error: "not_found" });
  if (!(await canManageStudent(req.user, o.rows[0].user_id))) return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  await pool.query("UPDATE orders SET status='cancelled' WHERE id=$1", [req.params.id]);
  await syncUserPaymentStatus(o.rows[0].user_id);
  await logAction(req.user, "order.cancel", "student", o.rows[0].user_id, o.rows[0].name, { orderId: req.params.id, title: o.rows[0].title }, false);
  res.json({ ok: true });
});

module.exports = router;
