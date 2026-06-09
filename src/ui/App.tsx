import React, { useEffect, useMemo, useState } from "react";
import {
  Category,
  Product,
  Receipt,
  ReceiptItem,
  PrintJob,
  PickupGroup,
  EventTemplate,
  listCategories,
  listProductsByCategory,
  listPickupGroups,
  updatePickupGroupName,
  createPickupGroup,
  upsertProduct,
  deleteProduct,
  readSetting,
  writeSetting,
  getRegister,
  updateRegisterNamePrefix,
  createReceipt,
  listOpenPrintJobs,
  markPrintJobPrinted,
  markPrintJobFailed,
  getDb,
  getEventSummary,
  listAllProducts,
  setProductActive,
  updateProductTodayActive,
  listEventTemplates,
  saveCurrentAsEventTemplate,
  overwriteEventTemplate,
  applyEventTemplate,
  deleteEventTemplate,
  type EventSummary,
} from "../data/db";

import { formatEuro } from "./money";
import { printRawWindows } from "./print";

type CartLine = { product: Product; qty: number };
type BonPolicy = "NEVER" | "ALWAYS" | "OPTIONAL";

let appAlertImpl: ((message: string) => void) | null = null;
let appConfirmImpl: ((message: string) => Promise<boolean>) | null = null;

function appAlert(message: string) {
  if (appAlertImpl) appAlertImpl(message);
  else window.alert(message);
}

function appConfirm(message: string): Promise<boolean> {
  if (appConfirmImpl) return appConfirmImpl(message);
  return Promise.resolve(window.confirm(message));
}

function sumCart(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty * l.product.price_cents, 0);
}

