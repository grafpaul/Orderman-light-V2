import { invoke } from "@tauri-apps/api/core";

export function escposTextToBytes(text: string): Uint8Array {
  // Basic ESC/POS: initialize + text + line feeds + cut
  const encoder = new TextEncoder();
  const init = new Uint8Array([0x1b, 0x40]); // ESC @
  const body = encoder.encode(text.replace(/\n/g, "\n"));
  const lf = new Uint8Array([0x0a, 0x0a, 0x0a]);
  const cut = new Uint8Array([0x1d, 0x56, 0x41, 0x10]); // GS V A n
  const out = new Uint8Array(init.length + body.length + lf.length + cut.length);
  out.set(init, 0);
  out.set(body, init.length);
  out.set(lf, init.length + body.length);
  out.set(cut, init.length + body.length + lf.length);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Browser-safe base64
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function printRawWindows(printerName: string, text: string): Promise<void> {
  const bytes = escposTextToBytes(text);
  const b64 = bytesToBase64(bytes);
  await invoke("print_raw_windows", { printerName, dataBase64: b64 } as any);
}
