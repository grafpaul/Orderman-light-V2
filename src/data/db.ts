import Database from "@tauri-apps/plugin-sql";

// SQLite database (stored in the app data directory)
const DB_URL = "sqlite:orderman_light_v2.db";

export type Category = { id: string; name: string; sort_index: number; default_group_id: string | null };
export type Product = { id: string; name: string; price_cents: number; category_id: string; active: number; sort_index: number; group_id: string | null };

export type PickupGroup = { id: string; name: string; sort_index: number };

export type Register = {
  id: string;
  name: string;      // e.g. "K1 Allgemein"
  prefix: string;    // e.g. "K1"
  counter_date: string; // YYYY-MM-DD
  counter: number;
};

export type Receipt = {
  id: string;
  register_id: string;
  receipt_no: number;
  receipt_code: string;
  created_at: string; // ISO
  payment_type: "CASH" | "CARD";
  total_cents: number;
  print_required: number; // 0/1
};

export type ReceiptItem = {
  id: string;
  receipt_id: string;
  product_id: string;
  category_id: string;
  group_id: string;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
};

export type PrintJob = {
  id: string;
  receipt_id: string;
  receipt_code: string;
  group_id: string;
  group_name: string;
  total_cents: number;
  status: "PENDING" | "PRINTED" | "FAILED";
  last_error: string | null;
  payload_text: string;
  created_at: string;
  printed_at: string | null;
};

let _db: Database | null = null;

function isTauriEnv(): boolean {
  const w: any = window as any;
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}


let _dbInitPromise: Promise<void> | null = null;

export async function getDb(): Promise<Database> {
  if (_db) return _db;

  if (!isTauriEnv()) {
    throw new Error(
      "Tauri API nicht verfügbar (window.__TAURI__ fehlt). Bitte die App im Tauri-Fenster starten (npm run tauri dev) – nicht im Browser."
    );
  }

  _db = await Database.load(DB_URL);

  // Init nur 1x (auch wenn mehrere Calls gleichzeitig kommen)
  if (!_dbInitPromise) {
    _dbInitPromise = (async () => {
      await ensureSchema(_db!);
      await ensureSeed(_db!);
    })();
  }

  await _dbInitPromise;
  return _db;
}


async function safeExec(db: Database, sql: string, args: any[] = []) {
  try { await db.execute(sql, args); } catch { /* ignore (migration step) */ }
}

