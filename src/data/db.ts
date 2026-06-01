import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:orderman_light_v2.db";

export type Category = { id: string; name: string; sort_index: number; default_group_id: string | null };
export type Product = {
  id: string;
  name: string;
  price_cents: number;
  category_id: string;
  active: number;
  standard_active: number;
  today_active: number;
  sort_index: number;
  group_id: string | null;
};
export type PickupGroup = { id: string; name: string; sort_index: number };

export type Register = {
  id: string;
  name: string;
  prefix: string;
  counter_date: string;
  counter: number;
};

export type Receipt = {
  id: string;
  register_id: string;
  receipt_no: number;
  receipt_code: string;
  created_at: string;
  payment_type: "CASH" | "CARD";
  total_cents: number;
  print_required: number;
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

export type EventTemplate = {
  id: string;
  name: string;
  event_name: string;
  bon_policy: "NEVER" | "ALWAYS" | "OPTIONAL";
  auto_print: number;
  created_at: string;
  updated_at: string;
};

let _db: Database | null = null;
let _dbInitPromise: Promise<void> | null = null;

function isTauriEnv(): boolean {
  const w: any = window as any;
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

export async function getDb(): Promise<Database> {
  if (_db) return _db;

  if (!isTauriEnv()) {
    throw new Error("Tauri API nicht verfügbar. Bitte mit npm run tauri dev starten.");
  }

  _db = await Database.load(DB_URL);

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
  try {
    await db.execute(sql, args);
  } catch {}
}

async function ensureSchema(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS registers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      counter_date TEXT NOT NULL,
      counter INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS pickup_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_index INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      default_group_id TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      sort_index INTEGER NOT NULL DEFAULT 1000,
      group_id TEXT
    )
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
      print_required INTEGER NOT NULL
    )
  `);

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
      line_total_cents INTEGER NOT NULL
    )
  `);

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
      printed_at TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS event_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      bon_policy TEXT NOT NULL,
      auto_print INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS event_template_products (
      template_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      PRIMARY KEY (template_id, product_id)
    )
  `);

  await safeExec(db, "ALTER TABLE categories ADD COLUMN default_group_id TEXT");
  await safeExec(db, "ALTER TABLE products ADD COLUMN group_id TEXT");
  await safeExec(db, "ALTER TABLE products ADD COLUMN standard_active INTEGER NOT NULL DEFAULT 1");
await safeExec(db, "ALTER TABLE products ADD COLUMN today_active INTEGER NOT NULL DEFAULT 1");
  await safeExec(db, "ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 0");
  await safeExec(db, "ALTER TABLE products ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 1000");

  await safeExec(db, "ALTER TABLE receipt_items ADD COLUMN product_id TEXT");
  await safeExec(db, "ALTER TABLE receipt_items ADD COLUMN group_id TEXT");

  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN payload_text TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN receipt_code TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN group_id TEXT");
  await safeExec(db, "ALTER TABLE print_jobs ADD COLUMN group_name TEXT");

  await safeExec(db, "ALTER TABLE event_templates ADD COLUMN auto_print INTEGER NOT NULL DEFAULT 0");
  await safeExec(db, "ALTER TABLE event_templates ADD COLUMN updated_at TEXT");

  const now = new Date().toISOString();
  await safeExec(db, "UPDATE event_templates SET updated_at=$1 WHERE updated_at IS NULL OR updated_at=''", [now]);
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function ensureSeed(db: Database) {
  await setSettingIfMissing(db, "register_id", crypto.randomUUID());
  await setSettingIfMissing(db, "lock_pin", "1234");
  await setSettingIfMissing(db, "bon_policy", "NEVER");
  await setSettingIfMissing(db, "event_name", "Stadtmeisterschaft Laakirchen");
  await setSettingIfMissing(db, "printer_name", "POS-80C");
  await setSettingIfMissing(db, "auto_print", "false");

  const gCount = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM pickup_groups");
  if ((gCount?.[0]?.c ?? 0) === 0) {
    await db.execute("INSERT INTO pickup_groups (id,name,sort_index) VALUES ($1,$2,$3)", ["grp_ausschank", "Ausschank", 10]);
    await db.execute("INSERT INTO pickup_groups (id,name,sort_index) VALUES ($1,$2,$3)", ["grp_buffet", "Buffet", 20]);
  }

  const regId = await getSetting(db, "register_id");
  const reg = await db.select<Register[]>("SELECT * FROM registers WHERE id=$1", [regId]);

  if ((reg?.length ?? 0) === 0) {
    await db.execute(
      "INSERT INTO registers (id,name,prefix,counter_date,counter) VALUES ($1,$2,$3,$4,$5)",
      [regId, "K1 Allgemein", "K1", todayYmd(), 0]
    );
  }

  await ensureCategory(db, "cat_alkohol", "Alkohol", 10, "grp_ausschank");
  await ensureCategory(db, "cat_anti", "Anti", 20, "grp_buffet");
  await ensureCategory(db, "cat_essen", "Essen", 30, "grp_buffet");
  await ensureCategory(db, "cat_kke", "Kaffee-Kuchen-Eis", 40, "grp_buffet");

  await cleanupLegacyCategories(db);
}

async function ensureCategory(db: Database, id: string, name: string, sort: number, defaultGroup: string) {
  await db.execute(
    `INSERT INTO categories (id,name,sort_index,default_group_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       sort_index=excluded.sort_index,
       default_group_id=excluded.default_group_id`,
    [id, name, sort, defaultGroup]
  );
}

async function cleanupLegacyCategories(db: Database) {
  await safeExec(db, "UPDATE products SET category_id='cat_anti' WHERE category_id='cat_drinks'");
  await safeExec(db, "UPDATE products SET category_id='cat_essen' WHERE category_id='cat_food'");
  await safeExec(db, "UPDATE products SET category_id='cat_essen' WHERE category_id='cat_food_old'");
  await safeExec(db, "UPDATE products SET category_id='cat_kke' WHERE category_id='cat_kke_old'");

  await safeExec(db, "DELETE FROM categories WHERE id IN ('cat_drinks','cat_food','cat_food_old','cat_kke_old')");
  await safeExec(
    db,
    "DELETE FROM categories WHERE id NOT IN ('cat_alkohol','cat_anti','cat_essen','cat_kke')"
  );
}

async function setSettingIfMissing(db: Database, key: string, value: string) {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE key=$1", [key]);
  if ((rows?.length ?? 0) === 0) {
    await db.execute("INSERT INTO app_settings (key,value) VALUES ($1,$2)", [key, value]);
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
    `INSERT INTO app_settings (key,value)
     VALUES ($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, value]
  );
}

