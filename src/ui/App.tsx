import React, { useEffect, useMemo, useState } from "react";
import {
  Category,
  Product,
  Receipt,
  ReceiptItem,
  PrintJob,
  PickupGroup,
  listCategories,
  listProductsByCategory,
  listPickupGroups,
  updatePickupGroupName,
  createPickupGroup,
  upsertProduct,
  updateProductGroup,
  readSetting,
  writeSetting,
  getRegister,
  updateRegisterNamePrefix,
  createReceipt,
  listOpenPrintJobs,
  markPrintJobPrinted,
  markPrintJobFailed,
  listAllActiveProducts,
  getDb,
  getEventSummary,
  type EventSummary,
} from "../data/db";

import { formatEuro } from "./money";
import { printRawWindows } from "./print";

type CartLine = { product: Product; qty: number };
type BonPolicy = "NEVER" | "ALWAYS" | "OPTIONAL";

function sumCart(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty * l.product.price_cents, 0);
}

export default function App() {
  const [tab, setTab] = useState<"kassa" | "queue" | "settings">("kassa");

  const [cats, setCats] = useState<Category[]>([]);
  const [groups, setGroups] = useState<PickupGroup[]>([]);
  const [productsByCat, setProductsByCat] = useState<Record<string, Product[]>>({});
  const [cart, setCart] = useState<CartLine[]>([]);
  const total = useMemo(() => sumCart(cart), [cart]);

  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("1234");
  const [bonPolicy, setBonPolicy] = useState<BonPolicy>("NEVER");

  const [eventName, setEventName] = useState("Stadtmeisterschaft Laakirchen");
  const [printerName, setPrinterName] = useState("POS-80C");
  const [autoPrint, setAutoPrint] = useState(false);

  const [lastReceipt, setLastReceipt] = useState<{ receipt: Receipt; items: ReceiptItem[] } | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const [showOptionalBon, setShowOptionalBon] = useState(false);
  const [pendingPayment, setPendingPayment] = useState<"CASH" | "CARD" | null>(null);

  useEffect(() => {
  (async () => {
    const c = await listCategories();
    setCats(c);
    // Produkte für ALLE Kategorien laden (damit wir alles auf einer Seite anzeigen können)
const lists = await Promise.all(c.map(cat => listProductsByCategory(cat.id)));
const map: Record<string, Product[]> = {};
for (let i = 0; i < c.length; i++) map[c[i].id] = lists[i] ?? [];
setProductsByCat(map);


    


    const g = await listPickupGroups();
    setGroups(g);

    setPin(await readSetting("lock_pin"));
    setBonPolicy((await readSetting("bon_policy")) as BonPolicy);

    setEventName(await readSetting("event_name"));
    setPrinterName(await readSetting("printer_name"));
    setAutoPrint((await readSetting("auto_print")) === "true");
  })().catch(console.error);
}, []);



  function addToCart(p: Product) {
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.product.id === p.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
      }
      return [...prev, { product: p, qty: 1 }];
    });
  }

  function inc(id: string) {
    setCart((prev) => prev.map((l) => (l.product.id === id ? { ...l, qty: l.qty + 1 } : l)));
  }

  function dec(id: string) {
    setCart((prev) =>
      prev
        .map((l) => (l.product.id === id ? { ...l, qty: l.qty - 1 } : l))
        .filter((l) => l.qty > 0)
    );
  }

  function resetCart() {
    setCart([]);
  }

  async function checkout(payment: "CASH" | "CARD", printRequired: boolean) {
    const items = cart.map((l) => ({
      product_id: l.product.id,
      category_id: l.product.category_id,
      product_name: l.product.name,
      qty: l.qty,
      unit_price_cents: l.product.price_cents,
    }));

    const { receipt, items: savedItems, printJobs } = await createReceipt({
      payment_type: payment,
      items,
      print_required: printRequired,
    });

    setLastReceipt({ receipt, items: savedItems });

    // AUTO PRINT: if enabled, print all split print-jobs immediately (still stored in queue)
    if (printRequired && autoPrint && printJobs?.length) {
      for (const j of printJobs) {
        try {
          await printRawWindows(printerName, j.payload_text);
          await markPrintJobPrinted(j.id);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          await markPrintJobFailed(j.id, msg);
        }
      }
    }
    if (printRequired) setShowReceipt(true);
    resetCart();
  }

  async function onPay(payment: "CASH" | "CARD") {
  if (total <= 0) return;

  try {
    if (bonPolicy === "OPTIONAL") {
      setPendingPayment(payment);
      setShowOptionalBon(true);
      return;
    }

    const printRequired = bonPolicy === "ALWAYS";
    await checkout(payment, printRequired);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error(e);
    alert("Bezahlen fehlgeschlagen:\n\n" + msg);
  }
}


  async function chooseOptional(printBon: boolean) {
    const payment = pendingPayment;
    setShowOptionalBon(false);
    setPendingPayment(null);
    if (!payment) return;
    await checkout(payment, printBon);
  }

  async function lockNow() {
    const ok = window.confirm("Kassa sperren?");
    if (!ok) return;
    setLocked(true);
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Orderman Light V2</div>
        <div className="pill">v0.3.3 • POS-80C • Split-Bons (Ausschank/Buffet)</div>

        <div className="nav">
          <button type="button" className={tab === "kassa" ? "active" : ""} onClick={() => setTab("kassa")}>Kassa</button>
          <button type="button" className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>Druck-Queue</button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Einstellungen</button>
          <button type="button" onClick={lockNow} style={{ borderColor: "rgba(239,68,68,.6)" }}>Kassa sperren</button>
        </div>
      </div>

      {tab === "kassa" ? (
        <div className="main kassa">
          
          <div className="panel">
  <div className="panel-header">
    <h2>Artikel</h2>
    <span className="small">
      {Object.values(productsByCat).reduce((a, arr) => a + (arr?.length ?? 0), 0)} aktiv
    </span>
  </div>

  <div className="panel-body">
    {cats.map((c) => {
      const list = productsByCat[c.id] ?? [];
      if (list.length === 0) return null;

      return (
        <div key={c.id} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>
            {c.name}
          </div>

          <div className="grid">
            {list.map((p) => (
              <button
                type="button"
                key={p.id}
                className="tile"
                onClick={() => addToCart(p)}
              >
                <div className="name">{p.name}</div>
                <div className="price">{formatEuro(p.price_cents)}</div>
              </button>
            ))}
          </div>
        </div>
      );
    })}
  </div>
</div>


          <div className="panel cart" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div className="panel-header"><h2>Warenkorb</h2><span className="small">{cart.reduce((a, l) => a + l.qty, 0)} Stk</span></div>
            <div className="cart-list" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              {cart.length === 0 ? <div className="small">Noch leer — klick links auf Produkte.</div> : null}
              {cart.map((l) => (
                <div className="cart-row" key={l.product.id}>
                  <div>
                    <div className="title">{l.product.name}</div>
                    <div className="meta">
                      {l.qty} × {formatEuro(l.product.price_cents)} • Pos: {formatEuro(l.qty * l.product.price_cents)}
                    </div>
                  </div>
                  <div className="qty qty-h">
  <button type="button" onClick={() => dec(l.product.id)}>-</button>
  <div className="val">{l.qty}</div>
  <button type="button" onClick={() => inc(l.product.id)}>+</button>
</div>
                </div>
              ))}
            </div>
            <div className="footer" style={{ marginTop: "auto" }}>
              <div className="total"><span>Gesamt</span><span>{formatEuro(total)}</span></div>
              <div className="pay">
                <button type="button" className="cash" disabled={total <= 0} onClick={() => onPay("CASH")}>BAR</button>
                <button type="button" className="card" disabled={total <= 0} onClick={() => onPay("CARD")}>KARTE</button>
              </div>
              <button type="button" style={{ padding: "12px 0", borderRadius: "14px", border: "1px solid var(--border)", background: "transparent", color: "var(--muted)" }} onClick={resetCart}>
                Reset Warenkorb
              </button>
              {lastReceipt ? (
                <button type="button" style={{ padding: "12px 0", borderRadius: "14px", border: "1px solid rgba(59,130,246,.45)", background: "rgba(59,130,246,.12)", color: "var(--text)", fontWeight: 900 }}
                        onClick={() => setShowReceipt(true)}>
                  Letzten Beleg anzeigen ({lastReceipt.receipt.receipt_code})
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : tab === "queue" ? (
        <PrintQueue printerName={printerName} />

      ) : (
        <Settings
          cats={cats}
          groups={groups}
          eventName={eventName}
          printerName={printerName}
          autoPrint={autoPrint}
          onReload={async () => {
  const c = await listCategories();
  setCats(c);

  const g = await listPickupGroups();
  setGroups(g);

  // Produkte neu laden für alle Kategorien
  const lists = await Promise.all(c.map(cat => listProductsByCategory(cat.id)));
  const map: Record<string, Product[]> = {};
  for (let i = 0; i < c.length; i++) map[c[i].id] = lists[i] ?? [];
  setProductsByCat(map);

  // Settings neu laden
  setEventName(await readSetting("event_name"));
  setPrinterName(await readSetting("printer_name"));
  setAutoPrint((await readSetting("auto_print")) === "true");
}}

          onPolicyChange={(p) => setBonPolicy(p)}
          onPinChange={(p) => setPin(p)}
        />
      )}

      {showOptionalBon ? (
        <Modal title="Bezahlen (Optional)">
          <div className="small">Soll ein Beleg/BON erstellt werden?</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <button type="button" style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }} onClick={() => chooseOptional(true)}>
              FERTIG + BON
            </button>
            <button type="button" style={{ ...btn }} onClick={() => chooseOptional(false)}>
              FERTIG OHNE BON
            </button>
          </div>
          <div style={{ marginTop: 10 }} className="small">
            „BON“ = Split-Bons je Abholstation + Druck-Queue.
          </div>
        </Modal>
      ) : null}

      {showReceipt && lastReceipt ? (
        <ReceiptModal data={lastReceipt} onClose={() => setShowReceipt(false)} />
      ) : null}

      {locked ? (
        <LockScreen pin={pin} onUnlock={() => setLocked(false)} />
      ) : null}
    </div>
  );
}