async function ensureSchema(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS registers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      counter_date TEXT NOT NULL,
      counter INTEGER NOT NULL
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS pickup_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_index INTEGER NOT NULL
    );
  `);

  // v0.3 migrations
  await safeExec(db, "ALTER TABLE categories ADD COLUMN default_group_id TEXT");
  await safeExec(db, "ALTER TABLE products ADD COLUMN group_id TEXT");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      default_group_id TEXT
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_index INTEGER NOT NULL,
      group_id TEXT,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      register_id TEXT NOT NULL,
      receipt_no INTEGER NOT NULL,
      receipt_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payment_type TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      print_required INTEGER NOT NULL,
      FOREIGN KEY(register_id) REFERENCES registers(id)
    );
  `);

  await safeExec(db, "ALTER TABLE receipt_items ADD COLUMN product_id TEXT");
  await safeExec(db, "ALTER TABLE receipt_items ADD COLUMN group_id TEXT");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      FOREIGN KEY(receipt_id) REFERENCES receipts(id)
    );
  `);

  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN payload_text TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN receipt_code TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN group_id TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN group_name TEXT");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      receipt_code TEXT NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      payload_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      printed_at TEXT,
      FOREIGN KEY(receipt_id) REFERENCES receipts(id)
    );
  `);
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// -------------------- Seed --------------------
async function ensureSeed(db: Database) {
  await setSettingIfMissing(db, "register_id", crypto.randomUUID());
  await setSettingIfMissing(db, "lock_pin", "1234");
  await setSettingIfMissing(db, "bon_policy", "NEVER"); // NEVER | ALWAYS | OPTIONAL
  await setSettingIfMissing(db, "event_name", "Stadtmeisterschaft Laakirchen");
  await setSettingIfMissing(db, "printer_name", "POS-80C");

  // pickup groups
  const gCount = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM pickup_groups");
  if ((gCount?.[0]?.c ?? 0) === 0) {
    const groups: PickupGroup[] = [
      { id: "grp_ausschank", name: "Ausschank", sort_index: 10 },
      { id: "grp_buffet", name: "Buffet", sort_index: 20 },
    ];
    for (const g of groups) {
      await db.execute("INSERT INTO pickup_groups (id, name, sort_index) VALUES ($1,$2,$3)", [g.id, g.name, g.sort_index]);
    }
  }

  // Register defaults (K1 Allgemein / K1)
  const regId = await getSetting(db, "register_id");
  const reg = await db.select<Register[]>("SELECT id, name, prefix, counter_date, counter FROM registers WHERE id=$1", [regId]);
  if ((reg?.length ?? 0) === 0) {
    await db.execute(
      "INSERT INTO registers (id, name, prefix, counter_date, counter) VALUES ($1,$2,$3,$4,$5)",
      [regId, "K1 Allgemein", "K1", todayYmd(), 0]
    );
  }

  // categories
  const rows = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM categories");
  const c = rows?.[0]?.c ?? 0;
  if (c === 0) {
    const cats: Category[] = [
      { id: "cat_drinks", name: "Getränke", sort_index: 10, default_group_id: "grp_buffet" },
      { id: "cat_food", name: "Essen", sort_index: 20, default_group_id: "grp_buffet" },
      { id: "cat_kke", name: "Kaffee–Kuchen–Eis", sort_index: 30, default_group_id: "grp_buffet" },
    ];
    for (const cat of cats) {
      await db.execute("INSERT INTO categories (id, name, sort_index, default_group_id) VALUES ($1, $2, $3, $4)", [cat.id, cat.name, cat.sort_index, cat.default_group_id]);
    }
  } else {
    // ensure defaults exist
    await safeExec(db, "UPDATE categories SET default_group_id='grp_buffet' WHERE default_group_id IS NULL");
  }

  // products demo
  const prodRows = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM products");
  const pc = prodRows?.[0]?.c ?? 0;
 
}

// -------------------- Settings helpers --------------------
async function setSettingIfMissing(db: Database, key: string, value: string) {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE key=$1", [key]);
  if ((rows?.length ?? 0) === 0) {
    await db.execute("INSERT INTO app_settings (key, value) VALUES ($1,$2)", [key, value]);
  }
}

async function getSetting(db: Database, key: string): Promise<string> {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE key=$1", [key]);
  return rows?.[0]?.value ?? "";
}

export async function readSetting(key: string): Promise<string> {
  const db = await getDb();
  return await getSetting(db, key);
}

export async function writeSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO app_settings (key, value) VALUES ($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, value]
  );
}

// -------------------- Pickup groups --------------------
// -------------------- Pickup groups --------------------
export async function listPickupGroups(): Promise<PickupGroup[]> {
  const db = await getDb();
  return await db.select<PickupGroup[]>(
    "SELECT id, name, sort_index FROM pickup_groups ORDER BY sort_index ASC, name ASC"
  );
}

export async function createPickupGroup(name: string): Promise<void> {
  const db = await getDb();

  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Name fehlt");

  const rows = await db.select<{ m: number }[]>(
    "SELECT COALESCE(MAX(sort_index), 0) as m FROM pickup_groups"
  );
  const nextSort = (rows?.[0]?.m ?? 0) + 10;

  const id = "grp_" + crypto.randomUUID().replaceAll("-", "");

  await db.execute(
    "INSERT INTO pickup_groups (id, name, sort_index) VALUES ($1,$2,$3)",
    [id, trimmed, nextSort]
  );
}

export async function updatePickupGroupName(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE pickup_groups SET name=$2 WHERE id=$1", [id, name]);
}