export async function listPickupGroups(): Promise<PickupGroup[]> {
  const db = await getDb();
  return await db.select<PickupGroup[]>("SELECT * FROM pickup_groups ORDER BY sort_index ASC, name ASC");
}

export async function createPickupGroup(name: string): Promise<void> {
  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name fehlt");

  const rows = await db.select<{ m: number }[]>("SELECT COALESCE(MAX(sort_index),0) as m FROM pickup_groups");
  const next = (rows?.[0]?.m ?? 0) + 10;

  await db.execute("INSERT INTO pickup_groups (id,name,sort_index) VALUES ($1,$2,$3)", [
    "grp_" + crypto.randomUUID().replaceAll("-", ""),
    trimmed,
    next,
  ]);
}

export async function updatePickupGroupName(id: string, name: string): Promise<void> {
  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name fehlt");
  await db.execute("UPDATE pickup_groups SET name=$2 WHERE id=$1", [id, trimmed]);
}

export async function listAllProducts(): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>(
    `SELECT id, name, price_cents, category_id, active, standard_active, today_active, sort_index, group_id
     FROM products
     WHERE active=1
     ORDER BY category_id ASC, sort_index ASC, name ASC`
  );
}

export async function updateProductTodayActive(id: string, todayActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE products SET today_active=$2 WHERE id=$1",
    [id, todayActive ? 1 : 0]
  );
}

export async function updateProductStandardActive(id: string, standardActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE products SET standard_active=$2 WHERE id=$1",
    [id, standardActive ? 1 : 0]
  );
}

export async function applyStandardToToday(): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE products SET today_active=standard_active WHERE active=1"
  );
}