function ReceiptModal(props: { data: { receipt: Receipt; items: ReceiptItem[] }; onClose: () => void }) {
  const r = props.data.receipt;
  const items = props.data.items;
  return (
    <Modal title={`BELEG • ${r.receipt_code}`}>
      <div className="small">Zahlart: <b>{r.payment_type === "CASH" ? "BAR" : "KARTE"}</b> • Status: <b>BEZAHLT</b></div>
      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 14, padding: 12, background: "rgba(255,255,255,.02)" }}>
        {items.map((it) => (
          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px dashed rgba(255,255,255,.06)" }}>
            <div style={{ fontWeight: 800 }}>{it.qty}× {it.product_name}</div>
            <div style={{ color: "var(--muted)" }}>{formatEuro(it.unit_price_cents)} → {formatEuro(it.line_total_cents)}</div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontWeight: 900 }}>
          <div>Gesamt</div>
          <div>{formatEuro(r.total_cents)}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button type="button" style={{ ...btn, flex: 1 }} onClick={props.onClose}>Schließen</button>
      </div>
      <div className="small" style={{ marginTop: 10 }}>
        Tipp: Für echten Ausdruck: Druck-Queue → Job drucken (oder Auto-Druck kommt später).
      </div>
    </Modal>
  );
}

function PrintQueue(props: { printerName: string }) {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  async function refresh() {
    setJobs(await listOpenPrintJobs());
  }
  useEffect(() => { refresh().catch(console.error); }, []);

  async function doPrint(j: PrintJob) {
    try {
      await printRawWindows(props.printerName, j.payload_text);
      await markPrintJobPrinted(j.id);
      await refresh();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await markPrintJobFailed(j.id, msg);
      await refresh();
      alert("Druck fehlgeschlagen. Notbeleg gilt als Beleg (kein Beleg = keine Ware).\n\n" + msg);
      // Notbeleg: show payload text
      window.alert(j.payload_text);
    }
  }

  return (
    <div className="main settings">
      <div className="panel">
        <div className="panel-header">
          <h2>Druck-Queue</h2>
          <button type="button" onClick={refresh} style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}>
            Refresh
          </button>
        </div>
        <div className="panel-body">
          <div className="small">Aktueller Drucker: <b>{props.printerName}</b></div>
          {jobs.length === 0 ? <div className="small" style={{ marginTop: 10 }}>Keine offenen Jobs.</div> : null}
          {jobs.map((j) => (
            <div key={j.id} style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12, marginTop: 10, background: "rgba(255,255,255,.02)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>{j.group_name} • {j.receipt_code}</div>
                <div className="small">Status: <b>{j.status}</b></div>
              </div>
              <div className="small" style={{ marginTop: 6 }}>Summe: <b>{formatEuro(j.total_cents)}</b></div>
              {j.last_error ? <div className="small" style={{ marginTop: 6, color: "#fecaca" }}>Fehler: {j.last_error}</div> : null}
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button type="button" style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)", flex: 1 }} onClick={() => doPrint(j)}>
                  Drucken
                </button>
                <button type="button" style={{ ...btn, flex: 1 }} onClick={() => window.alert(j.payload_text)}>
                  Notbeleg anzeigen
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Settings(props: {
  cats: Category[];
  groups: PickupGroup[];
  eventName: string;
  printerName: string;
  autoPrint: boolean;
  onReload: () => void;
  onPolicyChange: (p: BonPolicy) => void;
  onPinChange: (p: string) => void;
}) {
  const [regName, setRegName] = useState("K1 Allgemein");
  const [regPrefix, setRegPrefix] = useState("K1");
  const [policy, setPolicy] = useState<BonPolicy>("NEVER");
  const [lockPin, setLockPin] = useState("1234");

  const [eventName, setEventName] = useState(props.eventName);
  const [printerName, setPrinterName] = useState(props.printerName);
  const [autoPrint, setAutoPrint] = useState(props.autoPrint);

  const [prodName, setProdName] = useState("");
  const [prodPrice, setProdPrice] = useState("2,50");
  const [cat, setCat] = useState(props.cats[0]?.id ?? "");
  const [groupId, setGroupId] = useState(props.groups[0]?.id ?? "grp_buffet");
  const [showSummary, setShowSummary] = useState(false);
const [summary, setSummary] = useState<EventSummary | null>(null);
const s = summary;

function downloadTextFile(filename: string, text: string, mime = "text/csv;charset=utf-8;") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Array<Record<string, any>>, headers: string[]): string {
  const esc = (v: any) => {
    const s = String(v ?? "");
    const q = s.replaceAll('"', '""');
    return `"${q}"`;
  };
  const out: string[] = [];
  out.push(headers.map(esc).join(";"));
  for (const r of rows) out.push(headers.map(h => esc(r[h])).join(";"));
  return out.join("\n");
}

async function runFestabschluss() {
  try {
    const data = await getEventSummary();
    setSummary(data);
    setShowSummary(true);
  } catch (e: any) {
    alert("Festabschluss fehlgeschlagen: " + (e?.message ?? String(e)));
  }
}


  useEffect(() => {
    (async () => {
      const r = await getRegister();
      setRegName(r.name);
      setRegPrefix(r.prefix);
      setPolicy((await readSetting("bon_policy")) as BonPolicy);
      setLockPin(await readSetting("lock_pin"));
      setEventName(await readSetting("event_name"));
      setPrinterName(await readSetting("printer_name"));
      setAutoPrint((await readSetting("auto_print")) === "true");
    })().catch(console.error);
  }, []);

  useEffect(() => { if (!cat && props.cats[0]?.id) setCat(props.cats[0].id); }, [props.cats, cat]);
  useEffect(() => { if (!groupId && props.groups[0]?.id) setGroupId(props.groups[0].id); }, [props.groups, groupId]);

  async function saveRegister() {
    if (!regName.trim()) return alert("Kassa-Name fehlt");
    if (!regPrefix.trim()) return alert("Prefix fehlt (z.B. K1)");
    await updateRegisterNamePrefix(regName.trim(), regPrefix.trim().toUpperCase());
    alert("Kassa gespeichert.");
  }

  async function savePolicy() {
  await writeSetting("bon_policy", policy);
  props.onPolicyChange(policy);

  // WICHTIG: State sofort neu laden
  const fresh = await readSetting("bon_policy");
  props.onPolicyChange(fresh as BonPolicy);

  alert("Bon-Policy gespeichert.");
}


  async function savePin() {
    const p = lockPin.trim();
    if (!/^\d{4,6}$/.test(p)) return alert("PIN bitte 4–6 Ziffern.");
    await writeSetting("lock_pin", p);
    props.onPinChange(p);
    alert("PIN gespeichert.");
  }

  async function saveEventAndPrinter() {
    if (!eventName.trim()) return alert("Veranstaltungsname fehlt");
    if (!printerName.trim()) return alert("Druckername fehlt (z.B. POS-80C)");
    await writeSetting("event_name", eventName.trim());
    await writeSetting("printer_name", printerName.trim());
    await writeSetting("auto_print", autoPrint ? "true" : "false");
    alert("Event/Drucker gespeichert.");
    await props.onReload();
  }

    async function resetAllData() {
  if (
    !confirm(
      "Wirklich ALLE Daten löschen?\n\n" +
      "- Artikel\n" +
      "- Belege/Abschlüsse\n" +
      "- Druck-Queue\n\n" +
      "Dieser Vorgang kann nicht rückgängig gemacht werden."
    )
  ) return;

  try {
    const db = await getDb();

    // FK sicher: erst Kinder, dann Eltern
    await db.execute("DELETE FROM receipt_items");
    await db.execute("DELETE FROM print_jobs");
    await db.execute("DELETE FROM receipts");
    await db.execute("DELETE FROM products");
    try { await db.execute("DELETE FROM app_settings"); } catch (_) {}



    alert("Alles gelöscht. App startet neu.");
    window.location.reload();
  } catch (e: any) {
    alert("Fehler beim Löschen: " + (e?.message ?? String(e)));
  }
}
async function addPickupGroup() {
  const name = window.prompt("Name der neuen Abholstation:", "Neue Station");
  if (name === null) return;

  try {
    await createPickupGroup(name);
    await props.onReload();

    // optional: neue Station direkt beim Produktformular vorauswählen
    const refreshed = await listPickupGroups();
    const last = refreshed[refreshed.length - 1];
    if (last?.id) setGroupId(last.id);
  } catch (e: any) {
    alert("Abholstation konnte nicht angelegt werden: " + (e?.message ?? String(e)));
  }
}



  async function saveGroupName(id: string, name: string) {
  await updatePickupGroupName(id, name);
  await props.onReload();
}


  async function saveProduct() {
    const cents = parsePriceToCents(prodPrice);
    if (!prodName.trim()) return alert("Name fehlt");
    if (Number.isNaN(cents) || cents <= 0) return alert("Preis ungültig (z.B. 2,50)");
    if (!cat) return alert("Kategorie wählen");
    await upsertProduct({ name: prodName.trim(), price_cents: cents, category_id: cat, group_id: groupId });
    setProdName("");
    setProdPrice("2,50");
    await props.onReload();
  }

  return (
    <>
    <div className="main settings">
      <div className="panel">
        <div className="panel-header"><h2>Setup</h2><span className="small">Kassa / Bon / PIN / Druck</span></div>
        <div className="panel-body">
          <div style={{ display: "grid", gap: 10, maxWidth: 820 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="small">Kassa-Name</label>
                <input value={regName} onChange={e => setRegName(e.target.value)} style={inp} />
              </div>
              <div>
                <label className="small">Prefix</label>
                <input value={regPrefix} onChange={e => setRegPrefix(e.target.value)} style={inp} placeholder="K1" />
              </div>
            </div>
            <button type="button" onClick={saveRegister} style={{ ...btn, maxWidth: 280 }}>Kassa speichern</button>

            <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} />

            <label className="small">Veranstaltungsname (Bon-Kopf)</label>
            <input value={eventName} onChange={e => setEventName(e.target.value)} style={inp} />
            <label className="small">Druckername (Windows) – z.B. POS-80C</label>
            <input value={printerName} onChange={e => setPrinterName(e.target.value)} style={inp} />

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
              <input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} />
              <div>
                <div style={{ fontWeight: 900 }}>Auto-Druck</div>
                <div className="small">Wenn ein Bon erforderlich ist, druckt er sofort automatisch (Split-Bons pro Abholstation).</div>
              </div>
            </div>
            <button type="button" onClick={saveEventAndPrinter} style={{ ...btn, maxWidth: 320 }}>Event/Drucker speichern</button>
            <button type="button" onClick={resetAllData} style={{ ...btn, maxWidth: 320, marginTop: 10 }}>Alle Daten löschen (Reset)</button>
            <button
  type="button"
  onClick={runFestabschluss}
  style={{ ...btn, maxWidth: 320, marginTop: 10, borderColor: "rgba(59,130,246,.45)", background: "rgba(59,130,246,.12)" }}
>
  Veranstaltung Ende (Festabschluss)
</button>


            <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} />

            <label className="small">Bon-Policy</label>
<select
  value={policy}
  onChange={(e) => setPolicy(e.target.value as BonPolicy)}
  style={inp}
>
  <option value="NEVER">NEVER (kleiner Spieltag)</option>
  <option value="ALWAYS">ALWAYS (Fest/Turnier)</option>
  <option value="OPTIONAL">OPTIONAL (pro Bon wählen)</option>
</select>

            <button type="button" onClick={savePolicy} style={{ ...btn, maxWidth: 280 }}>Bon-Policy speichern</button>

            <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} />

            <label className="small">PIN für „Kassa sperren“ (4–6 Ziffern)</label>
            <input value={lockPin} onChange={e => setLockPin(e.target.value)} style={inp} />
            <button type="button" onClick={savePin} style={{ ...btn, maxWidth: 280 }}>PIN speichern</button>

            <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} />

            <label className="small">Abholstationen (Split-Bons)</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {props.groups.map(g => (
                <div key={g.id}>
                  <div className="small" style={{ marginBottom: 6 }}>{g.id}</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <input defaultValue={g.name} onBlur={(e) => saveGroupName(g.id, e.target.value)} style={inp} />
                  </div>
                </div>
              ))}
            </div>
            <button
  type="button"
  onClick={addPickupGroup}
  style={{ ...btn, maxWidth: 320, marginTop: 10 }}
>
  + Abholstation hinzufügen
</button>

            <div className="notice" style={{ marginTop: 10 }}>
              Tipp: Alkohol-Produkte auf „Ausschank“, alles andere auf „Buffet“ → dann druckt er automatisch 2 Bons.
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Produkt anlegen</h2><span className="small">inkl. Abholstation</span></div>
        <div className="panel-body">
          <div style={{ display: "grid", gap: 10, maxWidth: 640 }}>
            <label className="small">Name</label>
            <input value={prodName} onChange={e => setProdName(e.target.value)} placeholder="z.B. Spritzer" style={inp} />
            <label className="small">Preis (€, Komma)</label>
            <input value={prodPrice} onChange={e => setProdPrice(e.target.value)} placeholder="2,50" style={inp} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="small">Kategorie</label>
<select value={cat} onChange={e => setCat(e.target.value)} style={inp}>
  {props.cats.map(c => (
    <option key={c.id} value={c.id}>{c.name}</option>
  ))}
</select>

              </div>
              <div>
                <label className="small">Abholstation</label>
<select value={groupId} onChange={e => setGroupId(e.target.value)} style={inp}>
  {props.groups.map(g => (
    <option key={g.id} value={g.id}>{g.name}</option>
  ))}
</select>

              </div>
            </div>
            <button type="button" onClick={saveProduct} style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}>Produkt speichern</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Hinweis</h2><span className="small">Beste Praxis</span></div>
        <div className="panel-body">
          <div className="small">
            1) Vor Veranstaltung: Eventname + Drucker + Bon-Policy setzen.<br />
            2) Alkohol-Produkte auf „Ausschank“ stellen.<br />
            3) Beim Bezahlen mit BON: Druck-Queue druckt getrennte Bons je Abholstation.
          </div>
        </div>
      </div>
    </div>

    {showSummary && s ? (
        <Modal title="Festabschluss">
          <div className="small">
            Event: <b>{s.event_name}</b><br />
            Bestellungen: <b>{s.receipts_count}</b><br />
            Umsatz: <b>{formatEuro(s.total_cents)}</b>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Zahlarten</div>
              {s.by_payment.length === 0 ? (
                <div className="small">Keine Daten.</div>
              ) : (
                s.by_payment.map(p => (
                  <div key={p.payment_type} style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>{p.payment_type === "CASH" ? "BAR" : "KARTE"} ({p.receipts})</div>
                    <div style={{ fontWeight: 900 }}>{formatEuro(p.total_cents)}</div>
                  </div>
                ))
              )}
            </div>

            <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Produkte (Top)</div>
              {s.by_product.slice(0, 20).map(p => (
                <div key={p.product_id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.qty}× {p.product_name}
                  </div>
                  <div style={{ fontWeight: 900 }}>{formatEuro(p.total_cents)}</div>
                </div>
              ))}
              <div className="small" style={{ marginTop: 8 }}>CSV enthält alle Produkte.</div>
            </div>

            <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Abholstationen</div>
              {s.by_group.map(g => (
                <div key={g.group_id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>{g.group_name} ({g.qty} Stk)</div>
                  <div style={{ fontWeight: 900 }}>{formatEuro(g.total_cents)}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                type="button"
                style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
                onClick={() => {
                  const rows = s.by_product.map(p => ({
                    product_name: p.product_name,
                    qty: p.qty,
                    total_eur: (p.total_cents / 100).toFixed(2).replace(".", ","),
                  }));
                  const csv = toCsv(rows, ["product_name", "qty", "total_eur"]);
                  downloadTextFile(`festabschluss_produkte_${new Date().toISOString().slice(0,10)}.csv`, csv);
                }}
              >
                CSV: Produkte
              </button>

              <button
                type="button"
                style={{ ...btn, background: "rgba(59,130,246,.12)", borderColor: "rgba(59,130,246,.45)" }}
                onClick={() => {
                  const rows = [
                    { key: "event_name", value: s.event_name },
                    { key: "receipts_count", value: s.receipts_count },
                    { key: "total_eur", value: (s.total_cents / 100).toFixed(2).replace(".", ",") },
                    ...s.by_payment.map(p => ({
                      key: `payment_${p.payment_type}`,
                      value: (p.total_cents / 100).toFixed(2).replace(".", ","),
                    })),
                  ];
                  const csv = toCsv(rows, ["key", "value"]);
                  downloadTextFile(`festabschluss_summary_${new Date().toISOString().slice(0,10)}.csv`, csv);
                }}
              >
                CSV: Summary
              </button>
            </div>

            <button type="button" style={{ ...btn }} onClick={() => setShowSummary(false)}>
              Schließen
            </button>
          </div>
        </Modal>
    ) : null}
</>
  );
}

function LockScreen(props: { pin: string; onUnlock: () => void }) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  function submit() {
    if (val === props.pin) {
      setVal("");
      setErr(null);
      props.onUnlock();
    } else {
      setErr("Falscher PIN");
      setVal("");
    }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "grid", placeItems: "center", zIndex: 9999 }}>
      <div style={{ width: "min(520px, 92vw)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 24, padding: 18, boxShadow: "var(--shadow)" }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>Kassa gesperrt</div>
        <div className="small" style={{ marginTop: 6 }}>PIN eingeben zum Entsperren.</div>
        <input autoFocus value={val} onChange={e => setVal(e.target.value)} inputMode="numeric" placeholder="PIN"
               style={{ ...inp, marginTop: 12, fontSize: 20, textAlign: "center", letterSpacing: 6 }} />
        {err ? <div style={{ marginTop: 8, color: "#fecaca", fontWeight: 800 }}>{err}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          <button type="button" style={{ ...btn }} onClick={submit}>Entsperren</button>
          <button type="button" style={{ ...btn, borderColor: "rgba(239,68,68,.55)" }} onClick={() => { setVal(""); setErr(null); }}>
            Eingabe löschen
          </button>
        </div>
      </div>
      </div>
  );
}




function Modal(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.60)", display: "grid", placeItems: "center", zIndex: 9998 }}>
      <div className="panel" style={{ width: "min(760px, 92vw)" }}>
        <div className="panel-header"><h2>{props.title}</h2></div>
        <div className="panel-body">{props.children}</div>
      </div>
    </div>
  );
}

const inp: React.CSSProperties = {
  padding: "14px 14px",
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "rgba(0,0,0,.18)",
  color: "var(--text)",
  outline: "none",
  width: "100%",
};

const btn: React.CSSProperties = {
  padding: "14px 0",
  borderRadius: 16,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 900,
};

function parsePriceToCents(input: string): number {
  const s = input.trim().replace("€", "").replace(/\s/g, "").replace(".", "").replace(",", ".");
  const n = Number(s);
  return Math.round(n * 100);
}
