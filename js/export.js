// export.js — turns highlights into text for Apple Notes, and makes backups.

export function locationLabel(hl) {
  if (hl.kind === 'pdf') return `Page ${hl.page + 1}`;
  return hl.chapterTitle || `Chapter ${hl.chapter + 1}`;
}

export function sortHighlights(list) {
  return [...list].sort((a, b) => {
    if (a.kind === 'pdf' && b.kind === 'pdf') {
      return a.page - b.page || (a.rects?.[0]?.y ?? 0) - (b.rects?.[0]?.y ?? 0) || (a.rects?.[0]?.x ?? 0) - (b.rects?.[0]?.x ?? 0);
    }
    return (a.chapter ?? 0) - (b.chapter ?? 0) || (a.start ?? 0) - (b.start ?? 0);
  });
}

/** The first line (book title) becomes the note's title in Apple Notes. */
export function exportText(book, highlights) {
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [book.title];
  if (book.author) lines.push(`by ${book.author}`);
  lines.push(`Highlights & notes · exported ${date}`);
  for (const hl of sortHighlights(highlights)) {
    lines.push('', '———', locationLabel(hl), `“${hl.text}”`);
    const note = (hl.note || '').trim();
    if (note) lines.push(`Note: ${note}`);
  }
  return lines.join('\n');
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