export async function setAllTodayActive(active: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE products SET today_active=$1 WHERE active=1",
    [active ? 1 : 0]
  );
}

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  await cleanupLegacyCategories(db);

  return await db.select<Category[]>(
    `SELECT *
     FROM categories
     WHERE id IN ('cat_alkohol','cat_anti','cat_essen','cat_kke')
     ORDER BY sort_index ASC, name ASC`
  );
}
export async function listProductsByCategory(categoryId: string): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>(
    `SELECT id, name, price_cents, category_id, active, standard_active, today_active, sort_index, group_id
     FROM products
     WHERE category_id=$1 AND active=1 AND today_active=1
     ORDER BY sort_index ASC, name ASC`,
    [categoryId]
  );
}

export async function listAllActiveProducts(): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>(
    `SELECT *
     FROM products
     WHERE active=1
     ORDER BY category_id ASC, sort_index ASC, name ASC`
  );
}

export async function upsertProduct(p: {
  id?: string;
  name: string;
  price_cents: number;
  category_id: string;
  active?: number;
  sort_index?: number;
  group_id?: string | null;
}): Promise<void> {
  const db = await getDb();
  const id = p.id ?? crypto.randomUUID();
  const name = p.name.trim();
  if (!name) throw new Error("Produktname fehlt");

  await db.execute(
    `INSERT INTO products
    (id,name,price_cents,category_id,active,sort_index,group_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      price_cents=excluded.price_cents,
      category_id=excluded.category_id,
      active=excluded.active,
      sort_index=excluded.sort_index,
      group_id=excluded.group_id`,
    [id, name, p.price_cents, p.category_id, p.active ?? 0, p.sort_index ?? 1000, p.group_id ?? null]
  );
}

export async function setProductActive(id: string, active: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE products SET active=$2 WHERE id=$1", [id, active ? 1 : 0]);
}

export async function deleteProduct(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM event_template_products WHERE product_id=$1", [id]);
  await db.execute("DELETE FROM products WHERE id=$1", [id]);
}

export async function getRegister(): Promise<Register> {
  const db = await getDb();
  const regId = await getSetting(db, "register_id");
  const rows = await db.select<Register[]>("SELECT * FROM registers WHERE id=$1", [regId]);
  if (!rows?.[0]) throw new Error("Register missing");
  return rows[0];
}

export async function updateRegisterNamePrefix(name: string, prefix: string): Promise<void> {
  const db = await getDb();
  const regId = await getSetting(db, "register_id");
  await db.execute("UPDATE registers SET name=$1,prefix=$2 WHERE id=$3", [name, prefix, regId]);
}

function formatReceiptCode(prefix: string, no: number): string {
  return `${prefix}-${String(no).padStart(6, "0")}`;
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const w = 32;
  const money = (c: number) => (c / 100).toFixed(2).replace(".", ",") + " €";
  const center = (s: string) => {
    if (s.length >= w) return s;
    return " ".repeat(Math.floor((w - s.length) / 2)) + s;
  };

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
    out.push(left + " ".repeat(Math.max(1, w - left.length - right.length)) + right);
  }

  out.push("--------------------------------");
  out.push(`SUMME:${" ".repeat(Math.max(1, w - 6 - money(args.sumCents).length))}${money(args.sumCents)}`);
  out.push(`BEZAHLT - ${args.paymentType === "CASH" ? "BAR" : "KARTE"}`);
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

