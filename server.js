const express = require("express");
const mysql = require("mysql2/promise");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");

const app = express();
app.use(bodyParser.json());

/* ===========================
        DB CONNECTION
=========================== */
let pool;
(async () => {
  pool = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "",
    database: "mlm",
    waitForConnections: true,
    connectionLimit: 10
  });
})();

/* ===========================
      HELPER FUNCTIONS
=========================== */

// Get member by member_code
async function getMember(conn, code) {
  const [rows] = await conn.query("SELECT * FROM members WHERE member_code=?", [code]);
  return rows.length ? rows[0] : null;
}

// Get member by email
async function getMemberByEmail(conn, email) {
  const [rows] = await conn.query("SELECT * FROM members WHERE email=?", [email]);
  return rows.length ? rows[0] : null;
}

// Spill Logic → Find next free spot in the selected direction
async function findAvailable(conn, sponsorCode, position) {
  let current = await getMember(conn, sponsorCode);

  while (true) {
    if (position === "Left") {
      if (!current.left_child) {
        return { parent: current, side: "Left" };
      }
      current = await getMember(conn, current.left_child);
    } else {
      if (!current.right_child) {
        return { parent: current, side: "Right" };
      }
      current = await getMember(conn, current.right_child);
    }
  }
}

// Update left_count/right_count recursively upward
async function updateAncestors(conn, newCode, parentCode) {
  let childCode = newCode;
  let currentParent = parentCode;

  while (currentParent) {
    const parent = await getMember(conn, currentParent);
    if (!parent) break;

    if (parent.left_child === childCode) {
      await conn.query("UPDATE members SET left_count = left_count + 1 WHERE member_code=?", [parent.member_code]);
    }
    if (parent.right_child === childCode) {
      await conn.query("UPDATE members SET right_count = right_count + 1 WHERE member_code=?", [parent.member_code]);
    }

    childCode = parent.member_code;
    currentParent = parent.sponsor_code;
  }
}

/* ===========================
        API: MEMBER JOIN
=========================== */
app.post("/join", async (req, res) => {
  const { name, email, mobile, sponsor_code, position, password } = req.body;

  if (!name || !email || !sponsor_code || !position || !password) {
    return res.json({ status: "error", msg: "Missing required fields." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock sponsor
    const [sRows] = await conn.query(
      "SELECT * FROM members WHERE member_code=? FOR UPDATE",
      [sponsor_code]
    );

    if (!sRows.length) {
      await conn.rollback();
      return res.json({ status: "error", msg: "Invalid Sponsor Code" });
    }

    const sponsor = sRows[0];

    // Spill Logic
    const slot = await findAvailable(conn, sponsor.member_code, position);
    const parent = slot.parent;
    const side = slot.side;

    // Check duplicate email
    const existing = await getMemberByEmail(conn, email);
    if (existing) {
      await conn.rollback();
      return res.json({ status: "error", msg: "Email already exists." });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Insert new member with AUTO_INCREMENT
    const [insert] = await conn.query(
      `INSERT INTO members 
       (name, email, mobile, password, sponsor_code, left_child, right_child, left_count, right_count)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0)`,
      [name, email, mobile || null, hashed, parent.member_code]
    );

    const newMemberCode = insert.insertId;

    // Update parent’s child pointer
    if (side === "Left") {
      await conn.query("UPDATE members SET left_child=? WHERE member_code=?", [
        newMemberCode,
        parent.member_code,
      ]);
    } else {
      await conn.query("UPDATE members SET right_child=? WHERE member_code=?", [
        newMemberCode,
        parent.member_code,
      ]);
    }

    // Update counts upward
    await updateAncestors(conn, newMemberCode, parent.member_code);

    await conn.commit();
    res.json({
      status: "success",
      msg: "Member Added Successfully",
      member_code: newMemberCode,
    });
  } catch (err) {
    console.error("Join Error:", err);
    await conn.rollback();
    res.json({ status: "error", msg: "Server Error" });
  } finally {
    conn.release();
  }
});

/* ===========================
        API: LOGIN
=========================== */
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const conn = await pool.getConnection();
  try {
    const user = await getMemberByEmail(conn, email);
    if (!user) return res.json({ status: "error", msg: "Invalid Login" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.json({ status: "error", msg: "Invalid Login" });

    delete user.password;
    res.json({ status: "success", member: user });
  } finally {
    conn.release();
  }
});

/* ===========================
        API: PROFILE
=========================== */
app.get("/profile/:code", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const member = await getMember(conn, req.params.code);
    if (!member) return res.json({ status: "error", msg: "User Not Found" });

    delete member.password;
    res.json(member);
  } finally {
    conn.release();
  }
});

/* ===========================
    API: LEFT DOWNLINE (BFS)
=========================== */
app.get("/downline/left/:code", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const member = await getMember(conn, req.params.code);
    if (!member || !member.left_child) return res.json([]);

    const queue = [member.left_child];
    const result = [];

    while (queue.length) {
      const code = queue.shift();
      const node = await getMember(conn, code);
      if (!node) continue;

      delete node.password;
      result.push(node);

      if (node.left_child) queue.push(node.left_child);
      if (node.right_child) queue.push(node.right_child);
    }

    res.json(result);
  } finally {
    conn.release();
  }
});

/* ===========================
    API: RIGHT DOWNLINE
=========================== */
app.get("/downline/right/:code", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const member = await getMember(conn, req.params.code);
    if (!member || !member.right_child) return res.json([]);

    const queue = [member.right_child];
    const result = [];

    while (queue.length) {
      const code = queue.shift();
      const node = await getMember(conn, code);
      if (!node) continue;

      delete node.password;
      result.push(node);

      if (node.left_child) queue.push(node.left_child);
      if (node.right_child) queue.push(node.right_child);
    }

    res.json(result);
  } finally {
    conn.release();
  }
});

/* ===========================
       START SERVER
=========================== */
app.listen(5000, () => {
  console.log("Server running on port 5000");
});
