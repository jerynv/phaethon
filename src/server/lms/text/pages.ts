// STUB: owned by lms (text): page_pictures for read_page
/** Renders one page of a PDF as a picture; null when the page couldn't be rendered. Throws when the renderer crashed. */
export async function renderPdfPage(_file: string, _page: number): Promise<{ mime: string; data: string } | null> {
  throw new Error("no page renderer is available yet");
}