export default function App() {
  const [tab, setTab] = useState<"kassa" | "queue" | "event" | "settings">("kassa");

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

  const [showCashModal, setShowCashModal] = useState(false);
  const [cashSuggestions, setCashSuggestions] = useState<number[]>([]);
  const [selectedCash, setSelectedCash] = useState<number | null>(null);
  const [manualCash, setManualCash] = useState("");
  const [dialog, setDialog] = useState<{
  type: "alert" | "confirm";
  message: string;
  resolve?: (value: boolean) => void;
} | null>(null);

  async function reloadBaseData() {
    const c = await listCategories();
    setCats(c);

    const g = await listPickupGroups();
    setGroups(g);

    const lists = await Promise.all(c.map((cat) => listProductsByCategory(cat.id)));
    const map: Record<string, Product[]> = {};
    for (let i = 0; i < c.length; i++) map[c[i].id] = lists[i] ?? [];
    setProductsByCat(map);

    setPin(await readSetting("lock_pin"));
    setBonPolicy((await readSetting("bon_policy")) as BonPolicy);
    setEventName(await readSetting("event_name"));
    setPrinterName(await readSetting("printer_name"));
    setAutoPrint((await readSetting("auto_print")) === "true");
  }

  useEffect(() => {
    reloadBaseData().catch(console.error);
  }, []);

  useEffect(() => {
  appAlertImpl = (message: string) => {
    setDialog({ type: "alert", message });
  };

  appConfirmImpl = (message: string) => {
    return new Promise<boolean>((resolve) => {
      setDialog({ type: "confirm", message, resolve });
    });
  };

  return () => {
    appAlertImpl = null;
    appConfirmImpl = null;
  };
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

    if (payment === "CASH") {
      setCashSuggestions(generateCashSuggestions(total));
      setSelectedCash(null);
      setManualCash("");
      setShowCashModal(true);
      return;
    }

    try {
      if (bonPolicy === "OPTIONAL") {
        setPendingPayment(payment);
        setShowOptionalBon(true);
        return;
      }

      await checkout(payment, bonPolicy === "ALWAYS");
    } catch (e: any) {
      appAlert("Bezahlen fehlgeschlagen:\n\n" + String(e?.message ?? e));
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
    if (await appConfirm("Kassa sperren?")) setLocked(true);
  }

  const manualCashCents = parsePriceToCentsSafe(manualCash);
  const effectiveCash = selectedCash ?? manualCashCents;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Orderman Light V2</div>
        <div className="pill">v0.3.7 • Barlogik + Handeingabe</div>

        <div className="nav">
          <button type="button" className={tab === "kassa" ? "active" : ""} onClick={() => setTab("kassa")}>
            Kassa
          </button>
          <button type="button" className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
            Druck-Queue
          </button>
          <button type="button" className={tab === "event" ? "active" : ""} onClick={() => setTab("event")}>
            Veranstaltung erstellen
          </button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            Einstellungen
          </button>
          <button type="button" onClick={lockNow} style={{ borderColor: "rgba(239,68,68,.6)" }}>
            Kassa sperren
          </button>
        </div>
      </div>

      {tab === "kassa" ? (
        <KassaView
          cats={cats}
          productsByCat={productsByCat}
          cart={cart}
          total={total}
          addToCart={addToCart}
          inc={inc}
          dec={dec}
          resetCart={resetCart}
          onPay={onPay}
          lastReceipt={lastReceipt}
          showLastReceipt={() => setShowReceipt(true)}
        />
      ) : tab === "queue" ? (
        <PrintQueue printerName={printerName} />
      ) : tab === "event" ? (
        <EventSetup cats={cats} groups={groups} onReload={reloadBaseData} onPolicyChange={setBonPolicy} />
      ) : (
        <Settings onReload={reloadBaseData} onPolicyChange={setBonPolicy} onPinChange={setPin} />
      )}

      {showOptionalBon ? (
        <Modal title="Bezahlen (Optional)">
          <div className="small">Soll ein Beleg/BON erstellt werden?</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <button
              type="button"
              style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
              onClick={() => chooseOptional(true)}
            >
              FERTIG + BON
            </button>
            <button type="button" style={{ ...btn }} onClick={() => chooseOptional(false)}>
              FERTIG OHNE BON
            </button>
          </div>
        </Modal>
      ) : null}

      {showReceipt && lastReceipt ? <ReceiptModal data={lastReceipt} onClose={() => setShowReceipt(false)} /> : null}

      {showCashModal ? (
        <Modal title="BAR Zahlung">
          <div className="small" style={{ marginBottom: 10 }}>
            Summe: <b>{formatEuro(total)}</b>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {cashSuggestions.map((c) => (
              <button
                key={c}
                type="button"
                style={{
                  ...btn,
                  padding: "16px 0",
                  fontSize: 17,
                  background: selectedCash === c ? "rgba(34,197,94,.18)" : "transparent",
                  borderColor: selectedCash === c ? "rgba(34,197,94,.6)" : "var(--border)",
                }}
                onClick={() => {
                  setSelectedCash(c);
                  setManualCash("");
                }}
              >
                {formatEuro(c)}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            <label className="small">Betrag händisch eingeben</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, marginTop: 6 }}>
              <input
                value={manualCash}
                onChange={(e) => {
                  setManualCash(e.target.value);
                  setSelectedCash(null);
                }}
                placeholder="z.B. 107 oder 107,50"
                inputMode="decimal"
                style={{ ...inp, fontSize: 18 }}
              />
              <button
                type="button"
                style={{ ...btn, paddingLeft: 20, paddingRight: 20 }}
                onClick={() => {
                  const cents = parsePriceToCentsSafe(manualCash);
                  if (cents === null || cents < total) {
                    appAlert("Der eingegebene Betrag ist ungültig oder kleiner als die Summe.");
                    return;
                  }
                  setSelectedCash(cents);
                  setManualCash("");
                }}
              >
                Übernehmen
              </button>
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              border: "1px solid var(--border)",
              borderRadius: 18,
              padding: "18px 12px",
              textAlign: "center",
              background: "rgba(255,255,255,.03)",
            }}
          >
            <div style={{ fontSize: 14, color: "var(--muted)" }}>Wechselgeld</div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 900,
                marginTop: 6,
                color: effectiveCash !== null && effectiveCash >= total ? "#22c55e" : "#f87171",
              }}
            >
              {effectiveCash !== null ? formatEuro(effectiveCash - total) : "—"}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
            <button type="button" style={{ ...btn }} onClick={() => setShowCashModal(false)}>
              Abbrechen
            </button>
            <button
              type="button"
              style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
              disabled={effectiveCash === null || effectiveCash < total}
              onClick={async () => {
                setShowCashModal(false);
                if (bonPolicy === "OPTIONAL") {
                  setPendingPayment("CASH");
                  setShowOptionalBon(true);
                  return;
                }
                await checkout("CASH", bonPolicy === "ALWAYS");
              }}
            >
              Bezahlen
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog ? (
  <AppDialog
    type={dialog.type}
    message={dialog.message}
    onOk={() => {
      if (dialog.type === "confirm") dialog.resolve?.(true);
      setDialog(null);
    }}
    onCancel={() => {
      if (dialog.type === "confirm") dialog.resolve?.(false);
      setDialog(null);
    }}
  />
) : null}

      {locked ? <LockScreen pin={pin} onUnlock={() => setLocked(false)} /> : null}
    </div>
  );
}

