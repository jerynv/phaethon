//! Text recognition on Windows 10 and later with what Windows itself has:
//! `Windows.Data.Pdf` draws the page and `Windows.Media.Ocr` reads it, on the
//! device, in the languages of the person's Windows profile. Runs inside the
//! recogniser child (ocr.rs), like Vision on macOS.

use std::path::Path;

use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode, ExifOrientationMode, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{IRandomAccessStream, InMemoryRandomAccessStream};
use windows::Storage::{FileAccessMode, StorageFile};
use windows::core::{HSTRING, Interface};

/// Pages are drawn at about 300 dpi (Windows measures pages at 96).
const SCALE: f64 = 300.0 / 96.0;

fn words(e: windows::core::Error) -> String {
    let m = e.message().to_string();
    if m.trim().is_empty() { format!("Windows said {}", e.code()) } else { m.trim().trim_end_matches('.').to_string() }
}

/// WinRT on this thread, once.
fn init() {
    // SAFETY: plain initialisation; a second call on the thread only reports it was done.
    let _ = unsafe { windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED) };
}

/// Recognition works here: Windows has a recogniser for one of the profile's languages.
pub fn availability() -> Result<(), String> {
    init();
    engine().map(|_| ())
}

fn engine() -> Result<OcrEngine, String> {
    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "Windows has no text recognition for your languages: add one in Settings › Time & language › Language (its “Optical character recognition” feature), then import the course again".to_string())
}

/// The longest side Windows' recogniser takes.
fn max_side() -> u32 {
    OcrEngine::MaxImageDimension().unwrap_or(2600).max(1)
}

fn file(path: &Path) -> Result<StorageFile, String> {
    let full = std::path::absolute(path).map_err(|e| e.to_string())?;
    StorageFile::GetFileFromPathAsync(&HSTRING::from(full.as_os_str())).and_then(|op| op.join()).map_err(words)
}

/// A picture in `stream`, upright, no bigger than the recogniser takes, as BGRA.
fn bitmap(stream: &IRandomAccessStream) -> Result<SoftwareBitmap, String> {
    let decoder = BitmapDecoder::CreateAsync(stream).and_then(|op| op.join()).map_err(words)?;
    let (w, h) = (decoder.OrientedPixelWidth().map_err(words)?, decoder.OrientedPixelHeight().map_err(words)?);
    let transform = BitmapTransform::new().map_err(words)?;
    let longest = w.max(h).max(1);
    let limit = max_side();
    if longest > limit {
        let k = f64::from(limit) / f64::from(longest);
        transform.SetScaledWidth(((f64::from(w) * k) as u32).max(1)).map_err(words)?;
        transform.SetScaledHeight(((f64::from(h) * k) as u32).max(1)).map_err(words)?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant).map_err(words)?;
    }
    decoder
        .GetSoftwareBitmapTransformedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, &transform, ExifOrientationMode::RespectExifOrientation, ColorManagementMode::DoNotColorManage)
        .and_then(|op| op.join())
        .map_err(words)
}

fn recognise(b: &SoftwareBitmap) -> Result<String, String> {
    let result = engine()?.RecognizeAsync(b).and_then(|op| op.join()).map_err(words)?;
    let mut lines = vec![];
    for line in result.Lines().map_err(words)? {
        lines.push(line.Text().map_err(words)?.to_string());
    }
    Ok(lines.join("\n"))
}

pub struct Pdf(PdfDocument);

impl Pdf {
    pub fn open(path: &Path) -> Result<Self, String> {
        init();
        let doc = PdfDocument::LoadFromFileAsync(&file(path)?).and_then(|op| op.join()).map_err(|_| "it couldn’t be opened as a PDF".to_string())?;
        if doc.IsPasswordProtected().unwrap_or(false) {
            return Err("the PDF is password protected".into());
        }
        Ok(Pdf(doc))
    }

    pub fn page_text(&self, n: u32) -> Result<String, String> {
        if n == 0 || n > self.0.PageCount().map_err(words)? {
            return Err("there is no such page".into());
        }
        let page = self.0.GetPage(n - 1).map_err(words)?;
        let size = page.Size().map_err(words)?;
        let (w, h) = (f64::from(size.Width) * SCALE, f64::from(size.Height) * SCALE);
        let k = (f64::from(max_side()) / w.max(h)).min(1.0);
        let options = PdfPageRenderOptions::new().map_err(words)?;
        options.SetDestinationWidth(((w * k) as u32).max(1)).map_err(words)?;
        options.SetDestinationHeight(((h * k) as u32).max(1)).map_err(words)?;
        let stream = InMemoryRandomAccessStream::new().map_err(words)?;
        page.RenderWithOptionsToStreamAsync(&stream, &options).and_then(|op| op.join()).map_err(|_| "the page couldn’t be drawn".to_string())?;
        let stream: IRandomAccessStream = stream.cast().map_err(words)?;
        recognise(&bitmap(&stream)?)
    }
}

/// The text of a picture file (PNG, JPEG, TIFF, BMP, GIF, HEIC where Windows reads it).
pub fn picture_text(path: &Path) -> Result<String, String> {
    init();
    let stream = file(path)?.OpenAsync(FileAccessMode::Read).and_then(|op| op.join()).map_err(|_| "it couldn’t be read as a picture".to_string())?;
    recognise(&bitmap(&stream).map_err(|_| "it couldn’t be read as a picture".to_string())?)
}