// -------------------- Categories/Products --------------------
export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  return await db.select<Category[]>("SELECT id, name, sort_index, default_group_id FROM categories ORDER BY sort_index ASC, name ASC");
}

export async function listProductsByCategory(categoryId: string): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>(
    "SELECT id, name, price_cents, category_id, active, sort_index, group_id FROM products WHERE category_id=$1 AND active=1 ORDER BY sort_index ASC, name ASC",
    [categoryId]
  );
}

export async function listAllActiveProducts(): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>(
    "SELECT id, name, price_cents, category_id, active, sort_index, group_id FROM products WHERE active=1 ORDER BY category_id ASC, sort_index ASC, name ASC"
  );
}


export async function upsertProduct(p: { id?: string; name: string; price_cents: number; category_id: string; active?: number; sort_index?: number; group_id?: string | null }): Promise<void> {
  const db = await getDb();
  const id = p.id ?? crypto.randomUUID();
  const active = p.active ?? 1;
  const sort = p.sort_index ?? 1000;
  await db.execute(
    `INSERT INTO products (id, name, price_cents, category_id, active, sort_index, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       price_cents=excluded.price_cents,
       category_id=excluded.category_id,
       active=excluded.active,
       sort_index=excluded.sort_index,
       group_id=excluded.group_id`,
    [id, p.name, p.price_cents, p.category_id, active, sort, p.group_id ?? null]
  );
}

export async function updateProductGroup(id: string, groupId: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE products SET group_id=$2 WHERE id=$1", [id, groupId]);
}

export async function softDeleteProduct(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE products SET active=0 WHERE id=$1", [id]);
}

// -------------------- Register + Receipts --------------------
export async function getRegister(): Promise<Register> {
  const db = await getDb();
  const regId = await getSetting(db, "register_id");
  const rows = await db.select<Register[]>("SELECT id, name, prefix, counter_date, counter FROM registers WHERE id=$1", [regId]);
  if (!rows?.[0]) throw new Error("Register missing");
  return rows[0];
}

export async function updateRegisterNamePrefix(name: string, prefix: string): Promise<void> {
  const db = await getDb();
  const regId = await getSetting(db, "register_id");
  await db.execute("UPDATE registers SET name=$1, prefix=$2 WHERE id=$3", [name, prefix, regId]);
}