function KassaView(props: {
  cats: Category[];
  productsByCat: Record<string, Product[]>;
  cart: CartLine[];
  total: number;
  addToCart: (p: Product) => void;
  inc: (id: string) => void;
  dec: (id: string) => void;
  resetCart: () => void;
  onPay: (payment: "CASH" | "CARD") => void;
  lastReceipt: { receipt: Receipt; items: ReceiptItem[] } | null;
  showLastReceipt: () => void;
}) {
  return (
    <div className="main kassa">
      <div className="panel">
        <div className="panel-header">
          <h2>Artikel</h2>
          <span className="small">
            {Object.values(props.productsByCat).reduce((a, arr) => a + (arr?.length ?? 0), 0)} aktiv
          </span>
        </div>

        <div className="panel-body">
          {props.cats.map((c) => {
            const list = props.productsByCat[c.id] ?? [];
            if (list.length === 0) return null;

            return (
              <div key={c.id} style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 900, marginBottom: 10, fontSize: 18 }}>{c.name}</div>
                <div className="grid">
                  {list.map((p) => (
                    <button type="button" key={p.id} className="tile" onClick={() => props.addToCart(p)}>
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
        <div className="panel-header">
          <h2>Warenkorb</h2>
          <span className="small">{props.cart.reduce((a, l) => a + l.qty, 0)} Stk</span>
        </div>

        <div className="cart-list" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {props.cart.length === 0 ? <div className="small">Noch leer — klick links auf Produkte.</div> : null}

          {props.cart.map((l) => (
            <div className="cart-row" key={l.product.id}>
              <div>
                <div className="title">{l.product.name}</div>
                <div className="meta">
                  {l.qty} × {formatEuro(l.product.price_cents)} • Pos: {formatEuro(l.qty * l.product.price_cents)}
                </div>
              </div>

              <div className="qty qty-h">
                <button type="button" onClick={() => props.dec(l.product.id)}>
                  -
                </button>
                <div className="val">{l.qty}</div>
                <button type="button" onClick={() => props.inc(l.product.id)}>
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="footer" style={{ marginTop: "auto" }}>
          <div className="total">
            <span>Gesamt</span>
            <span>{formatEuro(props.total)}</span>
          </div>

          <div className="pay">
            <button type="button" className="cash" disabled={props.total <= 0} onClick={() => props.onPay("CASH")}>
              BAR
            </button>
            <button type="button" className="card" disabled={props.total <= 0} onClick={() => props.onPay("CARD")}>
              KARTE
            </button>
          </div>

          <button
            type="button"
            style={{
              padding: "12px 0",
              borderRadius: "14px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted)",
            }}
            onClick={props.resetCart}
          >
            Reset Warenkorb
          </button>

          {props.lastReceipt ? (
            <button
              type="button"
              style={{
                padding: "12px 0",
                borderRadius: "14px",
                border: "1px solid rgba(59,130,246,.45)",
                background: "rgba(59,130,246,.12)",
                color: "var(--text)",
                fontWeight: 900,
              }}
              onClick={props.showLastReceipt}
            >
              Letzten Beleg anzeigen ({props.lastReceipt.receipt.receipt_code})
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EventSetup(props: {
  cats: Category[];
  groups: PickupGroup[];
  onReload: () => Promise<void>;
  onPolicyChange: (p: BonPolicy) => void;
}) {
  const [eventName, setEventName] = useState("");
  const [policy, setPolicy] = useState<BonPolicy>("NEVER");
  const [autoPrint, setAutoPrint] = useState(false);

  const [prodName, setProdName] = useState("");
  const [prodPrice, setProdPrice] = useState("2,50");
  const [cat, setCat] = useState("");
  const [groupId, setGroupId] = useState("grp_buffet");

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templates, setTemplates] = useState<EventTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  async function reloadProducts() {
    setAllProducts(await listAllProducts());
  }

  async function reloadTemplates() {
    const rows = await listEventTemplates();
    setTemplates(rows);
    if (!selectedTemplateId && rows[0]?.id) setSelectedTemplateId(rows[0].id);
  }

  useEffect(() => {
    (async () => {
      setEventName(await readSetting("event_name"));
      setPolicy((await readSetting("bon_policy")) as BonPolicy);
      setAutoPrint((await readSetting("auto_print")) === "true");
      await reloadProducts();
      await reloadTemplates();
    })().catch(console.error);
  }, []);

  useEffect(() => {
    if (!cat && props.cats[0]?.id) setCat(props.cats[0].id);
  }, [props.cats, cat]);

  useEffect(() => {
    if (!groupId && props.groups[0]?.id) setGroupId(props.groups[0].id);
  }, [props.groups, groupId]);

  async function saveEventBase() {
    if (!eventName.trim()) return appAlert("Veranstaltungsname fehlt.");

    await writeSetting("event_name", eventName.trim());
    await writeSetting("bon_policy", policy);
    await writeSetting("auto_print", autoPrint ? "true" : "false");

    props.onPolicyChange(policy);
    await props.onReload();

    appAlert("Veranstaltung aktiviert.");
  }

  async function addPickupGroup() {
    const name = window.prompt("Name der neuen Abholstation:", "Neue Station");
    if (name === null) return;

    await createPickupGroup(name);
    await props.onReload();
  }

  async function saveGroupName(id: string, name: string) {
    await updatePickupGroupName(id, name);
    await props.onReload();
  }

  async function saveProduct() {
    const cents = parsePriceToCents(prodPrice);
    if (!prodName.trim()) return appAlert("Name fehlt.");
    if (Number.isNaN(cents) || cents <= 0) return appAlert("Preis ungültig.");
    if (!cat) return appAlert("Kategorie wählen.");

    await upsertProduct({
      name: prodName.trim(),
      price_cents: cents,
      category_id: cat,
      group_id: groupId,
      active: 1,
    });

    setProdName("");
    setProdPrice("2,50");

    await reloadProducts();
    await props.onReload();
    appAlert("Produkt allgemein angelegt. Mit Häkchen aktivierst du es für die Veranstaltung.");
  }

  async function saveTemplate() {
    const name = templateName.trim();
    if (!name) return appAlert("Bitte Vorlagennamen eingeben.");

    await saveEventBase();
    await saveCurrentAsEventTemplate(name);
    setTemplateName("");
    await reloadTemplates();

    appAlert("Vorlage gespeichert.");
  }

  async function overwriteTemplate() {
    if (!selectedTemplateId) return appAlert("Bitte Vorlage auswählen.");
    if (!(await appConfirm("Diese Vorlage wirklich mit dem aktuellen Stand überschreiben?"))) return;

    await saveEventBase();
    await overwriteEventTemplate(selectedTemplateId);
    await reloadTemplates();

    appAlert("Vorlage überschrieben.");
  }

  const byCat = props.cats.map((c) => ({
    cat: c,
    products: allProducts.filter((p) => p.category_id === c.id),
  }));

  return (
    <div className="main settings">
      <div className="panel">
        <div className="panel-header">
          <h2>Veranstaltung erstellen</h2>
          <span className="small">Event / Bon / aktive Produkte</span>
        </div>

        <div className="panel-body">
          <div style={{ display: "grid", gap: 12, maxWidth: 900 }}>
            <label className="small">Veranstaltungsname (Bon-Kopf)</label>
            <input value={eventName} onChange={(e) => setEventName(e.target.value)} style={inp} />

            <label className="small">Bon Druck / Bon Policy</label>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as BonPolicy)} style={sel}>
              <option value="ALWAYS">Immer</option>
              <option value="NEVER">Nie</option>
              <option value="OPTIONAL">Optional</option>
            </select>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
              <input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} />
              <div>
                <div style={{ fontWeight: 900 }}>Auto-Druck</div>
                <div className="small">Wenn ein Bon erforderlich ist, druckt er sofort automatisch.</div>
              </div>
            </div>

          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Abholstationen</h2>
          <span className="small">für Split-Bons</span>
        </div>

        <div className="panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {props.groups.map((g) => (
              <div key={g.id}>
                <div className="small" style={{ marginBottom: 6 }}>
                  {g.id}
                </div>
                <input defaultValue={g.name} onBlur={(e) => saveGroupName(g.id, e.target.value)} style={inp} />
              </div>
            ))}
          </div>

          <button type="button" onClick={addPickupGroup} style={{ ...btn, maxWidth: 320, marginTop: 12 }}>
            + Abholstation erstellen
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Produkt allgemein erstellen</h2>
          <span className="small">Produktvorlage anlegen</span>
        </div>

        <div className="panel-body">
          <div style={{ display: "grid", gap: 10, maxWidth: 680 }}>
            <label className="small">Name</label>
            <input value={prodName} onChange={(e) => setProdName(e.target.value)} placeholder="z.B. Bier 0,5 L" style={inp} />

            <label className="small">Preis</label>
            <input value={prodPrice} onChange={(e) => setProdPrice(e.target.value)} placeholder="4,50" style={inp} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="small">Kategorie</label>
                <select value={cat} onChange={(e) => setCat(e.target.value)} style={sel}>
                  {props.cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="small">Abholstation</label>
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={sel}>
                  {props.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={saveProduct}
              style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
            >
              Produkt erstellen
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Produkte verwalten</h2>
          <span className="small">{allProducts.length} Produkte</span>
        </div>

        <div className="panel-body">
          <div className="notice" style={{ marginBottom: 12 }}>
            Häkchen = Produkt erscheint heute in der Kassa. Preis, Kategorie und Abholstation kannst du jederzeit ändern.
          </div>

          <div style={{ display: "grid", gap: 16 }}>
            {byCat.map(({ cat, products }) => (
              <div key={cat.id}>
                <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>{cat.name}</div>

                {products.length === 0 ? (
                  <div className="small">Keine Produkte in dieser Kategorie.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {products.map((p) => (
                      <ProductManageRow
                        key={p.id}
                        product={p}
                        cats={props.cats}
                        groups={props.groups}
                        onSaved={async () => {
                          await reloadProducts();
                          await props.onReload();
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Vorlage speichern</h2>
          <span className="small">{templates.length} gespeichert</span>
        </div>

        <div className="panel-body">
          <div style={{ display: "grid", gap: 12, maxWidth: 860 }}>
            <div className="notice">
              Eine Vorlage speichert: Veranstaltungsname, Bon-Policy, Auto-Druck und alle Produkte mit Häkchen.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="z.B. Hallenturnier, Festbetrieb, kleiner Spieltag"
                style={inp}
              />
              <button
                type="button"
                onClick={saveTemplate}
                style={{ ...btn, paddingLeft: 18, paddingRight: 18, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
              >
                Als Vorlage speichern
              </button>
            </div>

            {templates.length > 0 ? (
              <>
                <label className="small">Bestehende Vorlage überschreiben</label>
                <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)} style={sel}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={overwriteTemplate}
                  style={{ ...btn, maxWidth: 320, background: "rgba(59,130,246,.12)", borderColor: "rgba(59,130,246,.45)" }}
                >
                  Ausgewählte Vorlage überschreiben
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Settings(props: {
  onReload: () => Promise<void>;
  onPolicyChange: (p: BonPolicy) => void;
  onPinChange: (p: string) => void;
}) {
  const [regName, setRegName] = useState("K1 Allgemein");
  const [regPrefix, setRegPrefix] = useState("K1");
  const [printerName, setPrinterName] = useState("POS-80C");
  const [lockPin, setLockPin] = useState("1234");

  const [templates, setTemplates] = useState<EventTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState<EventSummary | null>(null);
  const s = summary;

  async function reloadTemplates() {
    const rows = await listEventTemplates();
    setTemplates(rows);
    if (!selectedTemplateId && rows[0]?.id) setSelectedTemplateId(rows[0].id);
    if (selectedTemplateId && !rows.some((x) => x.id === selectedTemplateId)) {
      setSelectedTemplateId(rows[0]?.id ?? "");
    }
  }

  async function reloadProducts() {
    setAllProducts(await listAllProducts());
  }

  useEffect(() => {
    (async () => {
      const r = await getRegister();
      setRegName(r.name);
      setRegPrefix(r.prefix);
      setPrinterName(await readSetting("printer_name"));
      setLockPin(await readSetting("lock_pin"));
      await reloadTemplates();
      await reloadProducts();
    })().catch(console.error);
  }, []);

  async function saveRegister() {
    if (!regName.trim()) return appAlert("Kassa-Name fehlt.");
    if (!regPrefix.trim()) return appAlert("Prefix fehlt.");

    await updateRegisterNamePrefix(regName.trim(), regPrefix.trim().toUpperCase());
    appAlert("Kassa gespeichert.");
  }

  async function savePrinter() {
    if (!printerName.trim()) return appAlert("Druckername fehlt.");
    await writeSetting("printer_name", printerName.trim());
    await props.onReload();
    appAlert("Drucker gespeichert.");
  }

  async function savePin() {
    const p = lockPin.trim();
    if (!/^\d{4,6}$/.test(p)) return appAlert("PIN bitte 4–6 Ziffern.");
    await writeSetting("lock_pin", p);
    props.onPinChange(p);
    appAlert("PIN gespeichert.");
  }

  async function applyTemplateFromSettings() {
    if (!selectedTemplateId) return appAlert("Bitte Vorlage auswählen.");

    const t = templates.find((x) => x.id === selectedTemplateId);
    if (!(await appConfirm(`Vorlage "${t?.name ?? "ausgewählt"}" laden? Aktive Produkte und Eventdaten werden überschrieben.`))) return;

    await applyEventTemplate(selectedTemplateId);
    const freshPolicy = (await readSetting("bon_policy")) as BonPolicy;
    props.onPolicyChange(freshPolicy);

    await props.onReload();
    await reloadProducts();

    appAlert("Vorlage geladen.");
  }

  async function removeTemplate() {
    if (!selectedTemplateId) return appAlert("Bitte Vorlage auswählen.");

    const t = templates.find((x) => x.id === selectedTemplateId);
    if (!(await appConfirm(`Vorlage "${t?.name ?? "ausgewählt"}" wirklich löschen?`))) return;

    await deleteEventTemplate(selectedTemplateId);
    setSelectedTemplateId("");
    await reloadTemplates();

    appAlert("Vorlage gelöscht.");
  }

  async function runFestabschluss() {
    try {
      setSummary(await getEventSummary());
      setShowSummary(true);
    } catch (e: any) {
      appAlert("Festabschluss fehlgeschlagen: " + String(e?.message ?? e));
    }
  }

  async function resetAllData() {
    if (
      !(await appConfirm(
        "Wirklich ALLE Daten löschen und Einstellungen zurücksetzen?\n\n" +
          "- Produkte\n" +
          "- Vorlagen\n" +
          "- Belege\n" +
          "- Druck-Queue\n" +
          "- Einstellungen\n\n" +
          "Dieser Vorgang kann nicht rückgängig gemacht werden."
      ))
    )
      return;

    if (!(await appConfirm("Letzte Sicherheitsfrage: Wirklich alles löschen?"))) return;

    try {
      const db = await getDb();

      await db.execute("DELETE FROM event_template_products");
      await db.execute("DELETE FROM event_templates");
      await db.execute("DELETE FROM receipt_items");
      await db.execute("DELETE FROM print_jobs");
      await db.execute("DELETE FROM receipts");
      await db.execute("DELETE FROM products");
      await db.execute("DELETE FROM app_settings");

      appAlert("Alles gelöscht. App startet neu.");
      window.location.reload();
    } catch (e: any) {
      appAlert("Fehler beim Löschen: " + String(e?.message ?? e));
    }
  }

  return (
    <>
      <div className="main settings">
        <div className="panel">
          <div className="panel-header">
            <h2>Einstellungen</h2>
            <span className="small">Grundwerte</span>
          </div>

          <div className="panel-body">
            <div style={{ display: "grid", gap: 12, maxWidth: 760 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label className="small">Kassa-Name</label>
                  <input value={regName} onChange={(e) => setRegName(e.target.value)} style={inp} />
                </div>

                <div>
                  <label className="small">Prefix</label>
                  <input value={regPrefix} onChange={(e) => setRegPrefix(e.target.value)} style={inp} />
                </div>
              </div>

              <button type="button" onClick={saveRegister} style={{ ...btn, maxWidth: 280 }}>
                Kassa speichern
              </button>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }} />

              <label className="small">Druckername (Windows) – z.B.: POS-80C</label>
              <input value={printerName} onChange={(e) => setPrinterName(e.target.value)} style={inp} />

              <button type="button" onClick={savePrinter} style={{ ...btn, maxWidth: 280 }}>
                Drucker speichern
              </button>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }} />

              <label className="small">PIN für Kassa sperren (4–6 Ziffern)</label>
              <input value={lockPin} onChange={(e) => setLockPin(e.target.value)} style={inp} />

              <button type="button" onClick={savePin} style={{ ...btn, maxWidth: 280 }}>
                PIN speichern
              </button>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Veranstaltungsvorlage laden</h2>
            <span className="small">{templates.length} gespeichert</span>
          </div>

          <div className="panel-body">
            {templates.length === 0 ? (
              <div className="small">Noch keine Vorlagen gespeichert.</div>
            ) : (
              <div style={{ display: "grid", gap: 12, maxWidth: 760 }}>
                <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)} style={sel}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <button
                    type="button"
                    onClick={applyTemplateFromSettings}
                    style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
                  >
                    Vorlage aktivieren
                  </button>

                  <button
                    type="button"
                    onClick={removeTemplate}
                    style={{ ...btn, background: "rgba(239,68,68,.12)", borderColor: "rgba(239,68,68,.45)" }}
                  >
                    Vorlage löschen
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Produkte der aktiven Veranstaltung</h2>
            <span className="small">{allProducts.filter((p) => p.active === 1).length} aktiv</span>
          </div>

          <div className="panel-body">
            <div style={{ display: "grid", gap: 8 }}>
              {allProducts.filter((p) => p.active === 1).length === 0 ? <div className="small">Keine aktiven Produkte.</div> : null}

              {allProducts
                .filter((p) => p.active === 1)
                .map((p) => (
                  <ProductCheckRow
                    key={p.id}
                    product={p}
                    onChange={async () => {
                      await reloadProducts();
                      await props.onReload();
                    }}
                  />
                ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Abschluss / Reset</h2>
            <span className="small">vorsichtig verwenden</span>
          </div>

          <div className="panel-body">
            <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
              <button
                type="button"
                onClick={runFestabschluss}
                style={{ ...btn, background: "rgba(59,130,246,.12)", borderColor: "rgba(59,130,246,.45)" }}
              >
                Veranstaltung Ende (Festabschluss)
              </button>

              <button
                type="button"
                onClick={resetAllData}
                style={{ ...btn, background: "rgba(239,68,68,.14)", borderColor: "rgba(239,68,68,.55)" }}
              >
                Alle Daten löschen (Reset)
              </button>
            </div>
          </div>
        </div>
      </div>

      {showSummary && s ? <SummaryModal summary={s} onClose={() => setShowSummary(false)} /> : null}
    </>
  );
}

function ProductManageRow(props: {
  product: Product;
  cats: Category[];
  groups: PickupGroup[];
  onSaved: () => Promise<void>;
}) {
  const p = props.product;

  const [active, setActive] = useState(p.today_active === 1);
  const [name, setName] = useState(p.name);
  const [price, setPrice] = useState((p.price_cents / 100).toFixed(2).replace(".", ","));
  const [categoryId, setCategoryId] = useState(p.category_id);
  const [groupId, setGroupId] = useState(p.group_id ?? props.groups[0]?.id ?? "grp_buffet");
  const [saving, setSaving] = useState(false);

  async function toggleActive() {
    setSaving(true);
    try {
      await updateProductTodayActive(p.id, !active);
      setActive(!active);
      await props.onSaved();
    } catch (e: any) {
      appAlert("Aktiv-Status konnte nicht geändert werden: " + String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const cents = parsePriceToCents(price);
    if (!name.trim()) return appAlert("Produktname fehlt.");
    if (Number.isNaN(cents) || cents <= 0) return appAlert("Preis ungültig.");

    setSaving(true);
    try {
      await upsertProduct({
  id: p.id,
  name: name.trim(),
  price_cents: cents,
  category_id: categoryId,
  group_id: groupId,
  active: 1,
  sort_index: p.sort_index,
});

      await props.onSaved();
      appAlert("Produkt gespeichert.");
    } catch (e: any) {
      appAlert("Speichern fehlgeschlagen: " + String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!(await appConfirm(`Produkt "${p.name}" wirklich dauerhaft löschen?`))) return;

    setSaving(true);
    try {
      await deleteProduct(p.id);
      await props.onSaved();
    } catch (e: any) {
      appAlert("Löschen fehlgeschlagen: " + String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 12,
        background: active ? "rgba(34,197,94,.08)" : "rgba(255,255,255,.02)",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1.4fr .7fr 1fr 1fr", gap: 10, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 6, justifyItems: "center" }}>
          <span className="small">Heute</span>
          <input type="checkbox" checked={active} disabled={saving} onChange={toggleActive} />
        </label>

        <div>
          <label className="small">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inp} />
        </div>

        <div>
          <label className="small">Preis</label>
          <input value={price} onChange={(e) => setPrice(e.target.value)} style={inp} />
        </div>

        <div>
          <label className="small">Kategorie</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={sel}>
            {props.cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="small">Abholstation</label>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={sel}>
            {props.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
        <button
          type="button"
          disabled={saving}
          style={{ ...btn, background: "rgba(59,130,246,.12)", borderColor: "rgba(59,130,246,.45)" }}
          onClick={save}
        >
          Speichern
        </button>

        <button
          type="button"
          disabled={saving}
          style={{ ...btn, background: "rgba(239,68,68,.12)", borderColor: "rgba(239,68,68,.45)" }}
          onClick={remove}
        >
          Produkt dauerhaft löschen
        </button>
      </div>
    </div>
  );
}

function ProductCheckRow(props: { product: Product; onChange: () => Promise<void> }) {
  const [active, setActive] = useState(props.product.active === 1);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await setProductActive(props.product.id, !active);
      setActive(!active);
      await props.onChange();
    } catch (e: any) {
      appAlert("Änderung fehlgeschlagen: " + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 12,
        alignItems: "center",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 12,
        background: active ? "rgba(34,197,94,.08)" : "rgba(255,255,255,.02)",
      }}
    >
      <input type="checkbox" checked={active} disabled={busy} onChange={toggle} />
      <div>
        <div style={{ fontWeight: 900 }}>{props.product.name}</div>
        <div className="small">{active ? "Aktiv in der Kassa" : "Nicht aktiv"}</div>
      </div>
      <div style={{ fontWeight: 900 }}>{formatEuro(props.product.price_cents)}</div>
    </label>
  );
}

function ReceiptModal(props: { data: { receipt: Receipt; items: ReceiptItem[] }; onClose: () => void }) {
  const r = props.data.receipt;

  return (
    <Modal title={`BELEG • ${r.receipt_code}`}>
      <div className="small">
        Zahlart: <b>{r.payment_type === "CASH" ? "BAR" : "KARTE"}</b> • Status: <b>BEZAHLT</b>
      </div>

      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 14, padding: 12, background: "rgba(255,255,255,.02)" }}>
        {props.data.items.map((it) => (
          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px dashed rgba(255,255,255,.06)" }}>
            <div style={{ fontWeight: 800 }}>
              {it.qty}× {it.product_name}
            </div>
            <div style={{ color: "var(--muted)" }}>
              {formatEuro(it.unit_price_cents)} → {formatEuro(it.line_total_cents)}
            </div>
          </div>
        ))}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontWeight: 900 }}>
          <div>Gesamt</div>
          <div>{formatEuro(r.total_cents)}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button type="button" style={{ ...btn, flex: 1 }} onClick={props.onClose}>
          Schließen
        </button>
      </div>
    </Modal>
  );
}

function PrintQueue(props: { printerName: string }) {
  const [jobs, setJobs] = useState<PrintJob[]>([]);

  async function refresh() {
    setJobs(await listOpenPrintJobs());
  }

  useEffect(() => {
    refresh().catch(console.error);
  }, []);

  async function doPrint(j: PrintJob) {
    try {
      await printRawWindows(props.printerName, j.payload_text);
      await markPrintJobPrinted(j.id);
      await refresh();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await markPrintJobFailed(j.id, msg);
      await refresh();
      appAlert("Druck fehlgeschlagen.\n\n" + msg);
      appAlert(j.payload_text);
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
          <div className="small">
            Aktueller Drucker: <b>{props.printerName}</b>
          </div>

          {jobs.length === 0 ? <div className="small" style={{ marginTop: 10 }}>Keine offenen Jobs.</div> : null}

          {jobs.map((j) => (
            <div key={j.id} style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12, marginTop: 10, background: "rgba(255,255,255,.02)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>
                  {j.group_name} • {j.receipt_code}
                </div>
                <div className="small">
                  Status: <b>{j.status}</b>
                </div>
              </div>

              <div className="small" style={{ marginTop: 6 }}>
                Summe: <b>{formatEuro(j.total_cents)}</b>
              </div>

              {j.last_error ? (
                <div className="small" style={{ marginTop: 6, color: "#fecaca" }}>
                  Fehler: {j.last_error}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button type="button" style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)", flex: 1 }} onClick={() => doPrint(j)}>
                  Drucken
                </button>

                <button type="button" style={{ ...btn, flex: 1 }} onClick={() => appAlert(j.payload_text)}>
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

function SummaryModal(props: { summary: EventSummary; onClose: () => void }) {
  const s = props.summary;

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
    const esc = (v: any) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    return [headers.map(esc).join(";"), ...rows.map((r) => headers.map((h) => esc(r[h])).join(";"))].join("\n");
  }

  return (
    <Modal title="Festabschluss">
      <div className="small">
        Event: <b>{s.event_name}</b>
        <br />
        Bestellungen: <b>{s.receipts_count}</b>
        <br />
        Umsatz: <b>{formatEuro(s.total_cents)}</b>
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Zahlarten</div>
          {s.by_payment.length === 0 ? (
            <div className="small">Keine Daten.</div>
          ) : (
            s.by_payment.map((p) => (
              <div key={p.payment_type} style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  {p.payment_type === "CASH" ? "BAR" : "KARTE"} ({p.receipts})
                </div>
                <div style={{ fontWeight: 900 }}>{formatEuro(p.total_cents)}</div>
              </div>
            ))
          )}
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Produkte</div>
          {s.by_product.slice(0, 20).map((p) => (
            <div key={p.product_id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div>
                {p.qty}× {p.product_name}
              </div>
              <div style={{ fontWeight: 900 }}>{formatEuro(p.total_cents)}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            type="button"
            style={{ ...btn, background: "rgba(34,197,94,.18)", borderColor: "rgba(34,197,94,.45)" }}
            onClick={() => {
              const rows = s.by_product.map((p) => ({
                product_name: p.product_name,
                qty: p.qty,
                total_eur: (p.total_cents / 100).toFixed(2).replace(".", ","),
              }));
              downloadTextFile(`festabschluss_produkte_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, ["product_name", "qty", "total_eur"]));
            }}
          >
            CSV: Produkte
          </button>

          <button type="button" style={{ ...btn }} onClick={props.onClose}>
            Schließen
          </button>
        </div>
      </div>
    </Modal>
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
        <div className="small" style={{ marginTop: 6 }}>
          PIN eingeben zum Entsperren.
        </div>

        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} inputMode="numeric" placeholder="PIN" style={{ ...inp, marginTop: 12, fontSize: 20, textAlign: "center", letterSpacing: 6 }} />

        {err ? <div style={{ marginTop: 8, color: "#fecaca", fontWeight: 800 }}>{err}</div> : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          <button type="button" style={{ ...btn }} onClick={submit}>
            Entsperren
          </button>
          <button
            type="button"
            style={{ ...btn, borderColor: "rgba(239,68,68,.55)" }}
            onClick={() => {
              setVal("");
              setErr(null);
            }}
          >
            Eingabe löschen
          </button>
        </div>
      </div>
    </div>
  );
}

function AppDialog(props: {
  type: "alert" | "confirm";
  message: string;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.55)",
        display: "grid",
        placeItems: "center",
        zIndex: 10000,
      }}
    >
      <div
        style={{
          width: "min(520px, 92vw)",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          padding: 18,
          boxShadow: "var(--shadow)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 12 }}>
          Hinweis
        </div>

        <div style={{ fontSize: 16, lineHeight: 1.4 }}>
          {props.message}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: props.type === "confirm" ? "1fr 1fr" : "1fr",
            gap: 10,
            marginTop: 18,
          }}
        >
          {props.type === "confirm" ? (
            <button type="button" style={{ ...btn }} onClick={props.onCancel}>
              Abbrechen
            </button>
          ) : null}

          <button
            type="button"
            autoFocus
            style={{
              ...btn,
              background: "rgba(34,197,94,.18)",
              borderColor: "rgba(34,197,94,.45)",
            }}
            onClick={props.onOk}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function Modal(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.60)", display: "grid", placeItems: "center", zIndex: 9998 }}>
      <div className="panel" style={{ width: "min(860px, 94vw)", maxHeight: "90vh", overflow: "auto" }}>
        <div className="panel-header">
          <h2>{props.title}</h2>
        </div>
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

const sel: React.CSSProperties = {
  padding: "14px 14px",
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "#ffffff",
  color: "#000000",
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

function parsePriceToCentsSafe(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const n = parsePriceToCents(s);
  if (!Number.isFinite(n) || Number.isNaN(n)) return null;
  return n;
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function generateCashSuggestions(totalCents: number): number[] {
  const suggestions: number[] = [];

  suggestions.push(totalCents);

  const euro = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  if (cents > 0 && cents < 50) {
    suggestions.push(euro * 100 + 50);
  }

  const nextEuro = roundUpTo(totalCents, 100);
  suggestions.push(nextEuro);

  if (totalCents >= 1000) {
    suggestions.push(nextEuro + 100);
  }

  suggestions.push(roundUpTo(totalCents, 500));
  suggestions.push(roundUpTo(totalCents, 1000));
  suggestions.push(roundUpTo(totalCents, 2000));
  suggestions.push(roundUpTo(totalCents, 5000));
  suggestions.push(roundUpTo(totalCents, 10000));
  suggestions.push(roundUpTo(totalCents, 20000));
  suggestions.push(roundUpTo(totalCents, 50000));

  return Array.from(new Set(suggestions))
    .filter((v) => v >= totalCents)
    .sort((a, b) => a - b);
}