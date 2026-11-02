// export.js — turns highlights into text for Apple Notes, and makes backups.

export function locationLabel(hl) {
  if (hl.kind === 'pdf') return `Page ${hl.page + 1}`;
  return hl.chapterTitle || `Chapter ${hl.chapter + 1}`;
}

export function sortHighlights(list) {
  return [...list].sort((a, b) => {
    if (a.kind === 'pdf' && b.kind === 'pdf') {
      return a.page - b.page || (a.rects?.[0]?.y ?? a.y ?? 0) - (b.rects?.[0]?.y ?? b.y ?? 0) || (a.rects?.[0]?.x ?? 0) - (b.rects?.[0]?.x ?? 0);
    }
    return (a.chapter ?? 0) - (b.chapter ?? 0) || (a.start ?? 0) - (b.start ?? 0);
  });
}

/** The first line (book title) becomes the note's title in Apple Notes. */
export function exportText(book, highlights, { pictures = false } = {}) {
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [book.title];
  if (book.author) lines.push(`by ${book.author}`);
  lines.push(`Highlights & notes · exported ${date}`);
  let n = 0;
  for (const hl of sortHighlights(highlights)) {
    if (hl.ink && pictures) {
      // The drawing travels as a picture, attached at the end of the note
      n++;
      lines.push('', '———', locationLabel(hl), `✎ Handwritten note ${n} — picture ${n} at the end`);
      if (hl.text) lines.push(`Next to: “${hl.text}”`);
    } else if (hl.ink) {
      lines.push('', '———', locationLabel(hl), hl.text ? `✎ Handwritten note next to: “${hl.text}”` : '✎ Handwritten note');
    } else {
      lines.push('', '———', locationLabel(hl), `“${hl.text}”`);
    }
    const note = (hl.note || '').trim();
    if (note) lines.push(`Note: ${note}`);
  }
  return lines.join('\n');
}

/**
 * One picture per handwritten note, numbered like the text.
 * For PDFs pass the open document (pdf) or the book's file (blob).
 */
export async function inkPictures(book, highlights, { pdf = null, blob = null } = {}) {
  const inks = sortHighlights(highlights).filter((x) => x.ink && x.strokes?.length);
  if (!inks.length) return [];
  const { inkCard } = await import('./ink.js');
  let doc = pdf;
  let opened = null;
  if (book.format === 'pdf' && !doc && blob) {
    const { loadPDF } = await import('./pdfreader.js');
    doc = opened = await loadPDF(blob).catch(() => null);
  }
  const crop = doc ? (await import('./pdfreader.js')).inkPageCrop : null;
  const safe = (book.title || 'Margins').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim();
  const files = [];
  try {
    let n = 0;
    for (const g of inks) {
      n++;
      const picture = crop && g.kind === 'pdf' ? await crop(doc, g).catch(() => null) : null;
      const png = await inkCard(g, { number: n, location: locationLabel(g), bookTitle: book.title, picture });
      files.push(new File([png], `${safe} – handwritten note ${n}.png`, { type: 'image/png' }));
    }
  } finally {
    opened?.destroy();
  }
  return files;
}

/** Pictures to the share sheet. */
export async function shareFiles(title, files) {
  if (!navigator.canShare?.({ files })) return 'unsupported';
  try {
    await navigator.share({ files });
    return 'shared';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Opens the share sheet (choose "Notes"). Falls back to copying. */
export async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      // Safari opens the share sheet only right after a tap
      if (e?.name === 'NotAllowedError') return 'needs-tap';
    }
  }
  await copyText(text);
  return 'copied';
}

/** Saves a file via the share sheet ("Save to Files") or a download. */
export async function saveFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  return 'downloaded';
}

export function makeBackupFile(books, highlights) {
  const data = {
    app: 'margins',
    version: 1,
    exportedAt: new Date().toISOString(),
    books: books.map((b) => ({ id: b.id, title: b.title, author: b.author, format: b.format, size: b.size })),
    highlights,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return new File([JSON.stringify(data, null, 2)], `margins-backup-${stamp}.json`, { type: 'application/json' });
}