function formatReceiptCode(prefix: string, no: number): string {
  return `${prefix}-${String(no).padStart(6, "0")}`;
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildEscposText(args: {
  eventName: string;
  groupName: string;
  receiptCode: string;
  when: string;
  lines: Array<{ qty: number; name: string; lineTotalCents: number }>;
  sumCents: number;
  paymentType: "CASH" | "CARD";
}) {
  const w = 32; // approx chars on 80mm at standard font
  const center = (s: string) => {
    if (s.length >= w) return s;
    const left = Math.floor((w - s.length) / 2);
    return " ".repeat(left) + s;
  };
  const money = (c: number) => (c/100).toFixed(2).replace(".", ",") + " €";

  const out: string[] = [];
  out.push(center(args.eventName.toUpperCase()));
  out.push(center(("ABHOLSTATION: " + args.groupName).toUpperCase()));
  out.push("");
  out.push(`Datum/Zeit: ${args.when}`);
  out.push(`Bon-Nr.:   ${args.receiptCode}`);
  out.push("--------------------------------");
  for (const l of args.lines) {
    const left = `${l.qty} x ${l.name}`;
    const right = money(l.lineTotalCents);
    const dots = Math.max(1, w - left.length - right.length);
    out.push(left + " ".repeat(dots) + right);
  }
  out.push("--------------------------------");
  out.push(`SUMME:${" ".repeat(Math.max(1, w-6-money(args.sumCents).length))}${money(args.sumCents)}`);
  out.push(`BEZAHLT - ${args.paymentType === "CASH" ? "BAR" : "KARTE"}`);
  out.push("");
  return out.join("\n");
}

export async function createReceipt(args: {
  payment_type: "CASH" | "CARD";
  items: Array<{ product_id: string; category_id: string; product_name: string; qty: number; unit_price_cents: number }>;
  print_required: boolean;
}): Promise<{ receipt: Receipt; items: ReceiptItem[]; printJobs: PrintJob[] }> {
  const db = await getDb();
  const reg = await getRegister();

  const today = todayYmd();
  if (reg.counter_date !== today) {
    await db.execute("UPDATE registers SET counter_date=$1, counter=$2 WHERE id=$3", [today, 0, reg.id]);
    reg.counter = 0;
    reg.counter_date = today;
  }
  const receiptNo = reg.counter + 1;

  const receiptId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const receiptCode = formatReceiptCode(reg.prefix, receiptNo);

  const total = args.items.reduce((a, it) => a + it.qty * it.unit_price_cents, 0);

  await db.execute("UPDATE registers SET counter=$1 WHERE id=$2", [receiptNo, reg.id]);
  await db.execute(
    "INSERT INTO receipts (id, register_id, receipt_no, receipt_code, created_at, payment_type, total_cents, print_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [receiptId, reg.id, receiptNo, receiptCode, createdAt, args.payment_type, total, args.print_required ? 1 : 0]
  );

  // Resolve group_id for each item (product.group_id fallback to category.default_group_id fallback buffet)
  const catDefault = new Map<string, string>();
  const cats = await listCategories();
  for (const c of cats) catDefault.set(c.id, c.default_group_id ?? "grp_buffet");

  const prodGroup = new Map<string, string>();
  const prodRows = await db.select<{ id: string; group_id: string | null; category_id: string }[]>("SELECT id, group_id, category_id FROM products");
  for (const p of prodRows) prodGroup.set(p.id, p.group_id ?? catDefault.get(p.category_id) ?? "grp_buffet");

  const receiptItems: ReceiptItem[] = [];
  for (const it of args.items) {
    const id = crypto.randomUUID();
    const lineTotal = it.qty * it.unit_price_cents;
    const groupId = prodGroup.get(it.product_id) ?? catDefault.get(it.category_id) ?? "grp_buffet";
    receiptItems.push({
      id,
      receipt_id: receiptId,
      product_id: it.product_id,
      category_id: it.category_id,
      group_id: groupId,
      product_name: it.product_name,
      qty: it.qty,
      unit_price_cents: it.unit_price_cents,
      line_total_cents: lineTotal,
    });
    await db.execute(
      "INSERT INTO receipt_items (id, receipt_id, product_id, category_id, group_id, product_name, qty, unit_price_cents, line_total_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, receiptId, it.product_id, it.category_id, groupId, it.product_name, it.qty, it.unit_price_cents, lineTotal]
    );
  }

  const receipt: Receipt = {
    id: receiptId,
    register_id: reg.id,
    receipt_no: receiptNo,
    receipt_code: receiptCode,
    created_at: createdAt,
    payment_type: args.payment_type,
    total_cents: total,
    print_required: args.print_required ? 1 : 0,
  };

  const printJobs: PrintJob[] = [];
  if (args.print_required) {
    const eventName = await readSetting("event_name");
    const when = nowLocal();
    const groups = await listPickupGroups();
    const groupName = new Map(groups.map(g => [g.id, g.name]));

    const byGroup = new Map<string, ReceiptItem[]>();
    for (const ri of receiptItems) {
      if (!byGroup.has(ri.group_id)) byGroup.set(ri.group_id, []);
      byGroup.get(ri.group_id)!.push(ri);
    }

    for (const [gid, items] of byGroup.entries()) {
      const gname = groupName.get(gid) ?? gid;
      const sum = items.reduce((a, x) => a + x.line_total_cents, 0);
      const payload = buildEscposText({
        eventName,
        groupName: gname,
        receiptCode,
        when,
        lines: items.map(x => ({ qty: x.qty, name: x.product_name, lineTotalCents: x.line_total_cents })),
        sumCents: sum,
        paymentType: args.payment_type,
      });
      const pj: PrintJob = {
        id: crypto.randomUUID(),
        receipt_id: receiptId,
        receipt_code: receiptCode,
        group_id: gid,
        group_name: gname,
        total_cents: sum,
        status: "PENDING",
        last_error: null,
        payload_text: payload,
        created_at: createdAt,
        printed_at: null,
      };
      printJobs.push(pj);
      await db.execute(
        "INSERT INTO print_jobs (id, receipt_id, receipt_code, group_id, group_name, total_cents, status, last_error, payload_text, created_at, printed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [pj.id, pj.receipt_id, pj.receipt_code, pj.group_id, pj.group_name, pj.total_cents, pj.status, pj.last_error, pj.payload_text, pj.created_at, pj.printed_at]
      );
    }
  }

  return { receipt, items: receiptItems, printJobs };
}

// -------------------- Print Jobs --------------------
export async function listOpenPrintJobs(): Promise<PrintJob[]> {
  const db = await getDb();
  return await db.select<PrintJob[]>(
    "SELECT id, receipt_id, receipt_code, group_id, group_name, total_cents, status, last_error, payload_text, created_at, printed_at FROM print_jobs WHERE status!='PRINTED' ORDER BY created_at DESC"
  );
}

export async function markPrintJobPrinted(id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute("UPDATE print_jobs SET status='PRINTED', printed_at=$2, last_error=NULL WHERE id=$1", [id, now]);
}

export async function markPrintJobFailed(id: string, err: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE print_jobs SET status='FAILED', last_error=$2 WHERE id=$1", [id, err]);
}
// -------------------- Event Summary (Festabschluss) --------------------
export type PaymentStat = { payment_type: "CASH" | "CARD"; receipts: number; total_cents: number };
export type ProductStat = { product_id: string; product_name: string; qty: number; total_cents: number };
export type GroupStat = { group_id: string; group_name: string; qty: number; total_cents: number };

export type EventSummary = {
  event_name: string;
  receipts_count: number;
  total_cents: number;
  by_payment: PaymentStat[];
  by_product: ProductStat[];
  by_group: GroupStat[];
};

export async function getEventSummary(): Promise<EventSummary> {
  const db = await getDb();

  const event_name = await readSetting("event_name");

  const r0 = await db.select<{ c: number; s: number }[]>(
    "SELECT COUNT(*) as c, COALESCE(SUM(total_cents),0) as s FROM receipts"
  );
  const receipts_count = r0?.[0]?.c ?? 0;
  const total_cents = r0?.[0]?.s ?? 0;

  const by_payment = await db.select<PaymentStat[]>(
    `SELECT payment_type as payment_type,
            COUNT(*) as receipts,
            COALESCE(SUM(total_cents),0) as total_cents
     FROM receipts
     GROUP BY payment_type
     ORDER BY payment_type`
  );

  // pro Produkt: Menge + Umsatz (aus receipt_items)
  const by_product = await db.select<ProductStat[]>(
    `SELECT
        product_id as product_id,
        product_name as product_name,
        COALESCE(SUM(qty),0) as qty,
        COALESCE(SUM(line_total_cents),0) as total_cents
     FROM receipt_items
     GROUP BY product_id, product_name
     ORDER BY total_cents DESC, qty DESC, product_name ASC`
  );

  // pro Abholstation: Menge + Umsatz (aus receipt_items)
  const by_group = await db.select<GroupStat[]>(
    `SELECT
        ri.group_id as group_id,
        COALESCE(pg.name, ri.group_id) as group_name,
        COALESCE(SUM(ri.qty),0) as qty,
        COALESCE(SUM(ri.line_total_cents),0) as total_cents
     FROM receipt_items ri
     LEFT JOIN pickup_groups pg ON pg.id = ri.group_id
     GROUP BY ri.group_id, pg.name
     ORDER BY total_cents DESC, qty DESC, group_name ASC`
  );

  return {
    event_name,
    receipts_count,
    total_cents,
    by_payment: by_payment ?? [],
    by_product: by_product ?? [],
    by_group: by_group ?? [],
  };
}