export async function createReceipt(args: {
  payment_type: "CASH" | "CARD";
  items: Array<{
    product_id: string;
    category_id: string;
    product_name: string;
    qty: number;
    unit_price_cents: number;
  }>;
  print_required: boolean;
}): Promise<{ receipt: Receipt; items: ReceiptItem[]; printJobs: PrintJob[] }> {
  const db = await getDb();
  const reg = await getRegister();

  const today = todayYmd();

  if (reg.counter_date !== today) {
    await db.execute("UPDATE registers SET counter_date=$1,counter=0 WHERE id=$2", [today, reg.id]);
    reg.counter = 0;
    reg.counter_date = today;
  }

  const next = reg.counter + 1;
  await db.execute("UPDATE registers SET counter=$1 WHERE id=$2", [next, reg.id]);

  const receiptId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const receiptCode = formatReceiptCode(reg.prefix, next);
  const total = args.items.reduce((a, x) => a + x.qty * x.unit_price_cents, 0);

  await db.execute(
    `INSERT INTO receipts
    (id,register_id,receipt_no,receipt_code,created_at,payment_type,total_cents,print_required)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [receiptId, reg.id, next, receiptCode, createdAt, args.payment_type, total, args.print_required ? 1 : 0]
  );

  const cats = await listCategories();
  const catDefault = new Map(cats.map((c) => [c.id, c.default_group_id ?? "grp_buffet"]));

  const allGroups = await listPickupGroups();
  const groupName = new Map(allGroups.map((g) => [g.id, g.name]));

  const prodRows = await db.select<{ id: string; group_id: string | null; category_id: string }[]>(
    "SELECT id, group_id, category_id FROM products"
  );
  const prodGroup = new Map<string, string>();
  for (const p of prodRows) {
    prodGroup.set(p.id, p.group_id ?? catDefault.get(p.category_id) ?? "grp_buffet");
  }

  const receiptItems: ReceiptItem[] = [];

  for (const i of args.items) {
    const groupId = prodGroup.get(i.product_id) ?? catDefault.get(i.category_id) ?? "grp_buffet";
    const item: ReceiptItem = {
      id: crypto.randomUUID(),
      receipt_id: receiptId,
      product_id: i.product_id,
      category_id: i.category_id,
      group_id: groupId,
      product_name: i.product_name,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
      line_total_cents: i.qty * i.unit_price_cents,
    };

    receiptItems.push(item);

    await db.execute(
      `INSERT INTO receipt_items
      (id,receipt_id,product_id,category_id,group_id,product_name,qty,unit_price_cents,line_total_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        item.id,
        item.receipt_id,
        item.product_id,
        item.category_id,
        item.group_id,
        item.product_name,
        item.qty,
        item.unit_price_cents,
        item.line_total_cents,
      ]
    );
  }

  const receipt: Receipt = {
    id: receiptId,
    register_id: reg.id,
    receipt_no: next,
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

    const byGroup = new Map<string, ReceiptItem[]>();
    for (const item of receiptItems) {
      if (!byGroup.has(item.group_id)) byGroup.set(item.group_id, []);
      byGroup.get(item.group_id)!.push(item);
    }

    for (const [gid, items] of byGroup.entries()) {
      const gname = groupName.get(gid) ?? gid;
      const sum = items.reduce((a, x) => a + x.line_total_cents, 0);

      const payload = buildEscposText({
        eventName,
        groupName: gname,
        receiptCode,
        when,
        lines: items.map((x) => ({ qty: x.qty, name: x.product_name, lineTotalCents: x.line_total_cents })),
        sumCents: sum,
        paymentType: args.payment_type,
      });

      const job: PrintJob = {
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

      printJobs.push(job);

      await db.execute(
        `INSERT INTO print_jobs
        (id,receipt_id,receipt_code,group_id,group_name,total_cents,status,last_error,payload_text,created_at,printed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          job.id,
          job.receipt_id,
          job.receipt_code,
          job.group_id,
          job.group_name,
          job.total_cents,
          job.status,
          job.last_error,
          job.payload_text,
          job.created_at,
          job.printed_at,
        ]
      );
    }
  }

  return { receipt, items: receiptItems, printJobs };
}

export async function listOpenPrintJobs(): Promise<PrintJob[]> {
  const db = await getDb();
  return await db.select<PrintJob[]>(
    "SELECT * FROM print_jobs WHERE status!='PRINTED' ORDER BY created_at DESC"
  );
}

export async function markPrintJobPrinted(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE print_jobs SET status='PRINTED',printed_at=$2,last_error=NULL WHERE id=$1", [
    id,
    new Date().toISOString(),
  ]);
}

export async function markPrintJobFailed(id: string, err: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE print_jobs SET status='FAILED',last_error=$2 WHERE id=$1", [id, err]);
}

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

  const totalRows = await db.select<{ c: number; s: number }[]>(
    "SELECT COUNT(*) as c, COALESCE(SUM(total_cents),0) as s FROM receipts"
  );

  const by_payment = await db.select<PaymentStat[]>(
    `SELECT payment_type as payment_type,
            COUNT(*) as receipts,
            COALESCE(SUM(total_cents),0) as total_cents
     FROM receipts
     GROUP BY payment_type
     ORDER BY payment_type`
  );

  const by_product = await db.select<ProductStat[]>(
    `SELECT product_id,
            product_name,
            COALESCE(SUM(qty),0) as qty,
            COALESCE(SUM(line_total_cents),0) as total_cents
     FROM receipt_items
     GROUP BY product_id, product_name
     ORDER BY total_cents DESC, qty DESC, product_name ASC`
  );

  const by_group = await db.select<GroupStat[]>(
    `SELECT ri.group_id as group_id,
            COALESCE(pg.name,ri.group_id) as group_name,
            COALESCE(SUM(ri.qty),0) as qty,
            COALESCE(SUM(ri.line_total_cents),0) as total_cents
     FROM receipt_items ri
     LEFT JOIN pickup_groups pg ON pg.id=ri.group_id
     GROUP BY ri.group_id, pg.name
     ORDER BY total_cents DESC`
  );

  return {
    event_name,
    receipts_count: totalRows?.[0]?.c ?? 0,
    total_cents: totalRows?.[0]?.s ?? 0,
    by_payment: by_payment ?? [],
    by_product: by_product ?? [],
    by_group: by_group ?? [],
  };
}

export async function listEventTemplates(): Promise<EventTemplate[]> {
  const db = await getDb();
  return await db.select<EventTemplate[]>(
    "SELECT id,name,event_name,bon_policy,auto_print,created_at,updated_at FROM event_templates ORDER BY name ASC"
  );
}

export async function saveCurrentAsEventTemplate(name: string): Promise<void> {
  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Vorlagenname fehlt");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const event_name = await readSetting("event_name");
  const bon_policy = (await readSetting("bon_policy")) as "NEVER" | "ALWAYS" | "OPTIONAL";
  const auto_print = (await readSetting("auto_print")) === "true" ? 1 : 0;

  await db.execute(
    `INSERT INTO event_templates
    (id,name,event_name,bon_policy,auto_print,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, trimmed, event_name, bon_policy, auto_print, now, now]
  );

  const activeProducts = await listAllActiveProducts();

  for (const p of activeProducts) {
    await db.execute(
      "INSERT INTO event_template_products (template_id,product_id) VALUES ($1,$2)",
      [id, p.id]
    );
  }
}

export async function overwriteEventTemplate(templateId: string): Promise<void> {
  const db = await getDb();

  const event_name = await readSetting("event_name");
  const bon_policy = (await readSetting("bon_policy")) as "NEVER" | "ALWAYS" | "OPTIONAL";
  const auto_print = (await readSetting("auto_print")) === "true" ? 1 : 0;
  const now = new Date().toISOString();

  await db.execute(
    `UPDATE event_templates
     SET event_name=$2,
         bon_policy=$3,
         auto_print=$4,
         updated_at=$5
     WHERE id=$1`,
    [templateId, event_name, bon_policy, auto_print, now]
  );

  await db.execute("DELETE FROM event_template_products WHERE template_id=$1", [templateId]);

  const activeProducts = await listAllActiveProducts();

  for (const p of activeProducts) {
    await db.execute(
      "INSERT INTO event_template_products (template_id,product_id) VALUES ($1,$2)",
      [templateId, p.id]
    );
  }
}

export async function applyEventTemplate(templateId: string): Promise<void> {
  const db = await getDb();

  const rows = await db.select<EventTemplate[]>(
    "SELECT id,name,event_name,bon_policy,auto_print,created_at,updated_at FROM event_templates WHERE id=$1",
    [templateId]
  );

  const t = rows?.[0];
  if (!t) throw new Error("Vorlage nicht gefunden");

  await writeSetting("event_name", t.event_name);
  await writeSetting("bon_policy", t.bon_policy);
  await writeSetting("auto_print", t.auto_print === 1 ? "true" : "false");

  await db.execute("UPDATE products SET active=0");

  const active = await db.select<{ product_id: string }[]>(
    "SELECT product_id FROM event_template_products WHERE template_id=$1",
    [templateId]
  );

  for (const p of active) {
    await db.execute("UPDATE products SET active=1 WHERE id=$1", [p.product_id]);
  }
}

export async function deleteEventTemplate(id: string): Promise<void> {
  const db = await getDb();

  await db.execute("DELETE FROM event_template_products WHERE template_id=$1", [id]);
  await db.execute("DELETE FROM event_templates WHERE id=$1", [id]);
}