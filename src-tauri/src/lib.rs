#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_sql::{Builder};


#[tauri::command]
async fn print_raw_windows(printer_name: String, data_base64: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{BOOL, HANDLE};
    use windows::Win32::Graphics::Printing::{
      ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter,
      WritePrinter, DOC_INFO_1W,
    };

    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn to_wide(s: &str) -> Vec<u16> {
      OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let bytes = STANDARD
      .decode(data_base64.as_bytes())
      .map_err(|e| e.to_string())?;

    let mut h: HANDLE = HANDLE(0);
    let pn = to_wide(&printer_name);

    unsafe { OpenPrinterW(PCWSTR(pn.as_ptr()), &mut h, None) }
      .map_err(|e| format!("OpenPrinter failed: {e}"))?;

    if h == HANDLE(0) {
      return Err("OpenPrinter failed (HANDLE=0)".to_string());
    }

    let doc_name = to_wide("Orderman Light V2");
    let data_type = to_wide("RAW");

    let mut doc_info = DOC_INFO_1W {
      pDocName: PWSTR(doc_name.as_ptr() as *mut u16),
      pOutputFile: PWSTR(std::ptr::null_mut()),
      pDatatype: PWSTR(data_type.as_ptr() as *mut u16),
    };

    let job_id = unsafe { StartDocPrinterW(h, 1, &mut doc_info as *mut _ as *const _) };
    if job_id == 0 {
      unsafe { let _ = ClosePrinter(h); }
      return Err("StartDocPrinter failed".to_string());
    }

    let sp: BOOL = unsafe { StartPagePrinter(h) };
    if !sp.as_bool() {
      unsafe { EndDocPrinter(h); let _ = ClosePrinter(h); }
      return Err("StartPagePrinter failed".to_string());
    }

    let mut written: u32 = 0;
    let wp: BOOL = unsafe { WritePrinter(h, bytes.as_ptr() as *const _, bytes.len() as u32, &mut written) };
    if !wp.as_bool() {
      unsafe { EndPagePrinter(h); EndDocPrinter(h); let _ = ClosePrinter(h); }
      return Err("WritePrinter failed".to_string());
    }

    unsafe {
      EndPagePrinter(h);
      EndDocPrinter(h);
      let _ = ClosePrinter(h);
    }

    Ok(())
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = (printer_name, data_base64);
    Err("print_raw_windows is only supported on Windows".to_string())
  }
}


pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![print_raw_windows])
    .plugin(Builder::default().build())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
